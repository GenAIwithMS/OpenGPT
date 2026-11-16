"""Skills: listing, toggling, create/edit/delete, upload, GitHub import, chat tool."""
import io
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from app.exceptions import ConflictError, ValidationError  # noqa: E402
from app.services import skills  # noqa: E402

GOOD = "---\nname: weekly-report\ndescription: Write the weekly status report.\n---\n\nUse three headings.\n"


def _zip(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def _tar(files: dict, top="skills-abc123") -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo(f"{top}/skills/demo/evil-link")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
        t.addfile(link)
    return buf.getvalue()


class SkillsTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        local = self.root / "claude-skills" / "my-local"
        local.mkdir(parents=True)
        (local / "SKILL.md").write_text("---\nname: my-local\ndescription: A local one.\n---\nBody\n")
        for patch in (mock.patch.object(skills, "PERSONAL_DIR", self.root / "personal"),
                      mock.patch.object(skills, "LOCAL_ROOTS", {"claude": self.root / "claude-skills"})):
            patch.start()
            self.addCleanup(patch.stop)

    def ids(self):
        return {s["id"]: s for s in skills.list_skills()}

    def test_builtin_on_and_local_off_by_default(self):
        found = self.ids()
        self.assertTrue(found["builtin/code-review"]["enabled"])
        self.assertFalse(found["local/claude/my-local"]["enabled"])
        self.assertNotIn("my-local", [s["name"] for s in skills.enabled_skills()])
        skills.set_enabled("local/claude/my-local", True)
        self.assertIn(str(self.root / "claude-skills" / "my-local"), skills.agent_paths())

    def test_create_edit_delete(self):
        skill = skills.create("weekly-report", "Write the weekly status report.", "Use three headings.")
        self.assertEqual((skill["id"], skill["origin"], skill["enabled"]), ("personal/weekly-report", "created", True))
        with self.assertRaises(ConflictError):
            skills.create("weekly-report", "x", "y")
        with self.assertRaises(ConflictError):
            skills.create("code-review", "x", "y")   # built-in name
        with self.assertRaises(ValidationError):
            skills.create("Bad Name", "x", "y")
        skills.update_skill_md("personal/weekly-report", GOOD.replace("three", "four"))
        self.assertIn("four", skills.get_skill("personal/weekly-report")["skill_md"])
        with self.assertRaises(ValidationError):
            skills.update_skill_md("personal/weekly-report", GOOD.replace("weekly-report", "other"))
        with self.assertRaises(ValidationError):
            skills.delete("builtin/code-review")
        skills.delete("personal/weekly-report")
        self.assertNotIn("personal/weekly-report", self.ids())

    def test_upload_md_and_zip(self):
        self.assertEqual(skills.upload("SKILL.md", GOOD.encode())[0]["name"], "weekly-report")
        data = _zip({"a/SKILL.md": GOOD.replace("weekly-report", "skill-a"), "a/ref/notes.txt": "hi",
                     "b/SKILL.md": GOOD.replace("weekly-report", "skill-b"), "../escape.txt": "no",
                     "__MACOSX/a/._SKILL.md": "junk"})
        names = sorted(s["name"] for s in skills.upload("skills.zip", data))
        self.assertEqual(names, ["skill-a", "skill-b"])
        self.assertTrue((self.root / "personal" / "skill-a" / "ref" / "notes.txt").is_file())
        self.assertFalse((self.root / "escape.txt").exists())
        with self.assertRaises(ConflictError):
            skills.upload("skills.zip", data)
        skills.upload("skills.zip", data, replace=True)
        with self.assertRaises(ValidationError):
            skills.upload("notes.zip", _zip({"readme.txt": "no skill"}))
        with self.assertRaises(ValidationError):
            skills.upload("x.exe", b"MZ")
        with self.assertRaises(ValidationError):
            skills.upload("SKILL.md", b"no front matter")

    def test_import_from_github_folder(self):
        tar = _tar({"skills/demo/SKILL.md": GOOD.replace("weekly-report", "demo").encode(),
                    "skills/demo/scripts/run.py": b"print(1)", "skills/other/SKILL.md": b"x",
                    "skills/demo/.git/config": b"secret"})
        with mock.patch.object(skills, "_download", return_value=tar) as download:
            installed = skills.import_github("https://github.com/acme/skills/tree/main/skills/demo")
        download.assert_called_once_with("https://codeload.github.com/acme/skills/tar.gz/main")
        self.assertEqual([s["name"] for s in installed], ["demo"])
        folder = self.root / "personal" / "demo"
        self.assertTrue((folder / "scripts" / "run.py").is_file())
        self.assertFalse((folder / "evil-link").exists())
        self.assertFalse((folder / ".git").exists())
        self.assertEqual(installed[0]["origin"], "github")

    def test_github_links(self):
        parse = skills._parse_github_url
        self.assertEqual(parse("https://github.com/a/b"), ("a", "b", None, ""))
        self.assertEqual(parse("https://github.com/a/b/tree/v1/x/y"), ("a", "b", "v1", "x/y"))
        self.assertEqual(parse("https://github.com/a/b/blob/main/x/SKILL.md"), ("a", "b", "main", "x"))
        for bad in ("http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "file:///etc"):
            with self.assertRaises(ValidationError):
                parse(bad)

    def test_catalog_install_is_pinned(self):
        tar = _tar({"skills/pdf/SKILL.md": b"---\nname: pdf\ndescription: PDFs.\n---\nDo it.\n"})
        with mock.patch.object(skills, "_download", return_value=tar) as download:
            skill = skills.install_from_catalog("pdf")
        self.assertIn(skills._ANTHROPIC["ref"], download.call_args[0][0])
        self.assertEqual((skill["catalog_id"], skill["license"]), ("pdf", "Apache-2.0"))
        self.assertTrue(next(c for c in skills.catalog() if c["id"] == "pdf")["installed"])

    def test_chat_tool_reads_enabled_skills_only(self):
        skills.create("weekly-report", "Write the weekly status report.", "Use three headings.")
        (self.root / "personal" / "weekly-report" / "template.md").write_text("## Done\n")
        text = skills.Skill.invoke({"name": "weekly-report"})
        self.assertIn("Use three headings.", text)
        self.assertIn("template.md", text)
        self.assertEqual(skills.Skill.invoke({"name": "weekly-report", "file": "template.md"}), "## Done\n")
        self.assertIn("no file", skills.Skill.invoke({"name": "weekly-report", "file": "../../etc/passwd"}))
        skills.set_enabled("personal/weekly-report", False)
        self.assertIn("No enabled skill", skills.Skill.invoke({"name": "weekly-report"}))
        self.assertIn("code-review:", skills.prompt_text())
        self.assertNotIn("weekly-report", skills.prompt_text())


if __name__ == "__main__":
    unittest.main()

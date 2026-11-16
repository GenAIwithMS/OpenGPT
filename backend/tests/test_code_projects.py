"""Coding agent projects: folders on this computer (browse, open, create, checks)."""
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from app.database.config import DatabaseConfig  # noqa: E402
from app.database.models import CodeProject  # noqa: E402
from app.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationError  # noqa: E402
from app.services.coding_agent import projects  # noqa: E402


class ProjectsTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.home = self.tmp / "home"
        self.code = self.home / "code"           # an allowed root
        self.new_root = self.home / "OpenGPT Projects"
        self.outside = self.tmp / "outside"
        for d in (self.code / "app" / "src", self.code / ".secret", self.home / ".ssh", self.outside):
            d.mkdir(parents=True)
        env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "USERPROFILE": str(self.home), "HOST": "127.0.0.1",
            "CODE_ALLOWED_ROOTS": str(self.home), "CODE_PROJECTS_ROOT": str(self.new_root),
        })
        env.start()
        self.addCleanup(env.stop)
        with DatabaseConfig.get_session_factory()() as db:
            db.query(CodeProject).delete()
            db.commit()


class NameTests(ProjectsTestCase):
    def test_valid_and_rejected_names(self):
        for name in ["app", "my-app", "My App 2", "site.v2"]:
            self.assertEqual(projects.validate_name(f" {name} "), name)
        for name in ["", "..", "../x", "a/b", "a\\b", ".hidden", "-x", "x.", "con", "x" * 65, "näme"]:
            with self.subTest(name=name), self.assertRaises(ValidationError):
                projects.validate_name(name)


class OpenFolderTests(ProjectsTestCase):
    def test_open_and_list(self):
        p = projects.open_folder(str(self.code / "app"))
        self.assertEqual((p["name"], p["path"], p["exists"]), ("app", str(self.code / "app"), True))
        self.assertEqual([x["id"] for x in projects.list_projects()], [p["id"]])
        self.assertEqual(projects.project_path(p["id"]), self.code / "app")

    def test_opening_twice_keeps_one_entry(self):
        a = projects.open_folder(str(self.code / "app"))
        b = projects.open_folder(str(self.code / "app" / "src" / ".."))
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(len(projects.list_projects()), 1)

    def test_home_shortcut(self):
        p = projects.open_folder("~/code/app")
        self.assertEqual(p["path"], str(self.code / "app"))

    def test_refused_folders(self):
        cases = {
            str(self.outside): ForbiddenError,          # outside the allowed roots
            str(self.home): ForbiddenError,             # the whole home folder
            str(self.home / ".ssh"): ForbiddenError,    # hidden
            str(self.code / ".secret"): ForbiddenError,
            str(self.code / "missing"): NotFoundError,
            "code/app": ValidationError,                # relative
            "": ValidationError,
            "/": ForbiddenError,
        }
        for path, error in cases.items():
            with self.subTest(path=path), self.assertRaises(error):
                projects.open_folder(path)
        self.assertEqual(projects.list_projects(), [])

    def test_symlink_out_of_the_allowed_folders_is_refused(self):
        (self.code / "link").symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(ForbiddenError):
            projects.open_folder(str(self.code / "link"))

    def test_folder_swapped_for_a_link_later_is_refused(self):
        p = projects.open_folder(str(self.code / "app"))
        shutil.rmtree(self.code / "app")
        (self.code / "app").symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(NotFoundError):
            projects.project_path(p["id"])

    def test_moved_folder(self):
        p = projects.open_folder(str(self.code / "app"))
        shutil.rmtree(self.code / "app")
        self.assertFalse(projects.list_projects()[0]["exists"])
        with self.assertRaises(NotFoundError):
            projects.project_path(p["id"])

    def test_not_available_when_the_api_is_exposed(self):
        with mock.patch.dict(os.environ, {"HOST": "0.0.0.0"}):
            with self.assertRaises(ForbiddenError):
                projects.open_folder(str(self.code / "app"))
            with self.assertRaises(ForbiddenError):
                projects.browse()

    def test_remove_keeps_the_files(self):
        p = projects.open_folder(str(self.code / "app"))
        projects.remove_project(p["id"])
        self.assertEqual(projects.list_projects(), [])
        self.assertTrue((self.code / "app" / "src").is_dir())
        with self.assertRaises(NotFoundError):
            projects.remove_project(p["id"])
        with self.assertRaises(ValidationError):
            projects.remove_project("not-an-id")

    def test_project_for_directory(self):
        p = projects.open_folder(str(self.code / "app"))
        self.assertEqual(projects.project_for_directory(str(self.code / "app"))["id"], p["id"])
        self.assertIsNone(projects.project_for_directory(str(self.code / "app" / "src")))
        self.assertIsNone(projects.project_for_directory(str(self.outside)))


class BrowseTests(ProjectsTestCase):
    def test_starts_at_home_and_hides_hidden_folders(self):
        listing = projects.browse()
        self.assertEqual(listing["path"], str(self.home))
        names = [e["name"] for e in listing["entries"]]
        self.assertIn("code", names)
        self.assertNotIn(".ssh", names)
        self.assertFalse(listing["can_open"])  # the home folder itself
        self.assertIsNone(listing["parent"])   # can't go above the allowed root

    def test_subfolder(self):
        listing = projects.browse(str(self.code))
        self.assertEqual([e["name"] for e in listing["entries"]], ["app"])
        self.assertEqual(listing["parent"], str(self.home))
        self.assertTrue(listing["can_open"])

    def test_refused(self):
        with self.assertRaises(ForbiddenError):
            projects.browse(str(self.outside))
        with self.assertRaises(ForbiddenError):
            projects.browse(str(self.home / ".ssh"))

    def test_links_out_are_not_listed(self):
        (self.code / "escape").symlink_to(self.outside, target_is_directory=True)
        (self.code / "file.txt").write_text("x")
        self.assertEqual([e["name"] for e in projects.browse(str(self.code))["entries"]], ["app"])


class CreateTests(ProjectsTestCase):
    def test_create_in_projects_root(self):
        p = projects.create_project("new-app")
        self.assertEqual(p["path"], str(self.new_root / "new-app"))
        self.assertTrue((self.new_root / "new-app").is_dir())
        if shutil.which("git"):
            self.assertTrue((self.new_root / "new-app" / ".git").is_dir())
        self.assertEqual(projects.list_projects()[0]["id"], p["id"])

    def test_create_works_when_exposed_and_without_git(self):
        with mock.patch.dict(os.environ, {"HOST": "0.0.0.0"}), mock.patch("shutil.which", return_value=None):
            p = projects.create_project("plain")
        self.assertFalse((Path(p["path"]) / ".git").exists())

    def test_conflicts(self):
        projects.create_project("app")
        for name in ("app", "APP"):
            with self.subTest(name=name), self.assertRaises(ConflictError):
                projects.create_project(name)

    def test_projects_root_is_allowed_even_outside_the_roots(self):
        with mock.patch.dict(os.environ, {"CODE_ALLOWED_ROOTS": str(self.code)}):
            p = projects.create_project("elsewhere")
            self.assertEqual(projects.project_path(p["id"]), self.new_root / "elsewhere")


class RouteTests(ProjectsTestCase):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.code import code_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(code_router, prefix="/api")
        self.client = TestClient(app)

    def test_flow(self):
        listing = self.client.get("/api/code/folders", params={"path": str(self.code)}).json()
        self.assertEqual(listing["entries"][0]["name"], "app")
        r = self.client.post("/api/code/projects/open", json={"path": listing["entries"][0]["path"]})
        self.assertEqual(r.status_code, 200)
        pid = r.json()["id"]
        r = self.client.post("/api/code/projects", json={"name": "fresh"})
        self.assertEqual(r.status_code, 201)
        body = self.client.get("/api/code/projects").json()
        self.assertEqual([p["name"] for p in body["projects"]], ["fresh", "app"])
        self.assertEqual(body["projects_root"], str(self.new_root))
        self.assertTrue(body["can_browse"])
        self.assertEqual(self.client.delete(f"/api/code/projects/{pid}").status_code, 204)

    def test_errors(self):
        self.assertEqual(self.client.post("/api/code/projects/open", json={"path": str(self.outside)}).status_code, 403)
        self.assertEqual(self.client.post("/api/code/projects/open", json={"path": "relative"}).status_code, 422)
        self.assertEqual(self.client.get("/api/code/folders", params={"path": "/etc"}).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/code/projects/{uuid.uuid4()}").status_code, 404)
        self.client.post("/api/code/projects", json={"name": "app"})
        self.assertEqual(self.client.post("/api/code/projects", json={"name": "app"}).status_code, 409)


if __name__ == "__main__":
    unittest.main()

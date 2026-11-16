"""Skills (Settings > Skills): folders of instructions, each with a SKILL.md.

A skill is a folder whose SKILL.md starts with YAML front matter giving its
``name`` and ``description`` (the open Agent Skills format), followed by the
instructions; it may hold other files (references, scripts, templates).

Where skills come from:
* built-in   OpenGPT's own skills, shipped in app/skills/
* personal   created, uploaded, imported from GitHub or added from the
             Explore catalog; stored in app/storage/skills/
* local      already on this computer (~/.claude/skills, ~/.agents/skills);
             read in place, off until the user turns them on

Chat lists the enabled skills in its system prompt and reads one with the
Skill tool. The coding agent gets the enabled skill folders in its config.
"""
import io
import json
import logging
import re
import shutil
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import urlparse

import httpx
import yaml

from app.database.config import DatabaseConfig
from app.database.models import AppSetting
from app.exceptions import ConflictError, NotFoundError, UpstreamError, ValidationError

logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parents[1]
BUILTIN_DIR = APP_DIR / "skills"
PERSONAL_DIR = APP_DIR / "storage" / "skills"
LOCAL_ROOTS = {"claude": Path.home() / ".claude" / "skills", "agents": Path.home() / ".agents" / "skills"}

SETTINGS_KEY = "skills"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_DESCRIPTION = 1024
MAX_SKILL_MD = 200_000            # characters
MAX_SKILL_BYTES = 20 * 1024 * 1024
MAX_SKILL_FILES = 300
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
MAX_SKILLS_PER_IMPORT = 25
MAX_READ_CHARS = 60_000            # what the Skill tool returns at most
TIMEOUT = httpx.Timeout(30.0, read=120.0)

# Explore: open-source skills, installed from GitHub at a pinned commit.
_ANTHROPIC = {"repo": "anthropics/skills", "ref": "e4bb5d960d87126ff3b3a8af1a104b7db67560ba",
              "license": "Apache-2.0", "author": "Anthropic"}
CATALOG = [
    {"id": "pdf", "title": "PDF", "category": "Documents",
     "description": "Read, extract text and tables from, merge, split, fill and create PDF files."},
    {"id": "docx", "title": "Word documents", "category": "Documents",
     "description": "Create, read and edit Word documents (.docx), including tracked changes and comments."},
    {"id": "xlsx", "title": "Excel spreadsheets", "category": "Documents",
     "description": "Create, read and edit spreadsheets (.xlsx, .csv) with formulas, formatting and charts."},
    {"id": "pptx", "title": "PowerPoint", "category": "Documents",
     "description": "Create, read and edit presentations (.pptx): layouts, slides, speaker notes."},
    {"id": "frontend-design", "title": "Frontend design", "category": "Development",
     "description": "Distinctive, intentional visual design for web pages and app interfaces."},
    {"id": "webapp-testing", "title": "Web app testing", "category": "Development",
     "description": "Test local web apps with Playwright: check behaviour, read logs, take screenshots."},
    {"id": "mcp-builder", "title": "MCP server builder", "category": "Development",
     "description": "Build good MCP servers that give AI assistants tools for an external service."},
    {"id": "skill-creator", "title": "Skill creator", "category": "Development",
     "description": "Create new skills and improve existing ones."},
    {"id": "algorithmic-art", "title": "Algorithmic art", "category": "Creative",
     "description": "Generative art with p5.js: seeded randomness and interactive parameters."},
    {"id": "canvas-design", "title": "Canvas design", "category": "Creative",
     "description": "Posters and visual art as .png and .pdf, from a design philosophy."},
    {"id": "theme-factory", "title": "Theme factory", "category": "Creative",
     "description": "Style slides, documents and pages with one of ten ready themes, or a new one."},
    {"id": "slack-gif-creator", "title": "Animated GIFs", "category": "Creative",
     "description": "Small animated GIFs sized and optimised for chat apps."},
]
_CATALOG_BY_ID = {c["id"]: {**c, **_ANTHROPIC} for c in CATALOG}


# ---------------------------------------------------------------- state

def _session():
    return DatabaseConfig.get_session_factory()()


def _state() -> dict:
    with _session() as db:
        row = db.get(AppSetting, SETTINGS_KEY)
        try:
            data = json.loads(row.value) if row else {}
        except (TypeError, ValueError):
            data = {}
    return {"enabled": dict(data.get("enabled") or {}), "meta": dict(data.get("meta") or {})}


def _save_state(state: dict) -> None:
    with _session() as db:
        row = db.get(AppSetting, SETTINGS_KEY)
        value = json.dumps(state)
        if row is None:
            db.add(AppSetting(key=SETTINGS_KEY, value=value))
        else:
            row.value = value
        db.commit()


# ---------------------------------------------------------------- SKILL.md

def parse_skill_md(text: str) -> dict:
    """{name, description, body} from SKILL.md. Raises ValidationError."""
    if len(text) > MAX_SKILL_MD:
        raise ValidationError("SKILL.md is too long")
    match = re.match(r"^﻿?---\s*\n(.*?)\n---\s*(?:\n|$)(.*)$", text, re.S)
    if not match:
        raise ValidationError("SKILL.md must start with front matter (--- name: ..., description: ... ---)")
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        raise ValidationError("SKILL.md front matter isn't valid YAML") from None
    if not isinstance(meta, dict):
        raise ValidationError("SKILL.md front matter must be key: value pairs")
    name = str(meta.get("name") or "").strip()
    description = " ".join(str(meta.get("description") or "").split())
    if not NAME_RE.match(name):
        raise ValidationError("Skill name: lowercase letters, digits and hyphens, up to 64 (e.g. weekly-report)")
    if not description:
        raise ValidationError("SKILL.md needs a description saying what the skill does and when to use it")
    return {"name": name, "description": description[:MAX_DESCRIPTION], "body": match.group(2).strip()}


def build_skill_md(name: str, description: str, instructions: str) -> str:
    front = yaml.safe_dump({"name": name, "description": " ".join(description.split())},
                           sort_keys=False, allow_unicode=True, width=1000).strip()
    return f"---\n{front}\n---\n\n{instructions.strip()}\n"


def _read_skill(folder: Path) -> Optional[dict]:
    try:
        return parse_skill_md((folder / "SKILL.md").read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValidationError):
        return None


# ---------------------------------------------------------------- discovery

def _skill_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".") and (p / "SKILL.md").is_file())


def _all() -> list[dict]:
    """Every skill found, with its id, folder and parsed SKILL.md."""
    found = []
    for source, roots in (("builtin", {"": BUILTIN_DIR}), ("personal", {"": PERSONAL_DIR}), ("local", LOCAL_ROOTS)):
        for label, root in roots.items():
            for folder in _skill_dirs(root):
                parsed = _read_skill(folder)
                if not parsed:
                    continue
                skill_id = f"{source}/{label + '/' if label else ''}{folder.name}"
                found.append({"id": skill_id, "source": source, "folder": folder, **parsed})
    return found


def _get(skill_id: str) -> dict:
    for skill in _all():
        if skill["id"] == skill_id:
            return skill
    raise NotFoundError("Skill not found")


def _is_enabled(skill: dict, state: dict) -> bool:
    default = skill["source"] != "local"   # local skills are opt-in
    return bool(state["enabled"].get(skill["id"], default))


def _info(skill: dict, state: dict) -> dict:
    meta = state["meta"].get(skill["name"], {}) if skill["source"] == "personal" else {}
    try:
        updated = (skill["folder"] / "SKILL.md").stat().st_mtime
    except OSError:
        updated = None
    return {
        "id": skill["id"],
        "name": skill["name"],
        "description": skill["description"],
        "source": skill["source"],
        "origin": meta.get("origin") or ("opengpt" if skill["source"] == "builtin" else skill["source"]),
        "url": meta.get("url"),
        "catalog_id": meta.get("catalog_id"),
        "license": meta.get("license"),
        "location": str(skill["folder"]) if skill["source"] == "local" else None,
        "enabled": _is_enabled(skill, state),
        "editable": skill["source"] == "personal",
        "updated_at": updated,
    }


def list_skills() -> list[dict]:
    state = _state()
    return [_info(s, state) for s in _all()]


def get_skill(skill_id: str) -> dict:
    """A skill with its SKILL.md and the list of its other files."""
    skill = _get(skill_id)
    info = _info(skill, _state())
    files = []
    for path in sorted(skill["folder"].rglob("*")):
        if len(files) >= 200:
            break
        rel = path.relative_to(skill["folder"]).as_posix()
        if path.is_file() and rel != "SKILL.md" and not any(part.startswith(".") for part in rel.split("/")):
            files.append(rel)
    text = (skill["folder"] / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    return {**info, "skill_md": text, "files": files}


def set_enabled(skill_id: str, enabled: bool) -> dict:
    skill = _get(skill_id)
    state = _state()
    state["enabled"][skill_id] = bool(enabled)
    _save_state(state)
    return _info(skill, state)


def enabled_skills() -> list[dict]:
    """[{id, name, description, folder}] of enabled skills; one per name
    (personal first, then built-in, then local)."""
    state = _state()
    order = {"personal": 0, "builtin": 1, "local": 2}
    chosen: dict[str, dict] = {}
    for skill in sorted(_all(), key=lambda s: order[s["source"]]):
        if _is_enabled(skill, state) and skill["name"] not in chosen:
            chosen[skill["name"]] = skill
    return sorted(chosen.values(), key=lambda s: s["name"])


def agent_paths() -> list[str]:
    """Folders of the enabled skills, for the coding agent's config."""
    return [str(s["folder"]) for s in enabled_skills()]


# ---------------------------------------------------------------- personal skills

def _taken(name: str) -> bool:
    return any(s["name"] == name and s["source"] in ("builtin", "personal") for s in _all())


def _record(name: str, **meta) -> None:
    state = _state()
    state["meta"][name] = {**meta, "added_at": time.time()}
    state["enabled"][f"personal/{name}"] = True
    _save_state(state)


def create(name: str, description: str, instructions: str) -> dict:
    name = (name or "").strip().lower()
    text = build_skill_md(name, description or "", instructions or "")
    parsed = parse_skill_md(text)
    if not parsed["body"]:
        raise ValidationError("Write the skill's instructions")
    if _taken(parsed["name"]):
        raise ConflictError(f"A skill named {parsed['name']} already exists")
    folder = PERSONAL_DIR / parsed["name"]
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "SKILL.md").write_text(text, encoding="utf-8")
    _record(parsed["name"], origin="created")
    return _info(_get(f"personal/{parsed['name']}"), _state())


def update_skill_md(skill_id: str, text: str) -> dict:
    skill = _get(skill_id)
    if skill["source"] != "personal":
        raise ValidationError("Only your own skills can be edited")
    parsed = parse_skill_md(text or "")
    if parsed["name"] != skill["name"]:
        raise ValidationError("The name can't change; create a new skill instead")
    (skill["folder"] / "SKILL.md").write_text(text, encoding="utf-8")
    return _info(_get(skill_id), _state())


def delete(skill_id: str) -> None:
    skill = _get(skill_id)
    if skill["source"] != "personal":
        raise ValidationError("Built-in and local skills can't be removed here; turn them off instead")
    shutil.rmtree(skill["folder"])
    state = _state()
    state["meta"].pop(skill["name"], None)
    state["enabled"].pop(skill_id, None)
    _save_state(state)


# ---------------------------------------------------------------- installing folders

def _safe_rel(name: str) -> Optional[PurePosixPath]:
    """A relative path that stays inside the folder, or None."""
    rel = PurePosixPath(name.replace("\\", "/"))
    if rel.is_absolute() or not rel.parts or any(p in ("", ".", "..") for p in rel.parts) or "\0" in name:
        return None
    return rel


def _install_tree(files: dict[str, bytes], replace: bool, **meta) -> list[dict]:
    """Install skills from {relative path: bytes}. Every folder with a SKILL.md
    (and a single SKILL.md at the top) becomes one skill."""
    roots = sorted({str(PurePosixPath(p).parent) for p in files if PurePosixPath(p).name == "SKILL.md"},
                   key=lambda r: (r.count("/"), r))
    # A skill folder inside another skill is part of the outer one.
    roots = [r for r in roots if not any(r != o and (o == "." or r.startswith(o + "/")) for o in roots)]
    if not roots:
        raise ValidationError("No SKILL.md found")
    if len(roots) > MAX_SKILLS_PER_IMPORT:
        raise ValidationError(f"Too many skills at once (at most {MAX_SKILLS_PER_IMPORT})")

    plans = []
    for root in roots:
        prefix = "" if root == "." else root + "/"
        members = {p[len(prefix):]: data for p, data in files.items() if p.startswith(prefix)}
        if len(members) > MAX_SKILL_FILES or sum(len(d) for d in members.values()) > MAX_SKILL_BYTES:
            raise ValidationError(f"A skill can have at most {MAX_SKILL_FILES} files and 20 MB")
        parsed = parse_skill_md(members["SKILL.md"].decode("utf-8", errors="replace"))
        existing = PERSONAL_DIR / parsed["name"]
        if any(s["name"] == parsed["name"] and s["source"] == "builtin" for s in _all()):
            raise ConflictError(f"{parsed['name']} is a built-in skill name; rename yours")
        if existing.exists() and not replace:
            raise ConflictError(f"A skill named {parsed['name']} already exists")
        plans.append((parsed["name"], members))

    installed = []
    PERSONAL_DIR.mkdir(parents=True, exist_ok=True)
    for name, members in plans:
        staging = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=PERSONAL_DIR))
        try:
            for rel, data in members.items():
                target = staging / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            final = PERSONAL_DIR / name
            if final.exists():
                shutil.rmtree(final)
            staging.rename(final)
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        _record(name, **meta)
        installed.append(_info(_get(f"personal/{name}"), _state()))
    return installed


def upload(filename: str, data: bytes, replace: bool = False) -> list[dict]:
    """A SKILL.md / .md file, or a .zip of one or more skill folders."""
    lower = (filename or "").lower()
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValidationError("The file is too large")
    if lower.endswith(".md"):
        return _install_tree({"SKILL.md": data}, replace, origin="uploaded")
    if not lower.endswith(".zip"):
        raise ValidationError("Upload a SKILL.md file or a .zip of a skill folder")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValidationError("That isn't a valid .zip file") from None
    files, total = {}, 0
    for item in archive.infolist():
        if item.is_dir():
            continue
        if (item.external_attr >> 16) & 0o170000 == 0o120000:   # symbolic link
            continue
        rel = _safe_rel(item.filename)
        if rel is None or rel.parts[0] == "__MACOSX" or rel.name == ".DS_Store":
            continue
        total += item.file_size
        if total > MAX_SKILL_BYTES * 2 or len(files) >= MAX_SKILL_FILES * 4:
            raise ValidationError("The .zip is too large")
        files[str(rel)] = archive.read(item)
    return _install_tree(files, replace, origin="uploaded")


# ---------------------------------------------------------------- GitHub

def _parse_github_url(url: str) -> tuple[str, str, Optional[str], str]:
    """owner, repo, ref (None = default branch), path inside the repo."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme != "https" or parsed.netloc.lower() not in ("github.com", "www.github.com"):
        raise ValidationError("Use a https://github.com/... link to a repository or a folder in it")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise ValidationError("Use a link to a repository, e.g. https://github.com/owner/repo")
    owner, repo = parts[0], parts[1].removesuffix(".git")
    ref, path = None, ""
    if len(parts) >= 4 and parts[2] in ("tree", "blob"):
        ref, path = parts[3], "/".join(parts[4:])
        if parts[2] == "blob":
            path = str(PurePosixPath(path).parent) if path.endswith("SKILL.md") else path
    if not all(re.match(r"^[A-Za-z0-9_.-]+$", p) for p in (owner, repo)) or (ref and not re.match(r"^[A-Za-z0-9_./-]+$", ref)):
        raise ValidationError("That GitHub link doesn't look right")
    return owner, repo, ref, path.strip("/").removesuffix("/.")


def _download(url: str) -> bytes:
    try:
        with httpx.stream("GET", url, timeout=TIMEOUT, follow_redirects=True) as r:
            if r.status_code == 404:
                raise ValidationError("Not found on GitHub (private repositories aren't supported)")
            if r.status_code >= 400:
                raise UpstreamError(f"GitHub answered {r.status_code}. Try again later.")
            chunks, size = [], 0
            for chunk in r.iter_bytes():
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    raise ValidationError("That repository is too large to import; link to the skill's folder")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.HTTPError as e:
        logger.warning("GitHub download failed: %s", e)
        raise UpstreamError("Couldn't reach GitHub. Try again.") from None


def _default_branch(owner: str, repo: str) -> str:
    try:
        r = httpx.get(f"https://api.github.com/repos/{owner}/{repo}", timeout=TIMEOUT,
                      headers={"Accept": "application/vnd.github+json"})
    except httpx.HTTPError:
        raise UpstreamError("Couldn't reach GitHub. Try again.") from None
    if r.status_code == 404:
        raise ValidationError("Repository not found (private repositories aren't supported)")
    if r.status_code >= 400:
        raise UpstreamError("GitHub didn't answer (it may be rate limiting). Link to a branch, e.g. .../tree/main")
    return r.json().get("default_branch") or "main"


def _github_files(owner: str, repo: str, ref: str, path: str) -> dict[str, bytes]:
    """Files under ``path`` in the repository at ``ref``, relative to it."""
    data = _download(f"https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}")
    files, total = {}, 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            for member in tar:
                if not member.isfile():   # skips links, devices, folders
                    continue
                parts = member.name.split("/", 1)   # "<repo>-<ref>/<path>"
                if len(parts) < 2:
                    continue
                inner = parts[1]
                if path:
                    if not inner.startswith(path + "/"):
                        continue
                    inner = inner[len(path) + 1:]
                rel = _safe_rel(inner)
                if rel is None or any(p.startswith(".") for p in rel.parts):
                    continue
                total += member.size
                if total > MAX_SKILL_BYTES * MAX_SKILLS_PER_IMPORT:
                    raise ValidationError("Too much to import at once; link to the skill's folder")
                extracted = tar.extractfile(member)
                if extracted is not None:
                    files[str(rel)] = extracted.read()
    except tarfile.TarError:
        raise UpstreamError("GitHub sent a broken archive. Try again.") from None
    if not files:
        raise ValidationError("Nothing found at that link")
    return files


def import_github(url: str, replace: bool = False) -> list[dict]:
    owner, repo, ref, path = _parse_github_url(url)
    ref = ref or _default_branch(owner, repo)
    files = _github_files(owner, repo, ref, path)
    return _install_tree(files, replace, origin="github", url=url.strip())


def catalog() -> list[dict]:
    installed = {m.get("catalog_id") for m in _state()["meta"].values() if m.get("catalog_id")}
    return [{**c, "installed": c["id"] in installed} for c in _CATALOG_BY_ID.values()]


def install_from_catalog(catalog_id: str) -> dict:
    entry = _CATALOG_BY_ID.get(catalog_id)
    if not entry:
        raise NotFoundError("Not in the catalog")
    path = f"skills/{catalog_id}"
    owner, repo = entry["repo"].split("/")
    files = _github_files(owner, repo, entry["ref"], path)
    url = f"https://github.com/{entry['repo']}/tree/{entry['ref']}/{path}"
    installed = _install_tree(files, replace=True, origin="catalog", url=url,
                              catalog_id=catalog_id, license=entry["license"])
    return installed[0]


# ---------------------------------------------------------------- reading (chat's Skill tool)

def read(name: str, file: Optional[str] = None) -> str:
    """An enabled skill's SKILL.md (or one of its text files) for the model."""
    skill = next((s for s in enabled_skills() if s["name"] == name), None)
    if skill is None:
        names = ", ".join(s["name"] for s in enabled_skills()) or "none"
        return f"No enabled skill named {name!r}. Enabled skills: {names}."
    folder = skill["folder"]
    if file:
        rel = _safe_rel(file)
        target = (folder / str(rel)).resolve() if rel else None
        if target is None or not target.is_relative_to(folder.resolve()) or not target.is_file():
            return f"The skill {name} has no file {file!r}."
        data = target.read_bytes()[: MAX_READ_CHARS * 2]
        if b"\0" in data[:4096]:
            return f"{file} is a binary file; it can only be used by the coding agent."
        return data.decode("utf-8", errors="replace")[:MAX_READ_CHARS]
    text = (folder / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    others = [p.relative_to(folder).as_posix() for p in sorted(folder.rglob("*"))
              if p.is_file() and p.name != "SKILL.md" and not any(x.startswith(".") for x in p.relative_to(folder).parts)][:100]
    if others:
        text += ("\n\n---\nFiles in this skill (read one with file=...; scripts can only run in the Code page): "
                 + ", ".join(others))
    return text[:MAX_READ_CHARS]


# ---------------------------------------------------------------- chat tool

def _make_tool():
    from langchain_core.tools import tool

    @tool("Skill")
    def skill_tool(name: str, file: Optional[str] = None) -> str:
        """Load one of the user's enabled skills: its instructions (SKILL.md),
        or one of its files with `file` (a path listed in the instructions).
        Load the skill first, then follow it for the task it covers."""
        return read(name, file)

    return skill_tool


Skill = _make_tool()


def prompt_text(limit: int = 40) -> str:
    """The enabled skills, for the chat system prompt ("" when none)."""
    items = enabled_skills()[:limit]
    if not items:
        return ""
    lines = "\n".join(f"- {s['name']}: {s['description'][:240]}" for s in items)
    return ("The user has these skills (instructions for specific kinds of tasks). When a "
            "request matches one, call the Skill tool with its name first, then follow it:\n" + lines)

"""Project folders the coding agent may work in.

Every project is a folder directly inside CODE_PROJECTS_ROOT (default:
backend/app/storage/code/). The agent is only ever pointed at one of these
folders, so the checks here decide what it can touch:

* a project is named, never given as a path: no "/", "\\" or "..", and no
  hidden (dot) names
* the folder's real location (symlinks followed) must be directly inside the
  root, so a symlink can't lead the agent elsewhere on the machine

Point CODE_PROJECTS_ROOT at e.g. ~/projects to work on your own repositories.
"""
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from app.exceptions import ConflictError, NotFoundError, ValidationError

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "storage" / "code"

MAX_NAME_CHARS = 64
# Starts with a letter or digit; then letters, digits, space, dot, dash, underscore.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$")
# Names Windows can't use for files or folders.
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def root() -> Path:
    """The projects folder (created if missing), with symlinks resolved."""
    custom = (os.getenv("CODE_PROJECTS_ROOT") or "").strip()
    path = Path(custom).expanduser() if custom else DEFAULT_ROOT
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve(strict=True)


def validate_name(name: str) -> str:
    """The project name, trimmed, or ValidationError."""
    name = (name or "").strip()
    if not name:
        raise ValidationError("Project name is required")
    if len(name) > MAX_NAME_CHARS:
        raise ValidationError(f"Project name can be at most {MAX_NAME_CHARS} characters")
    if not _NAME_RE.match(name) or name.endswith((".", " ")) or ".." in name:
        raise ValidationError(
            "Project name can use letters, digits, spaces, dots, dashes and underscores, "
            "and must start with a letter or digit"
        )
    if name.split(".")[0].strip().lower() in _RESERVED:
        raise ValidationError("That project name is reserved")
    return name


def _inside_root(path: Path, base: Path) -> bool:
    """True if `path` (real location) is a folder directly inside `base`."""
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):  # missing, or a symlink loop
        return False
    return real.parent == base and real.is_dir()


def project_path(name: str) -> Path:
    """The real folder of an existing project. NotFoundError if there is none."""
    name = validate_name(name)
    base = root()
    path = base / name
    if not _inside_root(path, base):
        raise NotFoundError("Project not found")
    return path.resolve(strict=True)


def _info(path: Path) -> dict:
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return {"name": path.name, "modified": modified.isoformat()}


def list_projects() -> list[dict]:
    """Projects, most recently changed first. Hidden, invalid and escaping folders are skipped."""
    base = root()
    projects = []
    for entry in base.iterdir():
        try:
            validate_name(entry.name)
        except ValidationError:
            continue
        if entry.name != entry.name.strip() or not _inside_root(entry, base):
            continue
        projects.append(_info(entry))
    return sorted(projects, key=lambda p: p["modified"], reverse=True)


def create_project(name: str) -> dict:
    """Create an empty project folder. ConflictError if the name is taken."""
    name = validate_name(name)
    base = root()
    path = base / name
    # Case-insensitive file systems (Windows, macOS) treat "App" and "app" as one.
    if path.exists() or path.is_symlink() or any(e.name.lower() == name.lower() for e in base.iterdir()):
        raise ConflictError("A project with that name already exists")
    try:
        path.mkdir()
    except FileExistsError:
        raise ConflictError("A project with that name already exists") from None
    return _info(path)

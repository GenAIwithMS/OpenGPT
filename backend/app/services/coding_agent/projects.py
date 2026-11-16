"""Project folders the coding agent works in.

A project is a folder on this computer, opened from the Code page's folder
browser (or by path) or created new. Opened folders are remembered in the
`code_projects` table; the agent is only ever pointed at one of them.

Which folders are allowed:

* folders inside CODE_ALLOWED_ROOTS (default: your home folder), plus the
  folder new projects are created in (CODE_PROJECTS_ROOT, default
  "~/OpenGPT Projects")
* never a hidden folder or anything inside one (.ssh, .config, ...)
* never the home folder itself or the top of a drive
* the real location counts (symlinks followed), so a link can't lead the
  agent outside the allowed folders

Browsing and opening by path are only available while the API is local
(HOST=127.0.0.1); otherwise anyone who can reach the API could list the
computer's folders. New projects work either way.
"""
import hashlib
import logging
import os
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import func

from app.database.config import DatabaseConfig
from app.database.models import CodeProject
from app.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.security import is_local_host

logger = logging.getLogger(__name__)

MAX_NAME_CHARS = 64
MAX_ENTRIES = 1000
MAX_PATH_CHARS = 4096
# New project names: start with a letter or digit; then letters, digits, space, dot, dash, underscore.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$")
# Names Windows can't use for files or folders.
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


# ----- settings -----

def _home() -> Path:
    return Path.home().resolve()


def projects_root() -> Path:
    """Where new projects are created (made if missing)."""
    custom = (os.getenv("CODE_PROJECTS_ROOT") or "").strip()
    path = Path(custom).expanduser() if custom else Path.home() / "OpenGPT Projects"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve(strict=True)


def allowed_roots() -> list[Path]:
    """Folders the agent may work inside (existing ones, real paths)."""
    raw = (os.getenv("CODE_ALLOWED_ROOTS") or "").strip()
    entries = [e for e in re.split(r"[,;" + re.escape(os.pathsep) + r"]", raw) if e.strip()] if raw else [str(Path.home())]
    roots = []
    for entry in entries:
        try:
            path = Path(entry.strip()).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if path.is_dir() and path not in roots:
            roots.append(path)
    root = projects_root()
    if root not in roots:
        roots.append(root)
    return roots


def browsing_enabled() -> bool:
    return is_local_host(os.getenv("HOST", "127.0.0.1"))


def _require_browsing() -> None:
    if not browsing_enabled():
        raise ForbiddenError(
            "Opening folders is only available while the API is local (HOST=127.0.0.1). "
            "Use New project instead."
        )


# ----- checks -----

def validate_name(name: str) -> str:
    """A new project's folder name, trimmed, or ValidationError."""
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


def _real(path_text: str) -> Path:
    """An absolute path from user input, with symlinks resolved. ValidationError/NotFoundError."""
    text = (path_text or "").strip()
    if not text or len(text) > MAX_PATH_CHARS or "\x00" in text:
        raise ValidationError("Enter a folder path")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ValidationError("Use a full folder path, e.g. ~/projects/my-app")
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise NotFoundError("Folder not found") from None
    if not real.is_dir():
        raise ValidationError("That is not a folder")
    return real


def _root_of(real: Path) -> Optional[Path]:
    """The allowed root containing `real` (the closest one), or None."""
    matches = [r for r in allowed_roots() if real == r or r in real.parents]
    return max(matches, key=lambda r: len(r.parts)) if matches else None


def _hidden_inside(real: Path, root: Path) -> bool:
    return any(part.startswith(".") for part in real.relative_to(root).parts)


def check_folder(real: Path) -> Path:
    """Raise unless the agent may work in this (real) folder."""
    root = _root_of(real)
    if root is None:
        raise ForbiddenError("That folder is outside the folders the coding agent may use (CODE_ALLOWED_ROOTS)")
    if _hidden_inside(real, root):
        raise ForbiddenError("Hidden folders can't be opened")
    if real == _home() or real == Path(real.anchor):
        raise ForbiddenError("Choose a project folder, not your whole home folder or drive")
    return real


def _path_hash(real: Path) -> str:
    return hashlib.sha256(os.path.normcase(str(real)).encode()).hexdigest()


# ----- browsing -----

def browse(path_text: Optional[str] = None) -> dict:
    """A folder's subfolders, for the folder browser."""
    _require_browsing()
    roots = allowed_roots()
    if path_text and path_text.strip():
        real = _real(path_text)
    else:
        home = _home()
        real = home if _root_of(home) else roots[0]
    root = _root_of(real)
    if root is None or _hidden_inside(real, root):
        raise ForbiddenError("That folder can't be browsed")

    entries = []
    try:
        children = sorted(real.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        children = []
    for child in children:
        if child.name.startswith(".") or len(entries) >= MAX_ENTRIES:
            continue
        try:
            target = child.resolve(strict=True)
            if not target.is_dir():
                continue
        except (OSError, RuntimeError):
            continue
        if _root_of(target) is None:  # a link out of the allowed folders
            continue
        entries.append({"name": child.name, "path": str(target)})

    parent = real.parent if real != root else None
    try:
        can_open = bool(check_folder(real))
    except ForbiddenError:
        can_open = False
    return {
        "path": str(real),
        "name": real.name or str(real),
        "parent": str(parent) if parent and _root_of(parent) else None,
        "roots": [str(r) for r in roots],
        "can_open": can_open,
        "entries": entries,
        "truncated": len(entries) >= MAX_ENTRIES,
    }


# ----- the project list -----

def _session():
    return DatabaseConfig.get_session_factory()()


def _info(row: CodeProject) -> dict:
    path = Path(row.path)
    opened = row.last_opened_at
    return {
        "id": row.id,
        "name": row.name,
        "path": row.path,
        "exists": path.is_dir(),
        "last_opened": opened.replace(tzinfo=timezone.utc).isoformat() if opened else None,
    }


def _register(real: Path) -> dict:
    """Add a folder to the list, or mark it opened again."""
    digest = _path_hash(real)
    with _session() as db:
        row = db.query(CodeProject).filter_by(path_hash=digest).first()
        if row is None:
            row = CodeProject(id=str(uuid.uuid4()), path=str(real), path_hash=digest, name=real.name[:255])
            db.add(row)
        row.last_opened_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        db.refresh(row)
        return _info(row)


def list_projects() -> list[dict]:
    """Opened and created projects, most recently opened first."""
    with _session() as db:
        rows = db.query(CodeProject).order_by(CodeProject.last_opened_at.desc()).limit(200).all()
        return [_info(r) for r in rows]


def open_folder(path_text: str) -> dict:
    """Open an existing folder as a project."""
    _require_browsing()
    return _register(check_folder(_real(path_text)))


def create_project(name: str) -> dict:
    """Create an empty project folder in CODE_PROJECTS_ROOT."""
    name = validate_name(name)
    base = projects_root()
    path = base / name
    # Case-insensitive file systems (Windows, macOS) treat "App" and "app" as one.
    if path.exists() or path.is_symlink() or any(e.name.lower() == name.lower() for e in base.iterdir()):
        raise ConflictError("A folder with that name already exists in the projects folder")
    try:
        path.mkdir()
    except FileExistsError:
        raise ConflictError("A folder with that name already exists in the projects folder") from None
    _git_init(path)
    return _register(path.resolve(strict=True))


def remove_project(project_id: str) -> None:
    """Remove a project from the list. Its folder and files are not touched."""
    with _session() as db:
        deleted = db.query(CodeProject).filter_by(id=_check_id(project_id)).delete()
        db.commit()
    if not deleted:
        raise NotFoundError("Project not found")


def _check_id(project_id: str) -> str:
    try:
        return str(uuid.UUID(str(project_id)))
    except ValueError:
        raise ValidationError("Invalid project id") from None


def get_project(project_id: str) -> dict:
    with _session() as db:
        row = db.get(CodeProject, _check_id(project_id))
        if row is None:
            raise NotFoundError("Project not found")
        return _info(row)


def project_path(project_id: str) -> Path:
    """The real folder of a listed project, checked again (it may have moved or been changed)."""
    info = get_project(project_id)
    try:
        real = Path(info["path"]).resolve(strict=True)
    except (OSError, RuntimeError):
        raise NotFoundError("The project folder no longer exists") from None
    if not real.is_dir() or _path_hash(real) != _path_hash(Path(info["path"])):
        raise NotFoundError("The project folder no longer exists")
    return check_folder(real)


def project_for_directory(directory: Optional[str]) -> Optional[dict]:
    """The listed project whose folder is exactly `directory`, or None."""
    if not directory:
        return None
    try:
        real = Path(directory).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    with _session() as db:
        row = db.query(CodeProject).filter_by(path_hash=_path_hash(real)).first()
        return _info(row) if row else None


def touch(project_id: str) -> None:
    """Mark a project as just used (it moves to the top of the list)."""
    with _session() as db:
        db.query(CodeProject).filter_by(id=_check_id(project_id)).update(
            {CodeProject.last_opened_at: func.current_timestamp()}
        )
        db.commit()


def _git_init(path: Path) -> None:
    """Make a new project its own git repository, when git is installed.

    The coding agent keeps "always allow" approvals per repository, so this
    keeps them from applying to other projects; git also lets the agent show
    what it changed. Not having git is fine.
    """
    git = shutil.which("git")
    if not git:
        return
    try:
        subprocess.run([git, "init", "-q"], cwd=path, check=True, timeout=15,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning("git init failed for project %s: %s", path.name, e)

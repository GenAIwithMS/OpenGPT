"""Find local model servers (Settings > Developer > Find local models).

For each known local server (Ollama, LM Studio, llama.cpp, Jan) this checks:

- whether it answers on its usual port, and which models it offers;
- which models are downloaded in that app's own model folder;
- whether the app is installed (its command is on the PATH, or its folder exists).

From that it reports one status per server, with a message saying what to
do next: "running", "needs_key", "stopped" (models downloaded, server not
started), "empty" (running or installed, no models) or "installed".

The folder and PATH checks only read names and sizes in each app's own model
folder: no disk-wide search, and model files are never opened. They run only
while the API is bound to this computer (HOST is local), so nobody on the
network can list what's on the machine.

We never start a server; the message says how.
"""
import json
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.security import is_local_host

PROBE_TIMEOUT = httpx.Timeout(1.5)
MAX_MODELS = 200           # per server, in the answer
MAX_ENTRIES = 5000         # files and folders looked at per model folder
MAX_MANIFEST_BYTES = 1_000_000
LOCAL_URL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_SPLIT_PART = re.compile(r"-\d{5}-of-\d{5}$")

SERVERS = [
    {"preset": "ollama", "name": "Ollama", "port": 11434, "commands": ["ollama"],
     "start": "ollama serve", "start_text": "Start Ollama (open the app, or run the command below)",
     "pull": "ollama pull <model>"},
    {"preset": "lmstudio", "name": "LM Studio", "port": 1234, "commands": ["lms"],
     "start": "lms server start",
     "start_text": "Start LM Studio's server (Developer tab > Start server, or run the command below)",
     "pull": "lms get <model>"},
    {"preset": "llamacpp", "name": "llama.cpp", "port": 8080, "commands": ["llama-server"],
     "start": "llama-server -m <model.gguf> --jinja",
     "start_text": "Start llama-server with your model (--jinja turns on tool calling)",
     "pull": None},
    {"preset": "jan", "name": "Jan", "port": 1337, "commands": [],
     "start": None, "start_text": "Open Jan and turn on its Local API Server (Settings > Local API Server)",
     "pull": None},
]
_BY_PRESET = {s["preset"]: s for s in SERVERS}


def disk_check_allowed() -> bool:
    return is_local_host(os.getenv("HOST", "127.0.0.1"))


def _port(server: dict) -> int:
    """The server's port; Ollama's can be changed with OLLAMA_HOST."""
    if server["preset"] == "ollama":
        host = (os.getenv("OLLAMA_HOST") or "").strip()
        if host:
            parsed = urlparse(host if "://" in host else f"http://{host}")
            try:
                if parsed.port:
                    return parsed.port
            except ValueError:
                pass
    return server["port"]


def base_url(server: dict) -> str:
    return f"http://localhost:{_port(server)}/v1"


# ---------------------------------------------------------------- the port

def _probe(server: dict) -> dict:
    """{reachable, needs_key, models} from GET /v1/models on 127.0.0.1."""
    url = f"http://127.0.0.1:{_port(server)}/v1/models"
    try:
        r = httpx.get(url, timeout=PROBE_TIMEOUT)
    except httpx.HTTPError:
        return {"reachable": False, "needs_key": False, "models": []}
    if r.status_code in (401, 403):
        return {"reachable": True, "needs_key": True, "models": []}
    try:
        body = r.json() if r.status_code < 400 else {}
    except ValueError:
        body = {}
    items = body.get("data") if isinstance(body, dict) else None
    names = sorted({str(m.get("id")) for m in (items or []) if isinstance(m, dict) and m.get("id")})
    return {"reachable": True, "needs_key": False, "models": names[:MAX_MODELS]}


# ---------------------------------------------------------------- the disk

def _home() -> Path:
    return Path.home()


def _env_path(name: str) -> list[Path]:
    value = (os.getenv(name) or "").strip()
    return [Path(value).expanduser()] if value else []


def _folders(preset: str) -> list[Path]:
    """Each app's own model folders, most specific first."""
    home = _home()
    appdata = _env_path("APPDATA")
    if preset == "ollama":
        return [*_env_path("OLLAMA_MODELS"), home / ".ollama" / "models",
                Path("/usr/share/ollama/.ollama/models"), Path("/var/lib/ollama/.ollama/models")]
    if preset == "lmstudio":
        return [home / ".lmstudio" / "models", home / ".cache" / "lm-studio" / "models"]
    if preset == "llamacpp":
        cache = _env_path("LLAMA_CACHE")
        return cache + [home / ".cache" / "llama.cpp", home / "Library" / "Caches" / "llama.cpp"]
    if preset == "jan":
        return [home / ".local" / "share" / "Jan" / "data" / "llamacpp" / "models",
                home / "Library" / "Application Support" / "Jan" / "data" / "llamacpp" / "models",
                *[a / "Jan" / "data" / "llamacpp" / "models" for a in appdata],
                home / "jan" / "models"]
    return []


def _walk(root: Path, max_depth: int):
    """(path, depth) for files under root, depth-limited and capped. Doesn't follow links to folders."""
    seen = 0
    stack = [(root, 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > MAX_ENTRIES:
                return
            try:
                if entry.is_dir(follow_symlinks=False):
                    if depth < max_depth:
                        stack.append((Path(entry.path), depth + 1))
                elif entry.is_file():
                    yield Path(entry.path)
            except OSError:
                continue


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _ollama_models(root: Path) -> dict[str, int]:
    """manifests/<registry>/<namespace>/<model>/<tag> → "model:tag", with the size of its layers."""
    manifests = root / "manifests"
    models: dict[str, int] = {}
    for path in _walk(manifests, 4):
        parts = path.relative_to(manifests).parts
        if len(parts) != 4:
            continue
        registry, namespace, model, tag = parts
        if registry == "registry.ollama.ai":
            name = f"{model}:{tag}" if namespace == "library" else f"{namespace}/{model}:{tag}"
        else:
            name = f"{registry}/{namespace}/{model}:{tag}"
        size = 0
        if _size(path) <= MAX_MANIFEST_BYTES:
            try:
                layers = json.loads(path.read_text(encoding="utf-8")).get("layers") or []
                size = sum(int(layer.get("size") or 0) for layer in layers if isinstance(layer, dict))
            except (OSError, ValueError, TypeError, AttributeError):
                size = 0
        models[name] = size
    return models


def _weights_models(root: Path, depth: int, name_parts: Optional[int]) -> dict[str, int]:
    """Models stored as .gguf / .safetensors files. A model's name is the first
    `name_parts` folders under root ("publisher/repo"), or the file name when None."""
    models: dict[str, int] = {}
    for path in _walk(root, depth):
        suffix = path.suffix.lower()
        if suffix not in (".gguf", ".safetensors") or path.name.lower().startswith("mmproj"):
            continue
        parts = path.relative_to(root).parts
        if name_parts is None or len(parts) <= name_parts:
            name = _SPLIT_PART.sub("", path.stem)   # model-00001-of-00003 -> model
        else:
            name = "/".join(parts[:name_parts])
        models[name] = models.get(name, 0) + _size(path)
    return models


def downloaded(preset: str) -> list[dict]:
    """[{name, size}] for the models in that app's own folders."""
    found: dict[str, int] = {}
    for root in _folders(preset):
        try:
            if not root.is_dir():
                continue
        except OSError:
            continue
        if preset == "ollama":
            models = _ollama_models(root)
        elif preset == "lmstudio":
            models = _weights_models(root, 3, 2)
        elif preset == "jan":
            models = _weights_models(root, 3, 1)
        else:
            models = _weights_models(root, 1, None)
        for name, size in models.items():
            found.setdefault(name, size)
    return [{"name": n, "size": s} for n, s in sorted(found.items())][:MAX_MODELS]


def installed(server: dict) -> bool:
    if any(shutil.which(c) for c in server["commands"]):
        return True
    return any(_exists(f) for f in _folders(server["preset"])[:2])


def _exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


# ---------------------------------------------------------------- the report

def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _report(server: dict, probe: dict, on_disk: list[dict], is_installed: bool) -> Optional[dict]:
    name = server["name"]
    port = _port(server)
    result = {"preset": server["preset"], "name": name, "base_url": base_url(server),
              "models": probe["models"], "downloaded": on_disk, "command": None}
    if probe["reachable"] and probe["needs_key"]:
        result.update(status="needs_key",
                      message=f"{name} is running on port {port} but asks for an API key. "
                              f"Copy the key from {name}'s settings and add it as a provider.")
    elif probe["reachable"] and probe["models"]:
        result.update(status="running",
                      message=f"{name} is running on port {port} with {_plural(len(probe['models']), 'model')}.")
    elif probe["reachable"]:
        result.update(status="empty", command=server["pull"],
                      message=f"{name} is running on port {port} but has no models. "
                              + ("Download one with the command below, then search again."
                                 if server["pull"] else f"Load a model in {name}, then search again."))
    elif on_disk:
        shown = ", ".join(m["name"] for m in on_disk[:3]) + (", …" if len(on_disk) > 3 else "")
        result.update(status="stopped", command=server["start"],
                      message=f"You have {_plural(len(on_disk), 'model')} downloaded for {name} ({shown}), "
                              f"but {name} isn't running. {server['start_text']}, then search again.")
    elif is_installed:
        result.update(status="installed", command=server["pull"] or server["start"],
                      message=f"{name} is installed but not running, and no downloaded models were found. "
                              + ("Download a model with the command below, start it, then search again."
                                 if server["pull"] else f"Download a model in {name} and start it, then search again."))
    else:
        return None
    return result


def find() -> dict:
    """{servers: [...], disk_checked}. Servers that weren't found are left out."""
    disk_checked = disk_check_allowed()
    with ThreadPoolExecutor(max_workers=len(SERVERS)) as pool:
        probes = list(pool.map(_probe, SERVERS))
    servers = []
    for server, probe in zip(SERVERS, probes):
        on_disk = downloaded(server["preset"]) if disk_checked else []
        is_installed = installed(server) if disk_checked else False
        report = _report(server, probe, on_disk, is_installed)
        if report:
            servers.append(report)
    return {"servers": servers, "disk_checked": disk_checked}


def unreachable_message(url: str) -> Optional[str]:
    """For a failed connection to a known local server's port: what to do, or None."""
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in LOCAL_URL_HOSTS:
        return None
    server = next((s for s in SERVERS if _port(s) == parsed.port), None)
    if server is None:
        return f"Nothing is answering on {parsed.netloc}. Start the model server there and try again."
    name = server["name"]
    on_disk = downloaded(server["preset"]) if disk_check_allowed() else []
    how = f" ({server['start']})" if server["start"] else ""
    if on_disk:
        return (f"{name} isn't running on port {parsed.port}. You have "
                f"{_plural(len(on_disk), 'model')} downloaded: start {name}{how} and try again.")
    return f"{name} isn't running on port {parsed.port}. Start it{how} and try again."

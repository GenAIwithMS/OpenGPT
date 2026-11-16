"""Starts, watches and stops the coding agent service.

The backend starts the agent (a Bun program in coding-agent/) as a child
process bound to 127.0.0.1, with a random password made for this run, and
stops it on shutdown. With CODING_AGENT_URL set it connects to an agent you
started yourself instead.

The agent gets a minimal environment: no backend secrets (database password,
tool API keys) are passed on, because commands the agent runs inherit it.
If the agent can't start (Bun missing, dependencies not installed), the chat
keeps working and the status says why.
"""
import json
import logging
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

from app.services.coding_agent import config

logger = logging.getLogger(__name__)

LOG_DIR = Path(__file__).resolve().parents[2] / "storage" / "coding-agent"

# Status values
DISABLED = "disabled"
STARTING = "starting"
RUNNING = "running"
UNAVAILABLE = "unavailable"
STOPPED = "stopped"

# Environment passed to the agent: only what a program needs to run.
_ENV_ALLOW = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    # Windows
    "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA",
    "LOCALAPPDATA", "PROGRAMDATA", "ProgramData", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
}
_ENV_ALLOW_PREFIXES = ("LC_", "XDG_")

# Agent options that keep it private and predictable.
_AGENT_FLAGS = {
    # Don't reach out to the online model catalog; our model is in the config.
    "OPENGPT_DISABLE_MODELS_FETCH": "1",
    # No hosted free models: only the model from LLM_* is available.
    "OPENGPT_DISABLE_FREE_MODELS": "1",
    # A project folder can't change the agent's settings or permissions.
    "OPENGPT_DISABLE_PROJECT_CONFIG": "1",
    "OPENGPT_DISABLE_CLAUDE_CODE": "1",
    # Files outside the session's project folder count as outside, even when
    # the folder sits inside a larger git repository (e.g. the default
    # backend/app/storage/code, inside the OpenGPT repository).
    "OPENGPT_STRICT_LOCATION": "1",
}


@dataclass
class Status:
    state: str
    detail: str = ""
    url: Optional[str] = None
    model: Optional[str] = None
    managed: bool = False

    def public(self) -> dict:
        """What the API reports. No URL or password."""
        return {
            "state": self.state,
            "available": self.state == RUNNING,
            "detail": self.detail,
            "model": self.model,
        }


def find_bun() -> Optional[str]:
    custom = (os.getenv("BUN_PATH") or "").strip()
    if custom:
        return custom if Path(custom).expanduser().is_file() else None
    found = shutil.which("bun")
    if found:
        return found
    default = Path.home() / ".bun" / "bin" / ("bun.exe" if os.name == "nt" else "bun")
    return str(default) if default.is_file() else None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def child_env(password: str, config_json: str) -> dict:
    env = {
        k: v for k, v in os.environ.items()
        if k in _ENV_ALLOW or k.startswith(_ENV_ALLOW_PREFIXES)
    }
    env.update(_AGENT_FLAGS)
    env["OPENGPT_PASSWORD"] = password
    env["OPENGPT_CONFIG_CONTENT"] = config_json
    return env


def _die_with_parent():
    """Linux: stop the agent if the backend process dies without cleaning up."""
    try:
        import ctypes

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


class CodingAgent:
    """One agent per backend process."""

    def __init__(self):
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._log_file = None
        self._password: Optional[str] = None
        self._status = Status(DISABLED, "The coding agent is turned off.")

    # ----- public -----

    @property
    def status(self) -> Status:
        with self._lock:
            # Notice an agent that exited on its own.
            if self._process is not None and self._process.poll() is not None:
                code = self._process.returncode
                self._process = None
                self._status = Status(
                    UNAVAILABLE, f"The coding agent stopped unexpectedly (exit code {code})."
                )
                logger.error("Coding agent exited with code %s; see %s", code, LOG_DIR / "agent.log")
            return self._status

    @property
    def base_url(self) -> Optional[str]:
        return self.status.url if self.status.state == RUNNING else None

    @property
    def auth(self) -> Optional[tuple[str, str]]:
        return (config.AGENT_USER, self._password) if self._password else None

    def start(self) -> None:
        """Start (or connect to) the agent. Returns at once; startup continues in the background."""
        if not config.enabled():
            self._set(Status(DISABLED, "The coding agent is turned off (CODING_AGENT_ENABLED)."))
            return

        url = config.external_url()
        if url:
            self._password = config.external_password()
            if not self._password:
                self._set(Status(UNAVAILABLE, "CODING_AGENT_URL is set but CODING_AGENT_PASSWORD is not."))
                return
            self._set(Status(STARTING, "Connecting to the coding agent.", url=url))
            threading.Thread(target=self._wait_ready, args=(url, None), daemon=True).start()
            return

        problem = self._check_install()
        if problem:
            self._set(Status(UNAVAILABLE, problem))
            logger.warning("Coding agent not started: %s", problem)
            return

        try:
            config_json = config.model_config_json()
        except Exception as e:  # LLM settings are validated at startup; be safe anyway
            self._set(Status(UNAVAILABLE, f"Model settings are not usable: {e}"))
            return

        port = config.port() or _free_port()
        url = f"http://127.0.0.1:{port}"
        self._password = secrets.token_urlsafe(32)
        cli_dir = config.agent_dir() / "packages" / "cli"
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._log_file = open(LOG_DIR / "agent.log", "ab")
        try:
            process = subprocess.Popen(
                [find_bun(), "run", "src/serve-main.ts", "--hostname", "127.0.0.1", "--port", str(port)],
                cwd=cli_dir,
                env=child_env(self._password, config_json),
                stdin=subprocess.DEVNULL,
                stdout=self._log_file,
                stderr=subprocess.STDOUT,
                preexec_fn=_die_with_parent if sys.platform.startswith("linux") else None,
            )
        except OSError as e:
            self._close_log()
            self._set(Status(UNAVAILABLE, f"Could not start the coding agent: {e}"))
            logger.error("Could not start the coding agent: %s", e)
            return

        with self._lock:
            self._process = process
            self._status = Status(STARTING, "The coding agent is starting.", url=url, managed=True)
        logger.info("Starting the coding agent on %s (log: %s)", url, LOG_DIR / "agent.log")
        threading.Thread(target=self._wait_ready, args=(url, process), daemon=True).start()

    def restart(self) -> bool:
        """Restart the agent the backend started, so it reads its config again
        (e.g. after connectors change). An agent started by hand is left alone."""
        if config.external_url() or not config.enabled():
            return False
        with self._lock:
            managed = self._process is not None or self._status.state in (RUNNING, STARTING)
        if not managed:
            return False
        logger.info("Restarting the coding agent to apply new settings")
        self.stop()
        self.start()
        return True

    def stop(self) -> None:
        with self._lock:
            process, self._process = self._process, None
            if self._status.state in (RUNNING, STARTING):
                self._status = Status(STOPPED, "The coding agent was stopped.")
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            logger.info("Coding agent stopped")
        self._close_log()

    # ----- internal -----

    def _set(self, status: Status) -> None:
        with self._lock:
            self._status = status

    def _close_log(self) -> None:
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    @staticmethod
    def _check_install() -> Optional[str]:
        if not find_bun():
            return "Bun is not installed (https://bun.sh), or set BUN_PATH."
        root = config.agent_dir()
        if not (root / "packages" / "cli" / "src" / "serve-main.ts").is_file():
            return f"The coding agent was not found in {root} (CODING_AGENT_DIR)."
        if not (root / "node_modules").is_dir():
            return "The coding agent's dependencies are not installed: run `bun install` in coding-agent/."
        return None

    def _wait_ready(self, url: str, process: Optional[subprocess.Popen]) -> None:
        deadline = time.monotonic() + config.start_timeout()
        with httpx.Client(auth=self.auth, timeout=5) as client:
            while time.monotonic() < deadline:
                if process is not None and process.poll() is not None:
                    return  # `status` reports the exit
                try:
                    info = client.get(f"{url}/api/info")
                    if info.status_code == 401:
                        self._set(Status(UNAVAILABLE, "The coding agent rejected the password.", url=url))
                        return
                    if info.status_code == 200:
                        provider, model = self._default_model(client, url)
                        if provider is None:
                            time.sleep(0.5)  # still loading its model list
                            continue
                        if provider != config.PROVIDER_ID:
                            # Never fall back to some other model silently.
                            self._set(Status(UNAVAILABLE, "The coding agent is not using the model from LLM_* settings.", url=url))
                            logger.error("Coding agent default model is %s/%s, not the configured one", provider, model)
                            if process is not None:
                                self.stop()
                                self._set(Status(UNAVAILABLE, "The coding agent is not using the model from LLM_* settings."))
                            return
                        self._set(Status(RUNNING, "The coding agent is ready.", url=url, model=model,
                                         managed=process is not None))
                        logger.info("Coding agent ready (model: %s)", model)
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(0.5)
        self._set(Status(UNAVAILABLE, "The coding agent did not start in time.", url=url))
        logger.error("Coding agent did not answer within %ss; see %s", config.start_timeout(), LOG_DIR / "agent.log")
        if process is not None:
            self.stop()
            self._set(Status(UNAVAILABLE, "The coding agent did not start in time."))

    @staticmethod
    def _default_model(client: httpx.Client, url: str) -> tuple[Optional[str], Optional[str]]:
        """(provider id, model id) of the agent's default model."""
        try:
            # The first call loads the agent's model list, which can take a while.
            data = client.get(f"{url}/api/model/default", timeout=30).json().get("data") or {}
            return data.get("providerID"), data.get("id")
        except (httpx.HTTPError, json.JSONDecodeError, AttributeError):
            return None, None


agent = CodingAgent()

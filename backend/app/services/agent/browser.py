"""The agent's browser: website tools built and run by the browser engine.

* ``Browser_task`` builds a tool for a task on one website (the engine's "mint"):
  a read tool is then run and returns what it found; a write tool makes its
  change once while it is built. Every write asks the user first, and a site
  is used only with the user's permission (read, or read and change).
* ``Browser_tools`` lists saved tools; ``Run_browser_tool`` runs one again
  with no model (writes ask first each time).

The engine asks questions while it works: a login, a one-time code, a choice.
The session then waits; the Agent page shows the questions, and the answers go
straight to the engine through ``answer_input``. They are kept in memory only:
never in the database, the session's events or checkpoint, or a model's
context. Website logins are typed by the engine only on that site.

Saved tools live in ``app/storage/browser/integrations/<name>/``.
"""
import json
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import urlsplit

from langchain_core.tools import tool
from langgraph.config import get_config

from app.database.config import DatabaseConfig
from app.database.models import AppSetting
from app.exceptions import NotFoundError, ValidationError
from app.services import browser_engine, chat_approvals
from app.services.agent import store

STORAGE = Path(__file__).resolve().parents[2] / "storage" / "browser"
INTEGRATIONS = STORAGE / "integrations"
SITES_KEY = "browser_sites"
ACCESS = ("read", "write")
POLL_SECONDS = 20
MAX_RESULT_CHARS = 20_000
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


# ---------------------------------------------------------------- site permissions

def origin_of(url: str) -> str:
    parts = urlsplit(str(url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValidationError("Website: use an http:// or https:// address")
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname.lower()}{port}"


def _session():
    return DatabaseConfig.get_session_factory()()


def list_sites() -> dict[str, str]:
    with _session() as db:
        row = db.get(AppSetting, SITES_KEY)
        try:
            sites = json.loads(row.value) if row else {}
        except (TypeError, ValueError):
            sites = {}
    return {o: a for o, a in sites.items() if a in ACCESS}


def set_site(url_or_origin: str, access: str) -> dict[str, str]:
    if access not in ACCESS:
        raise ValidationError("Access: read or write")
    origin = origin_of(url_or_origin)
    sites = {**list_sites(), origin: access}
    _save_sites(sites)
    return sites


def remove_site(url_or_origin: str) -> dict[str, str]:
    origin = origin_of(url_or_origin)
    sites = list_sites()
    if sites.pop(origin, None) is None:
        raise NotFoundError("That website isn't in the list")
    _save_sites(sites)
    return sites


def _save_sites(sites: dict[str, str]) -> None:
    with _session() as db:
        row = db.get(AppSetting, SITES_KEY)
        if row is None:
            db.add(AppSetting(key=SITES_KEY, value=json.dumps(sites)))
        else:
            row.value = json.dumps(sites)
        db.commit()


def _permit(origin: str, effect: str, task: str) -> Optional[str]:
    """Ask the user when needed. None when allowed, else what to tell the model."""
    allowed = list_sites().get(origin)
    if effect == "write":
        # Every write asks, and allowing it also lets the agent change things on the site.
        decision = chat_approvals.ask({
            "connector": "Browser", "connector_id": "browser",
            "tool": f"Make changes on {urlsplit(origin).hostname}",
            "description": "The agent will use this website in a browser and change something there once.",
            "arguments": task, "destructive": True,
        })
        if decision != "allow":
            return "The user did not allow this change. Don't try it again; ask what they would like instead."
        if allowed != "write":
            set_site(origin, "write")
        return None
    if allowed is None:
        decision = chat_approvals.ask({
            "connector": "Browser", "connector_id": "browser",
            "tool": f"Use {urlsplit(origin).hostname}",
            "description": "The agent will open this website in a browser and read from it. "
                           "Allowing it lets the agent read this site in later tasks too.",
            "arguments": task, "destructive": False,
        })
        if decision != "allow":
            return "The user did not allow using this website."
        set_site(origin, "read")
    return None


# ---------------------------------------------------------------- questions from the engine

_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()
_cancelled: set[str] = set()

# Fields of a question safe to store and show (never an expected username or any value).
_QUESTION_FIELDS = ("id", "type", "prompt", "options", "minSelections", "maxSelections", "allowOther",
                    "allowNote", "maxLength", "secretKind", "fields", "reason", "siteOrigin",
                    "allowDecline", "allowPasswordless")


def public_request(request: dict) -> dict:
    return {
        "request_id": request.get("id"),
        "notice": request.get("notice"),
        "questions": [{k: q[k] for k in _QUESTION_FIELDS if k in q} for q in request.get("questions", [])],
        "expires_at": request.get("expires_at"),
    }


def _wait_for_answers(session_id: str, request: dict, stopped) -> Optional[dict]:
    """Show the engine's questions and wait for the answers (None: stopped or expired)."""
    shown = public_request(request)
    entry = {"event": threading.Event(), "answers": None, "request_id": request["id"]}
    with _pending_lock:
        _pending[session_id] = entry
        _cancelled.discard(session_id)
    store.update(session_id, status="waiting", waiting={"kind": "browser_input", **shown})
    store.add_event(session_id, "browser_input", shown)
    deadline = _expiry(request.get("expires_at"))
    try:
        while not entry["event"].wait(1):
            if stopped() or session_id in _cancelled or time.time() > deadline:
                return None
    finally:
        with _pending_lock:
            _pending.pop(session_id, None)
    store.update(session_id, status="running", waiting=None)
    store.add_event(session_id, "browser_input_done", {"request_id": request["id"]})
    return entry["answers"]


def _expiry(text: Optional[str]) -> float:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return time.time() + 30 * 60


def answer_input(session_id: str, request_id: str, answers: dict) -> None:
    """The user's answers to the engine's questions; they go to the engine and nowhere else."""
    if not isinstance(answers, dict) or not answers:
        raise ValidationError("Answers: fill in the questions")
    with _pending_lock:
        entry = _pending.get(session_id)
        if entry is None or entry["request_id"] != request_id:
            raise ValidationError("These questions are no longer open. Reload the page.")
        entry["answers"] = answers
    entry["event"].set()


def cancel_input(session_id: str) -> None:
    with _pending_lock:
        _cancelled.add(session_id)


def waiting_for_input(session_id: str) -> bool:
    with _pending_lock:
        return session_id in _pending


# ---------------------------------------------------------------- running the engine

def _follow(client: browser_engine.EngineClient, view: dict, session_id: str, stopped) -> dict:
    """Follow a job until it finishes, answering its questions. Returns the last view."""
    while isinstance(view, dict) and view.get("job_id") and view.get("status") in ("running", "input_required"):
        if stopped():
            client.call("cancel_job", {"job_id": view["job_id"]}, timeout=120)
            return {"status": "cancelled"}
        if view["status"] == "input_required":
            request = view["pending_input"]
            answers = _wait_for_answers(session_id, request, stopped)
            if answers is None:
                client.call("cancel_job", {"job_id": view["job_id"]}, timeout=120)
                return {"status": "cancelled"}
            view = client.call("provide_input", {"job_id": view["job_id"], "request_id": request["id"],
                                                 "answers": answers}, timeout=120)
            continue
        view = client.call("get_job", {"job_id": view["job_id"], "wait_seconds": POLL_SECONDS},
                           timeout=POLL_SECONDS + 60)
    return view


def _text(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1)
    return text if len(text) <= MAX_RESULT_CHARS else text[:MAX_RESULT_CHARS] + "\n… (cut)"


def _failure(view: dict) -> str:
    if view.get("status") == "cancelled":
        return "Stopped before it finished."
    detail = view.get("error") or view.get("text") or view.get("summary") or "the browser engine failed"
    note = " It may already have changed the website: check before trying again." if view.get("possible_commit") else ""
    return f"Couldn't finish in the browser: {str(detail)[:500]}.{note}"


def _session_id() -> str:
    return (get_config().get("configurable") or {}).get("agent_session", "")


def _stopped(session_id: str):
    from app.services.agent import runner
    return lambda: runner.stop_requested(session_id)


def tool_name(task: str) -> str:
    words = re.findall(r"[a-z0-9]+", task.lower())[:6]
    base = "_".join(words) or "website_tool"
    base = ("t_" + base if not base[0].isalpha() else base)[:40].rstrip("_")
    name, n = base, 2
    while (INTEGRATIONS / name).exists():
        name, n = f"{base}_{n}", n + 1
    return name


def saved_tools() -> list[dict]:
    tools = []
    for folder in sorted(INTEGRATIONS.glob("*/deployment.json")) if INTEGRATIONS.exists() else []:
        try:
            deployment = json.loads(folder.read_text())
            meta = json.loads((folder.parent / "integration.json").read_text())
        except (OSError, ValueError):
            continue
        request = deployment.get("request", {})
        tools.append({"name": deployment.get("name", folder.parent.name),
                      "description": deployment.get("description", ""),
                      "url": request.get("url"), "effect": request.get("effect"),
                      "task": request.get("intent"), "input_schema": meta.get("inputSchema")})
    return tools


def delete_tool(name: str) -> None:
    if not _NAME_RE.match(name or "") or not (INTEGRATIONS / name).is_dir():
        raise NotFoundError("Website tool not found")
    shutil.rmtree(INTEGRATIONS / name)


def _run_saved(name: str, tool_input: Any, session_id: str) -> str:
    client = browser_engine.EngineClient(["serve", "--artifact", str(INTEGRATIONS / name)])
    try:
        view = client.call(name, {"input": tool_input if tool_input is not None else {}}, timeout=600)
        if isinstance(view, dict) and view.get("job_id") and view.get("status") in ("running", "input_required"):
            view = _follow(client, view, session_id, _stopped(session_id))
            if view.get("status") != "completed":
                return _failure(view)
            view = view.get("output")
        elif isinstance(view, dict) and view.get("is_error"):
            return _failure(view)
        return _text(view)
    finally:
        client.close()


@tool
def Browser_task(url: str, task: str, effect: Literal["read", "write"] = "read",
                 input: Optional[dict] = None) -> str:
    """Use a website in a browser, for a site you have no connector for. It builds a reusable tool
    for the task on that site (this takes minutes) and returns what it found, or makes the change
    once for effect "write". Describe the task fully, e.g. "Read the opening hours on the contact
    page" or "Book a table for 2 at 19:00 on Friday". Give example values in input. The user is
    asked before the site is used and before any change. Logins and codes are asked from the
    user; never ask for them yourself."""
    session_id = _session_id()
    reason = browser_engine.unavailable_reason()
    if reason:
        return f"The browser isn't available: {reason}"
    try:
        origin = origin_of(url)
    except ValidationError as e:
        return str(e)
    refused = _permit(origin, effect, task + (f"\nInput: {json.dumps(input)}" if input else ""))
    if refused:
        return refused

    INTEGRATIONS.mkdir(parents=True, exist_ok=True)
    name = tool_name(task)
    stopped = _stopped(session_id)
    client = browser_engine.EngineClient(["mint", "--root", str(INTEGRATIONS)])
    try:
        arguments = {"name": name, "url": url, "intent": task, "effect": effect}
        if input:
            arguments["input"] = input
        view = _follow(client, client.call("mint", arguments, timeout=120), session_id, stopped)
    except browser_engine.EngineError as e:
        return f"Couldn't use the browser: {e}"
    finally:
        client.close()
    if view.get("status") != "completed":
        return _failure(view)
    output = view.get("output") or {}
    if not output.get("integration"):
        return f"The website tool wasn't built: {str(output.get('summary') or 'no reason given')[:800]}"
    if effect == "write":
        return f"Done on {origin}: the change was made once while building the tool \"{name}\". " \
               f"Saved as \"{name}\" to repeat it later (Run_browser_tool)."
    try:
        result = _run_saved(name, input, session_id)
    except browser_engine.EngineError as e:
        return f"Built the tool \"{name}\", but running it failed: {e}"
    return f"Result from {origin} (saved as tool \"{name}\"):\n{result}"


@tool
def Browser_tools() -> str:
    """List the website tools built before, which run again quickly with no model."""
    tools = saved_tools()
    if not tools:
        return "No website tools yet."
    return _text([{k: t[k] for k in ("name", "description", "url", "effect", "input_schema")} for t in tools])


@tool
def Run_browser_tool(name: str, input: Optional[dict] = None) -> str:
    """Run a saved website tool by name with its input (see Browser_tools). A write asks the user first."""
    session_id = _session_id()
    reason = browser_engine.unavailable_reason()
    if reason:
        return f"The browser isn't available: {reason}"
    found = next((t for t in saved_tools() if t["name"] == name), None)
    if found is None:
        return f"There is no website tool named {name}. Call Browser_tools to see them."
    refused = _permit(origin_of(found["url"]), found["effect"], f"{found['task']}\nInput: {json.dumps(input or {})}")
    if refused:
        return refused
    try:
        return _run_saved(name, input, session_id)
    except browser_engine.EngineError as e:
        return f"Couldn't run {name}: {e}"


TOOLS = [Browser_task, Browser_tools, Run_browser_tool]

PROMPT = (
    "Browser: Browser_task uses a website in a browser for sites you have no connector for. "
    "It takes minutes and builds a reusable tool; check Browser_tools first and use "
    "Run_browser_tool when one fits. The user is asked before a site is used and before "
    "any change; logins are asked from the user by the browser, never by you."
)

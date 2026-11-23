"""A stand-in for the browser engine's MCP mode, for tests (no Node, Chromium or model).

mint mode: ``mint`` starts a job; the first ``get_job`` asks for a website login; after
``provide_input`` the job completes and writes a saved tool folder. serve mode: the tool
returns a fixed result. Everything it receives is appended to FAKE_ENGINE_LOG.
"""
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
log = Path(os.environ["FAKE_ENGINE_LOG"])
state = {"asked": False, "answered": False, "name": None, "effect": "read"}
REQUEST_ID = "6f1b8c1e-1111-4111-8111-111111111111"


def record(entry):
    with log.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def reply(message_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message_id, "result": result}) + "\n")
    sys.stdout.flush()


def tool_result(value, error=False):
    return {"content": [{"type": "text", "text": json.dumps(value)}], "structuredContent": value,
            **({"isError": True} if error else {})}


def job_view():
    if not state["asked"]:
        state["asked"] = True
        return {"job_id": "job-1", "status": "input_required", "pending_input": {
            "id": REQUEST_ID, "source": "kernel_auth", "expires_at": "2999-01-01T00:00:00Z",
            "questions": [{"id": "login", "type": "credential", "prompt": "Log in to example.com",
                           "fields": "username_password", "reason": "missing_credentials",
                           "allowSave": False, "siteOrigin": "https://example.com",
                           "username": "expected-user"}]}}
    if state["answered"]:
        root = Path(args[args.index("--root") + 1])
        folder = root / state["name"]
        folder.mkdir(parents=True)
        (folder / "deployment.json").write_text(json.dumps({
            "name": state["name"], "description": "Reads the heading",
            "request": {"url": "https://example.com", "intent": "Read the heading", "effect": state["effect"]}}))
        (folder / "integration.json").write_text(json.dumps({"inputSchema": {"type": "object"}}))
        return {"job_id": "job-1", "status": "completed",
                "output": {"build": "published", "integration": {"directory": str(folder)}}}
    return {"job_id": "job-1", "status": "running"}


for line in sys.stdin:
    message = json.loads(line)
    method, params = message.get("method"), message.get("params") or {}
    if "id" not in message:
        continue
    if method == "initialize":
        reply(message["id"], {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                              "serverInfo": {"name": "fake", "version": "1"}})
        continue
    name, arguments = params.get("name"), params.get("arguments") or {}
    record({"mode": args[0], "tool": name, "arguments": arguments, "argv": args})
    if args[0] == "serve":
        reply(message["id"], tool_result({"heading": "Example Domain"}))
    elif name == "mint":
        state["name"], state["effect"] = arguments["name"], arguments["effect"]
        reply(message["id"], tool_result({"job_id": "job-1", "status": "running"}))
    elif name == "get_job":
        reply(message["id"], tool_result(job_view()))
    elif name == "provide_input":
        state["answered"] = True
        reply(message["id"], tool_result({"job_id": "job-1", "status": "running"}))
    elif name == "cancel_job":
        reply(message["id"], tool_result({"job_id": "job-1", "status": "cancelled"}))

"""Coding sessions: routes against a fake agent, project checks, message conversion."""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, unquote, urlparse

from tests import _helpers
from app.services.coding_agent import client, process, projects, sessions

SID = "ses_abcdefghijklmnop"


class FakeAgentState:
    def __init__(self):
        self.sessions = {}
        self.messages = {}
        self.requests = []


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body=None):
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"null")

        def _record(self, body=None):
            url = urlparse(self.path)
            state.requests.append({
                "method": self.command, "path": url.path, "query": parse_qs(url.query),
                "directory": unquote(self.headers.get(client.DIRECTORY_HEADER) or ""),
                "auth": self.headers.get("Authorization"), "body": body,
            })
            return url.path

        def do_GET(self):
            path = self._record()
            if path == "/api/session":
                return self._send(200, {"data": list(state.sessions.values()), "cursor": {}})
            parts = path.split("/")
            if len(parts) == 4 and parts[3] in state.sessions:
                return self._send(200, {"data": state.sessions[parts[3]]})
            if len(parts) == 5 and parts[4] == "message" and parts[3] in state.sessions:
                return self._send(200, {"data": state.messages.get(parts[3], []), "cursor": {}})
            self._send(404, {"_tag": "SessionNotFoundError", "message": "secret detail"})

        def do_POST(self):
            body = self._body()
            path = self._record(body)
            if path == "/api/session":
                raw = {"id": SID, "title": body.get("title"), "location": body["location"],
                       "time": {"created": 1, "updated": 1}}
                state.sessions[SID] = raw
                return self._send(200, {"data": raw})
            self._send(404, {})

        def do_PATCH(self):
            body = self._body()
            path = self._record(body)
            sid = path.split("/")[3]
            state.sessions[sid]["title"] = body["title"]
            self._send(204)  # like the agent

        def do_DELETE(self):
            path = self._record()
            state.sessions.pop(path.split("/")[3], None)
            self._send(204)

    return Handler


class SessionRouteTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        env = mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": str(self.tmp / "projects"),
                                           "CODING_AGENT_MODEL": "coder-model"})
        env.start()
        self.addCleanup(env.stop)
        _helpers.use_sqlite()
        self.project = projects.create_project("app")
        self.project_dir = projects.project_path(self.project["id"])

        self.state = FakeAgentState()
        server = HTTPServer(("127.0.0.1", 0), make_handler(self.state))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        # Pretend the agent is running at the fake server.
        fake = process.CodingAgent()
        fake._password = "pw"
        fake._status = process.Status(process.RUNNING, url=f"http://127.0.0.1:{server.server_port}")
        patcher = mock.patch.object(client, "agent", fake)
        patcher.start()
        self.addCleanup(patcher.stop)

        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.code import code_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(code_router, prefix="/api")
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.addCleanup(lambda: self.client.portal.call(client.close))

    def test_create_sends_folder_model_and_rules(self):
        r = self.client.post("/api/code/sessions", json={"project": self.project["id"], "title": "Fix tests"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["project"], {"id": self.project["id"], "name": "app"})
        sent = self.state.requests[-1]
        self.assertEqual(sent["body"]["location"]["directory"], str(self.project_dir))
        self.assertEqual(sent["body"]["model"], {"providerID": "opengpt", "id": "coder-model"})
        self.assertEqual(sent["body"]["permissions"], sessions.PERMISSION_RULES)
        self.assertEqual(sent["directory"], str(self.project_dir))
        self.assertTrue(sent["auth"].startswith("Basic "))

    def test_unknown_project(self):
        import uuid
        r = self.client.post("/api/code/sessions", json={"project": str(uuid.uuid4())})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.post("/api/code/sessions", json={"project": "../x"}).status_code, 422)

    def test_list_rename_delete_and_messages(self):
        self.client.post("/api/code/sessions", json={"project": self.project["id"]})
        listed = self.client.get("/api/code/sessions", params={"project": self.project["id"]}).json()["sessions"]
        self.assertEqual([s["id"] for s in listed], [SID])
        self.assertEqual(listed[0]["title"], "New session")

        r = self.client.put(f"/api/code/sessions/{SID}/title", json={"title": "Renamed"})
        self.assertEqual(r.json()["title"], "Renamed")

        self.state.messages[SID] = [  # newest first, like the agent
            {"id": "m2", "type": "assistant", "time": {"created": 2},
             "content": [{"type": "text", "text": "It prints hello."}]},
            {"id": "m1", "type": "user", "time": {"created": 1}, "text": "What does it print?"},
        ]
        body = self.client.get(f"/api/code/sessions/{SID}/messages").json()
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant"])

        self.assertEqual(self.client.delete(f"/api/code/sessions/{SID}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/code/sessions/{SID}").status_code, 404)

    def test_session_outside_projects_is_not_found(self):
        outside = self.tmp / "elsewhere"
        outside.mkdir()
        self.state.sessions[SID] = {"id": SID, "location": {"directory": str(outside)}, "time": {}}
        for method, path in [("GET", f"/api/code/sessions/{SID}"),
                             ("GET", f"/api/code/sessions/{SID}/messages"),
                             ("DELETE", f"/api/code/sessions/{SID}")]:
            with self.subTest(path=path):
                self.assertEqual(self.client.request(method, path).status_code, 404)
        self.assertIn(SID, self.state.sessions)  # not deleted

    def test_bad_session_id_never_reaches_the_agent(self):
        before = len(self.state.requests)
        for sid in ["../../api/config", "ses_..", "abc", "ses_" + "a" * 100]:
            with self.subTest(sid=sid):
                self.assertIn(self.client.get(f"/api/code/sessions/{sid}").status_code, (404, 422))
        self.assertEqual(len(self.state.requests), before)

    def test_agent_errors_are_generic(self):
        r = self.client.get("/api/code/sessions/ses_missingmissing")
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("secret detail", r.text)

    def test_agent_not_running(self):
        stopped = process.CodingAgent()
        with mock.patch.object(client, "agent", stopped):
            r = self.client.get("/api/code/sessions", params={"project": self.project["id"]})
        self.assertEqual(r.status_code, 503)


class ConversionTests(unittest.TestCase):
    PROVIDER_ERROR = {
        "type": "provider.invalid-request", "status": 413,
        "message": "Request too large for model `x/y` in organization `org_SECRET123` on tokens per minute",
        "response": {"body": "upgrade at https://console.example-provider.com"},
    }

    def test_assistant_parts(self):
        m = sessions.convert_message({
            "id": "a", "type": "assistant", "time": {"created": 5},
            "content": [
                {"type": "reasoning", "text": "thinking"},
                {"type": "tool", "id": "t1", "name": "shell",
                 "state": {"status": "completed", "input": {"command": "ls"},
                           "content": [{"type": "text", "text": "app.py"}]}},
                {"type": "tool", "id": "t2", "name": "edit",
                 "state": {"status": "error", "input": {"path": "a.py"}, "error": {"message": "no such file"}}},
                {"type": "text", "text": "Done."},
            ],
        })
        self.assertEqual([p["type"] for p in m["parts"]], ["reasoning", "tool", "tool", "text"])
        self.assertEqual(m["parts"][1]["output"], "app.py")
        self.assertEqual(m["parts"][1]["input"], {"command": "ls"})
        self.assertEqual(m["parts"][2]["error"], "no such file")

    def test_provider_error_details_never_leak(self):
        m = sessions.convert_message({"id": "a", "type": "assistant", "time": {}, "content": [],
                                      "error": self.PROVIDER_ERROR})
        text = json.dumps(m)
        for secret in ("org_SECRET123", "example-provider", "x/y", "organization"):
            self.assertNotIn(secret, text)
        self.assertIn("larger than the model allows", m["error"])
        self.assertIn("ref ", m["error"])

    def test_error_kinds(self):
        cases = {401: "API key", 429: "rate limit", 503: "had an error", None: "request failed"}
        for status, expected in cases.items():
            with self.subTest(status=status):
                self.assertIn(expected, sessions.public_model_error({"status": status, "message": "x"}))

    def test_repeated_idle_error_is_dropped_and_bookkeeping_skipped(self):
        out = sessions.convert_messages([
            {"id": "u", "type": "user", "time": {}, "text": "hi"},
            {"id": "s", "type": "model-selected", "time": {}},
            {"id": "a", "type": "assistant", "time": {}, "content": [], "error": {"status": 429}},
            {"id": "i", "type": "idle", "time": {}, "outcome": "failed", "error": {"status": 429}},
        ])
        self.assertEqual([m["role"] for m in out], ["user", "assistant"])

    def test_shell_and_long_output(self):
        m = sessions.convert_message({"id": "s", "type": "shell", "time": {}, "command": "env",
                                      "output": {"output": "x" * (sessions.MAX_TEXT_CHARS + 10)}, "exit": 0})
        self.assertEqual(m["role"], "shell")
        self.assertIn("10 more characters", m["output"])


if __name__ == "__main__":
    unittest.main()

"""Approvals: request format, answering, saved "always" approvals (fake agent)."""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

from tests import _helpers
from app.services.coding_agent import approvals, client, process, projects

SID = "ses_approvalapproval"
PID = "per_aaaaaaaaaaaa"
SAVED = "psv_bbbbbbbbbbbb"


class ApprovalInfoTests(unittest.TestCase):
    def test_edit_with_diff(self):
        info = approvals.approval_info({
            "id": PID, "action": "edit", "resources": ["app.py"], "save": ["*"],
            "metadata": {"files": [{"file": "app.py", "status": "modified", "additions": 1, "deletions": 1,
                                    "patch": "-print(1)\n+print(2)"}]},
        })
        self.assertEqual(info["always"], "all file edits in this project")
        self.assertEqual(info["files"], [{"file": "app.py", "status": "modified", "additions": 1, "deletions": 1}])
        self.assertIn("+print(2)", info["diff"])

    def test_patch_diff_and_shell_summary(self):
        self.assertEqual(approvals.approval_info({"action": "edit", "metadata": {"diff": "+x"}})["diff"], "+x")
        self.assertEqual(approvals.always_summary("shell", ["git *", "npm test *"]),
                         "commands starting with `git`, `npm test`")
        self.assertEqual(approvals.always_summary("webfetch", ["https://docs.example/*"]),
                         "opening web pages matching `https://docs.example/*`")


class FakeAgent:
    def __init__(self, directory):
        self.directory = directory
        self.waiting = [{"id": PID, "sessionID": SID, "action": "shell", "resources": ["ls"], "save": ["ls *"]}]
        self.saved = [{"id": SAVED, "projectID": "proj1", "action": "shell", "resource": "git *", "time": {"created": 1}},
                      {"id": "psv_otherotherother", "projectID": "proj2", "action": "edit", "resource": "*", "time": {}}]
        self.replies = []
        self.deleted = []


def make_handler(agent):
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

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == f"/api/session/{SID}":
                return self._send(200, {"data": {"id": SID, "location": {"directory": str(agent.directory)}, "time": {}}})
            if path == f"/api/session/{SID}/permission":
                return self._send(200, {"data": agent.waiting})
            if path == "/api/location":
                return self._send(200, {"directory": str(agent.directory), "project": {"id": "proj1"}})
            if path == "/api/permission/saved":
                return self._send(200, {"data": agent.saved})
            self._send(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
            agent.replies.append((self.path, body))
            agent.waiting = []
            self._send(204)

        def do_DELETE(self):
            agent.deleted.append(self.path)
            self._send(204)

    return Handler


class ApprovalRouteTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": str(Path(tmp.name) / "projects")})
        env.start()
        self.addCleanup(env.stop)
        _helpers.use_sqlite()
        self.project = projects.create_project("app")
        self.agent = FakeAgent(projects.project_path(self.project["id"]))

        server = HTTPServer(("127.0.0.1", 0), make_handler(self.agent))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
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

    def test_pending_and_reply(self):
        pending = self.client.get(f"/api/code/sessions/{SID}/approvals").json()["approvals"]
        self.assertEqual(pending[0]["id"], PID)
        self.assertEqual(pending[0]["always"], "commands starting with `ls`")
        r = self.client.post(f"/api/code/sessions/{SID}/approvals/{PID}", json={"decision": "reject", "reason": "no"})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(self.agent.replies, [(f"/api/session/{SID}/permission/{PID}/reply",
                                               {"decision": "reject", "message": "no"})])

    def test_reply_checks(self):
        url = f"/api/code/sessions/{SID}/approvals"
        self.assertEqual(self.client.post(f"{url}/{PID}", json={"decision": "maybe"}).status_code, 422)
        self.assertEqual(self.client.post(f"{url}/not-an-id", json={"decision": "once"}).status_code, 422)
        self.assertEqual(self.client.post(f"{url}/per_unknownunknown", json={"decision": "once"}).status_code, 404)
        self.assertEqual(self.agent.replies, [])
        # A reason is only passed on with reject.
        self.client.post(f"{url}/{PID}", json={"decision": "always", "reason": "ignored"})
        self.assertEqual(self.agent.replies[0][1], {"decision": "always"})

    def test_saved_list_and_revoke(self):
        saved = self.client.get(f"/api/code/projects/{self.project['id']}/approvals").json()["approvals"]
        self.assertEqual([s["id"] for s in saved], [SAVED])  # other projects' approvals are hidden
        self.assertEqual(saved[0]["allows"], "commands starting with `git`")
        self.assertEqual(self.client.delete(f"/api/code/projects/{self.project['id']}/approvals/{SAVED}").status_code, 204)
        self.assertEqual(self.agent.deleted, [f"/api/permission/saved/{SAVED}"])

    def test_revoke_checks(self):
        base = f"/api/code/projects/{self.project['id']}/approvals"
        self.assertEqual(self.client.delete(f"{base}/psv_otherotherother").status_code, 404)  # another project's
        self.assertEqual(self.client.delete(f"{base}/../x").status_code, 404)
        self.assertEqual(self.client.delete(f"{base}/bad").status_code, 422)
        self.assertEqual(self.client.get("/api/code/projects/00000000-0000-0000-0000-000000000000/approvals").status_code, 404)
        self.assertEqual(self.agent.deleted, [])


if __name__ == "__main__":
    unittest.main()

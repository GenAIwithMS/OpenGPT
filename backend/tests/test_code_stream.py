"""Live coding turns: event relay, errors, stop, busy sessions (fake agent)."""
import json
import os
import queue
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from tests import _helpers
from app.services.coding_agent import client, process, projects, stream

SID = "ses_streamstreamstream"
OTHER = "ses_otherotherother"


def ev(kind, sid=SID, **data):
    return {"id": "evt", "type": kind, "data": {"sessionID": sid, **data}}


class FakeAgent:
    def __init__(self, directory):
        self.directory = directory
        self.script = []          # events sent after a prompt
        self.prompts = []
        self.entries = []          # instruction entries written (profile)
        self.interrupts = 0
        self.busy = False
        # One queue per open event stream; events go to all of them, like the
        # real agent (a finished turn's old stream must not swallow new events).
        self.streams = []
        self.lock = threading.Lock()

    def publish(self, item):
        with self.lock:
            for q in list(self.streams):
                q.put(item)

    def session(self):
        time = {"created": 1, "busy": 5, "idle": 1} if self.busy else {"created": 1, "busy": 1, "idle": 5}
        return {"id": SID, "title": "t", "location": {"directory": str(self.directory)}, "time": time}


def make_handler(agent):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/api/event"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                mine = queue.Queue()
                with agent.lock:
                    agent.streams.append(mine)
                try:
                    self.wfile.write(b'data: {"type":"server.connected","data":{}}\n\n: heartbeat\n\n')
                    self.wfile.flush()
                    while True:
                        item = mine.get()
                        if item is None:  # agent closes the stream
                            return
                        self.wfile.write(f"data: {json.dumps(item)}\n\n".encode())
                        self.wfile.flush()
                except OSError:
                    return  # the client went away
                finally:
                    with agent.lock:
                        agent.streams.remove(mine)
            if self.path == f"/api/session/{SID}":
                return self._json(200, {"data": agent.session()})
            self._json(404, {})

        def do_PUT(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"null")
            agent.entries.append((self.path, body))
            self._json(200, {"data": None})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"null")
            if self.path == f"/api/session/{SID}/prompt":
                agent.prompts.append(body)
                self._json(200, {"data": {"id": "msg"}})
                for item in agent.script:
                    agent.publish(item)
                return
            if self.path == f"/api/session/{SID}/interrupt":
                agent.interrupts += 1
                return self._json(200, {"interrupted": True})
            self._json(404, {})

    return Handler


class StreamTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": str(Path(tmp.name) / "projects")})
        env.start()
        self.addCleanup(env.stop)
        _helpers.use_sqlite()
        self.project = projects.create_project("app")
        self.agent = FakeAgent(projects.project_path(self.project["id"]))

        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.agent))
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(lambda: self.agent.publish(None))

        fake = process.CodingAgent()
        fake._password = "pw"
        fake._status = process.Status(process.RUNNING, url=f"http://127.0.0.1:{server.server_port}")
        patcher = mock.patch.object(client, "agent", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        stream._running.clear()

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

    def turn(self, text="do it"):
        r = self.client.post(f"/api/code/sessions/{SID}/stream", json={"text": text})
        self.assertEqual(r.status_code, 200, r.text)
        return [json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:")]

    def test_full_turn(self):
        self.agent.script = [
            ev("session.reasoning.delta", delta="thinking"),
            ev("session.text.delta", delta="Hel"),
            ev("session.text.delta", sid=OTHER, delta="NOT MINE"),
            ev("session.text.delta", delta="lo"),
            ev("session.tool.input.started", id="t1", name="shell"),
            ev("session.tool.called", id="t1", input={"command": "ls"}, executed=True),
            ev("permission.asked", id="per_1", action="shell", resources=["ls"]),
            ev("permission.replied", requestID="per_1", reply="once"),
            ev("session.tool.success", id="t1", content=[{"type": "text", "text": "app.py"}], executed=True),
            ev("session.renamed", title="List files"),
            ev("session.execution.succeeded"),
        ]
        events = self.turn("list the files")
        self.assertEqual(self.agent.prompts, [{"text": "list the files"}])
        kinds = [e["type"] for e in events]
        self.assertEqual(kinds, ["start", "reasoning", "text", "text", "tool", "approval", "approval_done",
                                 "tool", "title", "done"])
        self.assertEqual("".join(e["delta"] for e in events if e["type"] == "text"), "Hello")
        self.assertEqual(events[4], {"type": "tool", "id": "t1", "name": "shell", "status": "running",
                                     "input": {"command": "ls"}})
        self.assertEqual(events[7]["name"], "shell")
        self.assertEqual(events[7]["output"], "app.py")
        self.assertEqual(events[5]["resources"], ["ls"])
        self.assertEqual(events[-1], {"type": "done", "outcome": "succeeded"})
        self.assertNotIn(SID, stream._running)

    def test_profile_is_sent_before_the_message(self):
        from app.services import settings
        settings.update({"profile": {"nickname": "Ali", "instructions": "Use tabs."}})
        self.agent.script = [ev("session.execution.succeeded")]
        self.turn()
        path, body = self.agent.entries[-1]
        self.assertEqual(path, f"/api/experimental/session/{SID}/instructions/entries/opengpt-profile")
        self.assertIn("Name: Ali", body["value"])
        self.assertIn("Use tabs.", body["value"])
        # An empty profile removes the entry.
        settings.update({"profile": {"nickname": "", "instructions": ""}})
        self.turn()
        self.assertIsNone(self.agent.entries[-1][1]["value"])

    def test_model_error_is_safe_and_reported_once(self):
        error = {"type": "provider.invalid-request", "status": 413, "message": "org_SECRET too large"}
        self.agent.script = [ev("session.step.failed", error=error), ev("session.execution.failed", error=error)]
        events = self.turn()
        self.assertEqual([e["type"] for e in events], ["start", "error", "done"])
        self.assertNotIn("org_SECRET", json.dumps(events))
        self.assertEqual(events[-1]["outcome"], "failed")

    def test_stop_is_not_an_error(self):
        self.agent.script = [ev("session.step.failed", error={"type": "aborted", "message": "Step interrupted"}),
                             ev("session.execution.interrupted", reason="user")]
        events = self.turn()
        self.assertEqual([e["type"] for e in events], ["start", "done"])
        self.assertEqual(events[-1]["outcome"], "interrupted")

    def test_agent_closing_the_stream_ends_the_turn(self):
        self.agent.script = [ev("session.text.delta", delta="partial"), None]
        events = self.turn()
        self.assertEqual([e["type"] for e in events], ["start", "text", "error", "done"])

    def test_busy_session_is_refused(self):
        self.agent.busy = True
        r = self.client.post(f"/api/code/sessions/{SID}/stream", json={"text": "x"})
        self.assertEqual(r.status_code, 409)
        self.agent.busy = False
        stream._running.add(SID)
        r = self.client.post(f"/api/code/sessions/{SID}/stream", json={"text": "x"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.agent.prompts, [])

    def test_stop_route(self):
        r = self.client.post(f"/api/code/sessions/{SID}/stop")
        self.assertEqual(r.json(), {"interrupted": True})
        self.assertEqual(self.agent.interrupts, 1)

    def test_limits_and_unavailable_agent(self):
        too_long = "x" * (int(os.getenv("MAX_MESSAGE_CHARS", "20000")) + 1)
        r = self.client.post(f"/api/code/sessions/{SID}/stream", json={"text": too_long})
        self.assertEqual(r.status_code, 422)
        with mock.patch.object(client, "agent", process.CodingAgent()):
            r = self.client.post(f"/api/code/sessions/{SID}/stream", json={"text": "x"})
        self.assertEqual(r.status_code, 503)


if __name__ == "__main__":
    unittest.main()

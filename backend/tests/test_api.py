"""HTTP routes: status codes, id validation, upload checks, one reply per thread."""
import json
import unittest
import uuid
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.router.chat as chat_routes  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402
from app.services import run_lock  # noqa: E402
from app.services.chat import ChatService  # noqa: E402


def make_client():
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(chat_routes.chat_router, prefix="/api")
    return TestClient(app)


def sse_events(text):
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_invalid_and_missing_thread_ids(self):
        self.assertEqual(self.client.get("/api/threads/not-a-uuid").status_code, 422)
        self.assertEqual(self.client.get(f"/api/threads/{uuid.uuid4()}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/threads/{uuid.uuid4()}").status_code, 404)
        r = self.client.put(f"/api/threads/{uuid.uuid4()}/title", json={"title": "x"})
        self.assertEqual(r.status_code, 404)

    def test_path_traversal_rejected(self):
        r = self.client.post(
            "/api/upload-pdf", data={"thread_id": "../../tmp/x"}, files={"file": ("a.txt", b"hi")}
        )
        self.assertEqual(r.status_code, 422)

    def test_upload_content_is_checked(self):
        for name, data in [("a.pdf", b"not a pdf"), ("a.txt", b"\x00\x01binary"), ("a.md", b"\xff\xfe\xfa")]:
            r = self.client.post("/api/upload-pdf", files={"file": (name, data)})
            self.assertEqual(r.status_code, 422, name)
        self.assertEqual(self.client.post("/api/upload-pdf", files={"file": ("a.exe", b"x")}).status_code, 422)
        self.assertEqual(self.client.post("/api/upload-pdf", files={"file": ("a.txt", b"")}).status_code, 422)

    def test_errors_hide_internal_details(self):
        with mock.patch.object(ChatService, "get_all_threads", side_effect=Exception("SELECT secret FROM x")):
            r = self.client.get("/api/threads")
        self.assertEqual(r.status_code, 500)
        self.assertNotIn("secret", r.text)
        self.assertIn("ref", r.json()["error"]["message"])

    def test_temporary_chats_get_separate_threads(self):
        seen = []

        def fake_stream(message, thread_id, tools=None, temporary=False):
            seen.append(thread_id)
            yield {"content": "ok", "message_type": "ai"}

        with mock.patch.object(ChatService, "stream_message", staticmethod(fake_stream)):
            a, b = str(uuid.uuid4()), str(uuid.uuid4())
            for sid in (a, b):
                events = sse_events(self.client.post(
                    "/api/chat/stream", json={"message": "hi", "temporary": True, "session_id": sid}
                ).text)
                self.assertTrue(events[-1].get("done"))
        self.assertEqual(seen, [f"temp-{a}", f"temp-{b}"])

    def test_one_reply_per_thread(self):
        tid = ChatService.create_new_thread()
        with run_lock.exclusive_run(tid):
            with mock.patch.object(ChatService, "get_or_create_thread_title", lambda *a: None):
                r = self.client.post("/api/chat/stream", json={"message": "hi", "thread_id": tid})
            self.assertIn("still being generated", sse_events(r.text)[-1]["error"])
            r = self.client.post("/api/chat/regenerate", json={"thread_id": tid})
            self.assertEqual(r.status_code, 409)

    def test_message_size_limit(self):
        r = self.client.post("/api/chat/stream", json={"message": "x" * 20001})
        self.assertEqual(r.status_code, 422)


class PathSafetyTests(unittest.TestCase):
    def test_thread_paths_reject_non_uuids(self):
        from app.services.rag import _stored_path, _thread_paths
        for bad in ["../x", "/tmp/abs", "null"]:
            with self.assertRaises(ValueError):
                _thread_paths(bad)
        self.assertNotIn("..", _stored_path("../../etc/passwd").split("documents")[-1])


if __name__ == "__main__":
    unittest.main()

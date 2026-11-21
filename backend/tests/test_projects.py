"""Projects: CRUD, chats in a project, files, the chat prompt and routes."""
import importlib
import unittest
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessageChunk, HumanMessage  # noqa: E402

import app.router.chat as chat_routes  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402
from app.exceptions import NotFoundError, ValidationError  # noqa: E402
from app.router.projects import projects_router  # noqa: E402
from app.services import projects  # noqa: E402
from app.services.chat import ChatService  # noqa: E402

cb = importlib.import_module("app.services.chatbot")


def make_client():
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(chat_routes.chat_router, prefix="/api")
    app.include_router(projects_router, prefix="/api")
    return TestClient(app)


class _Recorder:
    def __init__(self):
        self.seen = None

    def bind_tools(self, tools):
        return self

    def stream(self, messages):
        self.seen = messages
        yield AIMessageChunk(content="ok")


class ProjectServiceTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()

    def test_create_update_list(self):
        p = projects.create("  Thesis   work ", "Answer in British English.")
        self.assertEqual(p["name"], "Thesis work")
        self.assertEqual(p["chats"], 0)
        self.assertEqual(projects.update(p["id"], instructions="Be brief.")["instructions"], "Be brief.")
        self.assertEqual(projects.update(p["id"], name="Thesis")["name"], "Thesis")
        self.assertEqual([x["name"] for x in projects.list_projects()], ["Thesis"])

    def test_validation_and_missing(self):
        for bad in ("", "   ", "x" * (projects.MAX_NAME_CHARS + 1)):
            with self.assertRaises(ValidationError):
                projects.create(bad)
        with self.assertRaises(ValidationError):
            projects.create("A", "x" * (projects.MAX_INSTRUCTIONS_CHARS + 1))
        for missing in ("not-a-uuid", "11111111-1111-4111-8111-111111111111"):
            with self.assertRaises(NotFoundError):
                projects.get(missing)

    def test_chats_in_a_project(self):
        p = projects.create("Work")
        inside = ChatService.create_new_thread(p["id"])
        outside = ChatService.create_new_thread()
        with self.assertRaises(NotFoundError):
            ChatService.create_new_thread("11111111-1111-4111-8111-111111111111")

        self.assertEqual(projects.project_for_thread(inside)["name"], "Work")
        self.assertIsNone(projects.project_for_thread(outside))
        self.assertIsNone(projects.project_for_thread("temp-abc"))
        self.assertEqual(projects.get(p["id"])["chats"], 1)

        # Only chats with messages are listed.
        with mock.patch.object(cb, "retrieve_all_threads", return_value=[inside, outside]), \
                mock.patch("app.services.chat.retrieve_all_threads", return_value=[inside, outside]):
            self.assertEqual([c["thread_id"] for c in projects.chats(p["id"])], [inside])
            listed = {t["thread_id"]: t["project_id"] for t in ChatService.get_all_threads()}
        self.assertEqual(listed, {inside: p["id"], outside: None})

        projects.set_thread_project(outside, p["id"])
        projects.set_thread_project(inside, None)
        self.assertIsNone(projects.project_for_thread(inside))
        self.assertEqual(projects.project_for_thread(outside)["id"], p["id"])
        with self.assertRaises(NotFoundError):
            projects.set_thread_project("22222222-2222-4222-8222-222222222222", p["id"])

    def test_delete_removes_chats_and_files(self):
        p = projects.create("Old")
        chat = ChatService.create_new_thread(p["id"])
        other = ChatService.create_new_thread()
        with mock.patch.object(ChatService, "delete_thread") as delete_thread, \
                mock.patch("app.services.rag.delete_documents") as delete_documents:
            self.assertEqual(projects.delete(p["id"]), 1)
        delete_thread.assert_called_once_with(chat)
        delete_documents.assert_called_once_with(p["id"])
        self.assertEqual(projects.list_projects(), [])
        self.assertIsNone(projects.project_for_thread(other))
        with self.assertRaises(NotFoundError):
            projects.delete(p["id"])

    def test_files(self):
        p = projects.create("Docs")
        info = {"files": [{"stored_name": f"{p['id']}-0123456789ab.pdf", "filename": "spec.pdf",
                           "chunks": 4, "documents": 2}]}
        with mock.patch("app.services.rag.ingest_document") as ingest, \
                mock.patch("app.services.rag.get_document_info", return_value=info):
            added = projects.add_file(p["id"], b"%PDF-1.4", "spec.pdf")
            self.assertEqual(added["filename"], "spec.pdf")
            ingest.assert_called_once_with(b"%PDF-1.4", p["id"], "spec.pdf")
            with mock.patch.object(projects, "MAX_FILES", 1), self.assertRaises(ValidationError):
                projects.add_file(p["id"], b"%PDF-1.4", "more.pdf")
        with self.assertRaises(ValidationError):
            projects.remove_file(p["id"], "../../etc/passwd")
        with mock.patch("app.services.rag.delete_file", return_value=False), self.assertRaises(NotFoundError):
            projects.remove_file(p["id"], f"{p['id']}-0123456789ab.pdf")


class ProjectPromptTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        self.model = _Recorder()
        self._old_model, cb.model = cb.model, self.model
        self._old_retrieve = cb.retrieve_from_document
        self._old_has_files = cb.has_files

    def tearDown(self):
        cb.model = self._old_model
        cb.retrieve_from_document = self._old_retrieve
        cb.has_files = self._old_has_files

    def test_instructions_and_project_files_reach_the_model(self):
        from app.services import settings
        settings.update({"profile": {"instructions": "Use emoji."}})
        p = projects.create("Thesis", "Never use emoji.")
        chat = ChatService.create_new_thread(p["id"])

        asked = []
        cb.has_files = lambda doc_id: doc_id == p["id"]
        cb.retrieve_from_document = lambda q, doc_id: asked.append(doc_id) or {"context": [f"TEXT FROM {doc_id}"]}
        with mock.patch.object(projects, "file_names", return_value=["notes.md"]):
            cb.chat_node({"messages": [HumanMessage("summarise", id="h1")], "thread_id": chat,
                          "has_document": False, "tools": []})
        system = self.model.seen[0].content
        self.assertIn('project "Thesis"', system)
        self.assertIn("Never use emoji.", system)
        self.assertLess(system.index("Use emoji."), system.index("Never use emoji."))  # project wins
        self.assertIn("notes.md", system)
        self.assertEqual(asked, [p["id"]])
        self.assertIn(f"TEXT FROM {p['id']}", self.model.seen[1].content)

        # The chat's own files and the project's: both, labelled.
        asked.clear()
        cb.chat_node({"messages": [HumanMessage("again", id="h2")], "thread_id": chat,
                      "has_document": True, "tools": []})
        self.assertEqual(asked, [chat, p["id"]])
        self.assertIn("[Project files]", self.model.seen[1].content)
        self.assertIn("[Files attached to this chat]", self.model.seen[1].content)

    def test_chat_outside_a_project(self):
        chat = ChatService.create_new_thread()
        cb.chat_node({"messages": [HumanMessage("hi")], "thread_id": chat, "has_document": False, "tools": []})
        self.assertNotIn("This chat is in the user's project", self.model.seen[0].content)


class ProjectRouteTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        self.client = make_client()

    def test_routes(self):
        c = self.client
        r = c.post("/api/projects", json={"name": "Launch", "instructions": "Plain words."})
        self.assertEqual(r.status_code, 201)
        pid = r.json()["id"]
        self.assertEqual(c.post("/api/projects", json={"name": ""}).status_code, 422)
        self.assertEqual(c.get("/api/projects").json()["projects"][0]["name"], "Launch")
        self.assertEqual(c.put(f"/api/projects/{pid}", json={"name": "Launch v2"}).json()["name"], "Launch v2")

        new = c.post("/api/threads/new", json={"project_id": pid}).json()
        self.assertEqual(new["project_id"], pid)
        self.assertIsNone(c.post("/api/threads/new").json()["project_id"])   # no body still works
        self.assertEqual(c.post("/api/threads/new", json={"project_id": "11111111-1111-4111-8111-111111111111"})
                         .status_code, 404)

        with mock.patch.object(cb, "retrieve_all_threads", return_value=[new["thread_id"]]), \
                mock.patch("app.services.chat.retrieve_all_threads", return_value=[new["thread_id"]]), \
                mock.patch("app.services.rag.get_document_info", return_value=None):
            body = c.get(f"/api/projects/{pid}").json()
            self.assertEqual([t["thread_id"] for t in body["threads"]], [new["thread_id"]])
            self.assertEqual(body["files"], [])
            self.assertEqual(c.get("/api/threads").json()["threads"][0]["project_id"], pid)

        tid = new["thread_id"]
        self.assertIsNone(c.put(f"/api/threads/{tid}/project", json={"project_id": None}).json()["project_id"])
        self.assertEqual(c.put(f"/api/threads/{tid}/project", json={"project_id": pid}).status_code, 200)
        self.assertEqual(c.put("/api/threads/not-a-uuid/project", json={"project_id": pid}).status_code, 422)

        self.assertEqual(c.post(f"/api/projects/{pid}/files", files={"file": ("a.exe", b"x")}).status_code, 422)
        self.assertEqual(c.post(f"/api/projects/{pid}/files", files={"file": ("a.pdf", b"nope")}).status_code, 422)

        with mock.patch.object(ChatService, "delete_thread"), mock.patch("app.services.rag.delete_documents"):
            self.assertEqual(c.delete(f"/api/projects/{pid}").json(), {"deleted_chats": 1})
        self.assertEqual(c.get(f"/api/projects/{pid}").status_code, 404)


if __name__ == "__main__":
    unittest.main()

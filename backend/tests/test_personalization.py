"""Personalization (profile -> prompt) and the knowledge base (files, search, chat tool)."""
import importlib
import os
import tempfile
import unittest
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from langchain_core.embeddings import DeterministicFakeEmbedding  # noqa: E402
from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage  # noqa: E402

from app.exceptions import NotFoundError, ValidationError  # noqa: E402
from app.services import knowledge, personalization, rag, settings  # noqa: E402

cb = importlib.import_module("app.services.chatbot")


class _Recorder:
    def __init__(self):
        self.seen = None
        self.tools = None

    def bind_tools(self, tools):
        self.tools = [t.name for t in tools]
        return self

    def stream(self, messages):
        self.seen = messages
        yield AIMessageChunk(content="ok")


class TempStorage(unittest.TestCase):
    """Knowledge files in a temp folder, with small fake embeddings."""

    def setUp(self):
        _helpers.use_sqlite()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for patcher in (
            mock.patch.object(rag, "_STORAGE_DIR", tmp.name),
            mock.patch.object(rag, "_default_embeddings", lambda: DeterministicFakeEmbedding(size=16)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        rag._THREAD_RETRIEVERS.clear()
        rag._THREAD_METADATA.clear()


class ProfileTextTests(TempStorage):
    def test_empty_profile_adds_nothing(self):
        self.assertEqual(personalization.profile_text(), "")

    def test_profile_and_instructions(self):
        settings.update({"profile": {"nickname": "Ali", "occupation": "Teacher",
                                     "about": "Lives in Lahore", "instructions": "Answer in short bullet points."}})
        text = personalization.profile_text()
        for part in ("Name: Ali", "Occupation: Teacher", "Lives in Lahore", "short bullet points"):
            self.assertIn(part, text)

    def test_chat_prompt_gets_the_profile(self):
        settings.update({"profile": {"instructions": "Always reply in Urdu."}})
        model, old = _Recorder(), cb.model
        cb.model = model
        try:
            cb.chat_node({"messages": [HumanMessage("hi")], "thread_id": None, "has_document": False, "tools": []})
        finally:
            cb.model = old
        system = [m for m in model.seen if isinstance(m, SystemMessage)]
        self.assertEqual(len(system), 1)
        self.assertIn("Always reply in Urdu.", system[0].content)
        self.assertNotIn("Knowledge", model.tools)  # empty knowledge base: no tool


class KnowledgeTests(TempStorage):
    def test_add_list_search_remove(self):
        f = knowledge.add(b"The office wifi password is lemon-tree-42.", "office.txt")
        self.assertEqual(f["filename"], "office.txt")
        self.assertEqual([x["filename"] for x in knowledge.list_files()], ["office.txt"])
        self.assertTrue(knowledge.has_documents())
        self.assertIn("lemon-tree-42", knowledge.search("wifi password"))
        self.assertIn("[office.txt]", knowledge.search("wifi"))

        knowledge.remove(f["id"])
        self.assertEqual(knowledge.list_files(), [])
        self.assertFalse(knowledge.has_documents())
        with self.assertRaises(NotFoundError):
            knowledge.remove(f["id"])

    def test_remove_one_of_two_keeps_the_other_searchable(self):
        a = knowledge.add(b"Apples are red.", "a.md")
        knowledge.add(b"Bananas are yellow.", "b.md")
        knowledge.remove(a["id"])
        self.assertEqual([x["filename"] for x in knowledge.list_files()], ["b.md"])
        self.assertIn("Bananas", knowledge.search("fruit colour"))

    def test_bad_input(self):
        for bad in ("../../etc/passwd", "x", ""):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                knowledge.remove(bad)
        with self.assertRaises(ValidationError):
            knowledge.add(b"x", "notes.exe")

    def test_limit(self):
        with mock.patch.object(knowledge, "MAX_FILES", 1):
            knowledge.add(b"one", "1.txt")
            with self.assertRaises(ValidationError):
                knowledge.add(b"two", "2.txt")

    def test_chat_offers_the_tool_and_names_the_documents(self):
        knowledge.add(b"Quarterly revenue was 1.2M.", "report.txt")
        model, old = _Recorder(), cb.model
        cb.model = model
        try:
            cb.chat_node({"messages": [HumanMessage("revenue?")], "thread_id": None, "has_document": False, "tools": []})
        finally:
            cb.model = old
        self.assertIn("Knowledge", model.tools)
        self.assertIn("report.txt", model.seen[0].content)

    def test_knowledge_is_not_a_chat_thread(self):
        knowledge.add(b"secret notes", "notes.txt")
        other = "11111111-1111-4111-8111-111111111111"
        self.assertFalse(rag.has_document(other))


class RouteTests(TempStorage):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.settings import settings_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(settings_router, prefix="/api")
        self.client = TestClient(app)

    def test_upload_list_delete(self):
        r = self.client.post("/api/settings/knowledge", files={"file": ("faq.md", b"# FAQ\nOpen 9 to 5.", "text/markdown")})
        self.assertEqual(r.status_code, 201, r.text)
        listing = self.client.get("/api/settings/knowledge").json()
        self.assertEqual([f["filename"] for f in listing["files"]], ["faq.md"])
        fid = listing["files"][0]["id"]
        self.assertEqual(self.client.delete(f"/api/settings/knowledge/{fid}").status_code, 204)
        self.assertEqual(self.client.get("/api/settings/knowledge").json()["files"], [])

    def test_upload_checks(self):
        r = self.client.post("/api/settings/knowledge", files={"file": ("x.exe", b"MZ", "application/octet-stream")})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/api/settings/knowledge", files={"file": ("e.txt", b"", "text/plain")})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()

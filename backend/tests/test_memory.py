"""Memory: saved memories, the memory tools, chat history search, settings and routes."""
import unittest
from datetime import datetime
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: E402

from app.error_handlers import register_error_handlers  # noqa: E402
from app.exceptions import NotFoundError, ValidationError  # noqa: E402
from app.router.settings import settings_router  # noqa: E402
from app.services import memory, settings  # noqa: E402
from app.services.chat import ChatService  # noqa: E402

STATE = {"thread_id": "11111111-1111-4111-8111-111111111111"}
TEMP = {"thread_id": "temp-abc"}


class SavedMemoryTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()

    def test_add_list_update_delete_clear(self):
        a = memory.add("  Prefers   Python ")
        self.assertEqual(a["text"], "Prefers Python")
        self.assertEqual(memory.add("prefers python")["id"], a["id"])     # no duplicates
        b = memory.add("Works on OpenGPT", thread_id=STATE["thread_id"])
        self.assertEqual({m["text"] for m in memory.list_memories()}, {"Prefers Python", "Works on OpenGPT"})
        self.assertEqual(memory.update(b["id"], "Works on OpenGPT and a CLI")["text"], "Works on OpenGPT and a CLI")
        memory.delete(a["id"])
        with self.assertRaises(NotFoundError):
            memory.delete(a["id"])
        self.assertEqual(memory.clear(), 1)
        self.assertEqual(memory.list_memories(), [])

    def test_limits(self):
        for bad in ("", "   ", "x" * (memory.MAX_MEMORY_CHARS + 1)):
            with self.assertRaises(ValidationError):
                memory.add(bad)
        with mock.patch.object(memory, "MAX_MEMORIES", 2):
            memory.add("one")
            memory.add("two")
            with self.assertRaises(ValidationError):
                memory.add("three")

    def test_prompt_text(self):
        saved = memory.add("Prefers Python")
        text = memory.prompt_text(STATE["thread_id"])
        self.assertIn(f"[{saved['id'][:8]}] Prefers Python", text)
        self.assertIn("Remember", text)
        self.assertIn("Chat_history", text)
        self.assertEqual(memory.prompt_text(TEMP["thread_id"]), "")      # temporary chats
        settings.update({"memory": {"enabled": False}})
        text = memory.prompt_text(STATE["thread_id"])
        self.assertNotIn("Prefers Python", text)
        self.assertIn("Chat_history", text)
        settings.update({"memory": {"chat_history": False}})
        self.assertEqual(memory.prompt_text(STATE["thread_id"]), "")

    def test_tools(self):
        result = memory.Remember.invoke({"fact": "Lives in Lahore", "state": STATE})
        self.assertTrue(memory.memory_changed(result))
        saved = memory.list_memories()[0]
        self.assertEqual(saved["thread_id"], STATE["thread_id"])
        short = saved["id"][:8]
        self.assertIn("Karachi", memory.Update_memory.invoke({"memory_id": f"[{short}]", "fact": "Lives in Karachi", "state": STATE}))
        self.assertTrue(memory.memory_changed(memory.Forget.invoke({"memory_id": short, "state": STATE})))
        self.assertEqual(memory.list_memories(), [])
        # Temporary chats and the switch off: nothing changes.
        self.assertFalse(memory.memory_changed(memory.Remember.invoke({"fact": "x", "state": TEMP})))
        settings.update({"memory": {"enabled": False}})
        self.assertFalse(memory.memory_changed(memory.Remember.invoke({"fact": "x", "state": STATE})))
        self.assertEqual(memory.list_memories(), [])

    def test_tools_hide_state_from_the_model(self):
        self.assertEqual(set(memory.Remember.tool_call_schema.model_json_schema()["properties"]), {"fact"})
        self.assertEqual(set(memory.Chat_history.tool_call_schema.model_json_schema()["properties"]), {"query"})


class ChatHistoryTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        memory._text_cache.clear()
        now = datetime(2026, 11, 20)
        self.threads = {
            "a": {"title": "Pricing plan", "updated_at": now},
            "b": {"title": "Trip ideas", "updated_at": now},
            "cur": {"title": "Current", "updated_at": now},
        }
        self.texts = {
            "a": [("user", "Should the pro plan cost 20 dollars?"), ("assistant", "Yes, the pro plan at 20 dollars works.")],
            "b": [("user", "Ideas for a trip to Skardu"), ("assistant", "Visit the lakes.")],
            "cur": [("user", "pro plan again")],
        }
        patches = [
            mock.patch("app.services.chatbot.get_all_thread_metadata", return_value=self.threads),
            mock.patch.object(memory, "_chat_text", side_effect=lambda tid, _: self.texts[tid]),
            mock.patch("app.services.rag.get_document_info",
                       side_effect=lambda tid: {"files": [{"filename": "contract.pdf"}]} if tid == "b" else None),
            mock.patch("app.services.rag.retrieve_from_document",
                       return_value={"context": ["Clause 4: payment within 30 days."]}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_finds_messages_and_skips_the_current_chat(self):
        out = memory.search_chats("what price did we pick for the pro plan", exclude="cur")
        self.assertIn('Chat "Pricing plan" (/chat/a', out)
        self.assertIn("20 dollars", out)
        self.assertNotIn("/chat/cur", out)
        self.assertNotIn("Clause 4", out)    # messages matched, file names didn't

    def test_finds_files_from_other_chats(self):
        out = memory.search_chats("the contract I sent", exclude="cur")
        self.assertIn('File in chat "Trip ideas" (/chat/b; files: contract.pdf)', out)
        self.assertIn("Clause 4", out)

    def test_no_message_match_falls_back_to_recent_files(self):
        out = memory.search_chats("zebra quantum", exclude="cur")
        self.assertIn('File in chat "Trip ideas"', out)

    def test_nothing_found_and_switch(self):
        with mock.patch("app.services.rag.get_document_info", return_value=None):
            self.assertIn("Nothing in your other chats matched", memory.search_chats("zebra quantum", exclude="cur"))
        self.assertIn("Chat history is off", memory.Chat_history.invoke({"query": "plan", "state": TEMP}))
        settings.update({"memory": {"chat_history": False}})
        self.assertIn("Chat history is off", memory.Chat_history.invoke({"query": "plan", "state": STATE}))


class LoadedChatTests(unittest.TestCase):
    def test_memory_updated_flag_on_the_answer(self):
        messages = [
            HumanMessage(content="I prefer Python"),
            AIMessage(content="", tool_calls=[{"id": "t1", "name": "Remember", "args": {"fact": "Prefers Python"}}]),
            ToolMessage(content="Saved memory [abcd1234]: Prefers Python", tool_call_id="t1", name="Remember"),
            AIMessage(content="Got it."),
            HumanMessage(content="Thanks"),
            AIMessage(content="You're welcome."),
        ]
        state = mock.Mock(values={"messages": messages})
        with mock.patch("app.services.chat.chatbot.get_state", return_value=state):
            loaded = ChatService.load_conversation("x")
        answers = [m for m in loaded if m["type"] == "ai"]
        self.assertTrue(answers[0].get("memory_updated"))
        self.assertFalse(answers[1]["memory_updated"])

        # The history route passes it on to the browser.
        import app.router.chat as chat_routes
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(chat_routes.chat_router, prefix="/api")
        with mock.patch.object(chat_routes.ChatService, "load_conversation", return_value=loaded):
            body = TestClient(app).get("/api/threads/11111111-1111-4111-8111-111111111111").json()
        self.assertEqual([m["memory_updated"] for m in body["messages"] if m["type"] == "ai"], [True, False])


class StreamTests(unittest.TestCase):
    def test_memory_event_and_labels(self):
        stream = [
            ("messages", (AIMessage(content="", tool_calls=[{"id": "t1", "name": "Remember", "args": {}}]), {})),
            ("messages", (ToolMessage(content="Saved memory [abcd1234]: x", tool_call_id="t1", name="Remember"), {})),
            ("messages", (AIMessage(content="", tool_calls=[{"id": "t2", "name": "Chat_history", "args": {}}]), {})),
            ("messages", (ToolMessage(content="Nothing in your other chats matched.", tool_call_id="t2", name="Chat_history"), {})),
        ]
        events = list(ChatService._relay_chat_stream(iter(stream), set(), [], [], []))
        self.assertEqual(sum(1 for e in events if e.get("message_type") == "memory"), 1)
        labels = [e.get("content") for e in events]
        self.assertIn("Updating memory...", labels)
        self.assertIn("Searching your past chats...", labels)


class MemoryRouteTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(settings_router, prefix="/api")
        self.client = TestClient(app)

    def test_routes(self):
        r = self.client.post("/api/settings/memories", json={"text": "Prefers Python"})
        self.assertEqual(r.status_code, 201)
        mid = r.json()["id"]
        self.assertEqual(self.client.get("/api/settings/memories").json()["memories"][0]["text"], "Prefers Python")
        self.assertEqual(self.client.put(f"/api/settings/memories/{mid}", json={"text": "Prefers Go"}).json()["text"], "Prefers Go")
        self.assertEqual(self.client.post("/api/settings/memories", json={"text": ""}).status_code, 422)
        self.assertEqual(self.client.delete(f"/api/settings/memories/{mid}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/settings/memories/{mid}").status_code, 404)
        self.client.post("/api/settings/memories", json={"text": "a"})
        self.assertEqual(self.client.delete("/api/settings/memories").status_code, 204)
        self.assertEqual(self.client.get("/api/settings/memories").json()["memories"], [])

    def test_settings_section(self):
        s = self.client.get("/api/settings").json()
        self.assertEqual(s["memory"], {"enabled": True, "chat_history": True})
        s = self.client.put("/api/settings", json={"memory": {"chat_history": False}}).json()
        self.assertEqual(s["memory"], {"enabled": True, "chat_history": False})


if __name__ == "__main__":
    unittest.main()

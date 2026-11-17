"""Model menu: Auto's choice per message, an explicit pick, the menu endpoint."""
import importlib
import os
import unittest
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from langchain_core.messages import AIMessageChunk, HumanMessage  # noqa: E402

from app import llm  # noqa: E402
from app.services import model_router, providers  # noqa: E402

ROLES = {"LLM_MODEL": "chat-m", "LLM_SMALL_MODEL": "small-m", "RESEARCH_MODEL": "big-m",
         "CODING_AGENT_MODEL": "code-m", "BLOG_MODEL": ""}


class AutoTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, ROLES)
        env.start()
        self.addCleanup(env.stop)
        llm.reload()
        self.addCleanup(llm.reload)

    def test_tiers(self):
        tier = model_router.tier
        self.assertEqual(tier("hi!"), "light")
        self.assertEqual(tier("thanks"), "light")
        self.assertEqual(tier("What is the capital of France?"), "normal")
        self.assertEqual(tier("plan my day"), "normal")
        self.assertEqual(tier("Please analyze the trade-offs between these two database designs for us"), "strong")
        self.assertEqual(tier("fix this:\n```py\nprint(1\n```"), "strong")
        self.assertEqual(tier("x" * 2000), "strong")
        self.assertEqual(tier("summarise it", has_document=True), "strong")
        # Coding tasks never go to the light model.
        self.assertEqual(tier("hi", purpose="code"), "normal")

    def test_auto_uses_the_models_for_each_job(self):
        self.assertEqual(model_router.choose("hello"), ("small-m", True))
        self.assertEqual(model_router.choose("What time zone is Lahore in?"), ("chat-m", True))
        self.assertEqual(model_router.choose("Refactor and debug the payment module step by step please"),
                         ("big-m", True))
        self.assertEqual(model_router.choose("add a test", purpose="code"), ("code-m", True))

    def test_a_picked_model_turns_auto_off(self):
        self.assertEqual(model_router.choose("hello", "picked-m"), ("picked-m", False))
        self.assertEqual(model_router.choose("hello", "auto"), ("small-m", True))

    def test_menu_lists_chosen_models_first_without_network(self):
        providers.forget_models()
        with mock.patch.object(providers, "test", return_value={
                "models": ["zeta", "chat-m", "text-embedding-3", "llama-guard-4", "alpha"]}) as listed:
            models = providers.available_models()
            providers.available_models()   # cached
        self.assertEqual(listed.call_count, 1)
        self.assertEqual(models[:4], ["chat-m", "small-m", "big-m", "code-m"])
        self.assertEqual(models[4:], ["zeta", "alpha"])
        providers.forget_models()
        with mock.patch.object(providers, "test", side_effect=RuntimeError("offline")):
            self.assertEqual(providers.available_models(), ["chat-m", "small-m", "big-m", "code-m"])
        providers.forget_models()

    def test_menu_endpoint(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.router.providers import providers_router

        app = FastAPI()
        app.include_router(providers_router, prefix="/api")
        providers.forget_models()
        with mock.patch.object(providers, "test", side_effect=RuntimeError("offline")):
            body = TestClient(app).get("/api/providers/models").json()
        providers.forget_models()
        self.assertEqual((body["chat_default"], body["code_default"]), ("chat-m", "code-m"))
        self.assertEqual(body["auto"]["chat"], {"light": "small-m", "normal": "chat-m", "strong": "big-m"})
        self.assertIn("big-m", body["models"])


class ChatNodeModelTests(unittest.TestCase):
    """The chat graph answers with the model picked for the reply."""

    def test_picked_model_is_used(self):
        cb = importlib.import_module("app.services.chatbot")
        used = []

        class Fake:
            def __init__(self, name):
                self.name = name

            def bind_tools(self, tools):
                return self

            def stream(self, messages):
                used.append(self.name)
                yield AIMessageChunk(content="ok")

        state = {"messages": [HumanMessage("hi")], "thread_id": None, "has_document": False, "tools": []}
        with mock.patch.object(cb, "chat_model", side_effect=Fake), mock.patch.object(cb, "model", Fake("default")):
            cb.chat_node(state, {"configurable": {"model_name": "picked-m"}})
            cb.chat_node(state, {"configurable": {}})
        self.assertEqual(used, ["picked-m", "default"])


if __name__ == "__main__":
    unittest.main()

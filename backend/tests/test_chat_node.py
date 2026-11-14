"""The chat node's model input: tool-call repair, document context, Search hint."""
import importlib
import unittest

from tests import _helpers

_helpers.use_sqlite()

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage  # noqa: E402

cb = importlib.import_module("app.services.chatbot")


class _Recorder:
    def __init__(self):
        self.seen = None

    def bind_tools(self, tools):
        return self

    def stream(self, messages):
        self.seen = messages
        yield AIMessageChunk(content="ok")


def call(*ids):
    return AIMessage(content="", tool_calls=[{"name": "Search", "args": {}, "id": i} for i in ids])


class ChatNodeTests(unittest.TestCase):
    def setUp(self):
        self.model = _Recorder()
        self._old_model, cb.model = cb.model, self.model
        self._old_retrieve = cb.retrieve_from_document

    def tearDown(self):
        cb.model = self._old_model
        cb.retrieve_from_document = self._old_retrieve

    def test_dangling_tool_call_gets_a_result(self):
        fixed = cb.close_dangling_tool_calls([HumanMessage("q1"), call("a"), HumanMessage("q2")])
        self.assertIsInstance(fixed[2], ToolMessage)
        self.assertEqual(fixed[2].tool_call_id, "a")

    def test_healthy_history_unchanged(self):
        msgs = [HumanMessage("q"), call("a"), ToolMessage("r", tool_call_id="a"), AIMessage("x")]
        self.assertEqual(len(cb.close_dangling_tool_calls(msgs)), 4)

    def test_one_system_message_first(self):
        cb.chat_node({"messages": [HumanMessage("hi")], "thread_id": None, "has_document": False, "tools": ["search"]})
        systems = [m for m in self.model.seen if isinstance(m, SystemMessage)]
        self.assertEqual(len(systems), 1)
        self.assertIs(self.model.seen[0], systems[0])
        self.assertIn("web search", systems[0].content)

    def test_document_context_goes_in_the_question(self):
        calls = []
        cb.retrieve_from_document = lambda q, t: calls.append(q) or {"context": ["DOC TEXT"]}
        state = {
            "messages": [HumanMessage("what?", id="h1"), call("c"), ToolMessage("r", tool_call_id="c")],
            "thread_id": "t",
            "has_document": True,
        }
        out = cb.chat_node(state)
        kinds = [type(m).__name__ for m in self.model.seen]
        self.assertEqual(kinds, ["SystemMessage", "HumanMessage", "AIMessage", "ToolMessage"])
        self.assertIn("DOC TEXT", self.model.seen[1].content)
        self.assertNotIn("DOC TEXT", self.model.seen[0].content)
        # Retrieved once per question
        state["doc_context"] = out["doc_context"]
        cb.chat_node(state)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()

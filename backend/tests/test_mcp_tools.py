"""Connector tools in chat: connecting, read-only vs asking first, approvals."""
import os
import sys
import threading
import unittest
from typing import Annotated, TypedDict
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from langchain_core.messages import AIMessage, BaseMessage  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from langgraph.graph.message import add_messages  # noqa: E402
from langgraph.prebuilt import ToolNode  # noqa: E402

from app import secret_box  # noqa: E402
from app.services import chat_approvals, connectors, mcp_tools  # noqa: E402

SERVER = os.path.join(os.path.dirname(__file__), "fixtures", "notes_mcp.py")


class _State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def _run_tool_call(tool, args, answer=None, can_ask=True):
    """Run one tool call in a graph like chat does; answer approvals with ``answer``."""
    def model(_):
        return {"messages": [AIMessage(content="", tool_calls=[{"id": "c1", "name": tool.name, "args": args}])]}

    def tools(state, config):
        return ToolNode([tool]).invoke(state, config)

    g = StateGraph(_State)
    g.add_node("model", model)
    g.add_node("tools", tools)
    g.add_edge(START, "model")
    g.add_edge("model", "tools")
    g.add_edge("tools", END)
    events, result = [], None
    config = {"configurable": {"thread_id": "t1", "can_ask": can_ask}}
    for mode, payload in g.compile().stream({"messages": []}, config, stream_mode=["messages", "custom"]):
        if mode == "custom":
            events.append(payload)
            if payload["type"] == "approval" and answer:
                approval_id = payload["approval"]["id"]
                threading.Timer(0.1, chat_approvals.answer, (approval_id, answer)).start()
        elif payload[0].type == "tool":
            result = payload[0].content
    return events, result


class McpToolsTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, {"SETTINGS_SECRET": "t"})
        env.start()
        self.addCleanup(env.stop)
        secret_box._reset_for_tests()
        self.addCleanup(mcp_tools.close_all)
        self.connector = connectors.create(name="notes", kind="local", command=[sys.executable, SERVER])

    def tools(self):
        return {t.name: t for t in mcp_tools.chat_tools()}

    def test_tools_are_listed_with_server_prefix(self):
        tools = self.tools()
        self.assertEqual(set(tools), {"notes__list_notes", "notes__add_note"})
        self.assertTrue(tools["notes__add_note"].description.startswith("[notes] Save a new note"))
        self.assertEqual(mcp_tools.status()[self.connector["id"]], {"connected": True, "tools": 2, "error": None})

    def test_read_only_tool_runs_without_asking(self):
        events, result = _run_tool_call(self.tools()["notes__list_notes"], {})
        self.assertEqual(events, [])
        self.assertIn("buy milk", result)

    def test_changing_tool_asks_and_runs_when_allowed(self):
        events, result = _run_tool_call(self.tools()["notes__add_note"], {"text": "call mum"}, answer="allow")
        approval = events[0]["approval"]
        self.assertEqual((approval["connector"], approval["tool"]), ("notes", "Add note"))
        self.assertIn("call mum", approval["arguments"])
        self.assertTrue(approval["destructive"])
        self.assertEqual(events[1], {"type": "approval_done", "id": approval["id"], "decision": "allow"})
        self.assertIn("added: call mum", result)

    def test_denied_or_unanswered_does_not_run(self):
        tool = self.tools()["notes__add_note"]
        _, result = _run_tool_call(tool, {"text": "nope"}, answer="deny")
        self.assertIn("did not allow", result)
        with mock.patch.object(chat_approvals, "TIMEOUT_SECONDS", 0.2), \
             mock.patch.object(chat_approvals.ask, "__defaults__", (0.2,)):
            events, result = _run_tool_call(tool, {"text": "nope"})
        self.assertEqual(events[-1]["decision"], "deny")
        _, notes = _run_tool_call(self.tools()["notes__list_notes"], {})
        self.assertNotIn("nope", notes)

    def test_no_live_chat_means_no_action(self):
        _, result = _run_tool_call(self.tools()["notes__add_note"], {"text": "x"}, can_ask=False)
        self.assertIn("live chat", result)
        self.assertIn("live chat", self.tools()["notes__add_note"].invoke({"text": "x"}))

    def test_switched_off_for_chat_disconnects(self):
        self.assertTrue(self.tools())
        connectors.update(self.connector["id"], {"use_in_chat": False})
        self.assertEqual(self.tools(), {})
        self.assertEqual(mcp_tools.status(), {})

    def test_broken_server_is_left_out(self):
        connectors.create(name="broken", kind="local", command=[sys.executable, "-c", "raise SystemExit(1)"])
        self.assertEqual(set(self.tools()), {"notes__list_notes", "notes__add_note"})
        broken = [s for s in mcp_tools.status().values() if not s["connected"]]
        self.assertEqual(len(broken), 1)
        self.assertTrue(broken[0]["error"])


class ApprovalRegistryTests(unittest.TestCase):
    def test_answer_and_cancel(self):
        self.assertFalse(chat_approvals.answer("0" * 32, "allow"))
        with self.assertRaises(ValueError):
            chat_approvals.answer("0" * 32, "maybe")
        self.assertEqual(chat_approvals.ask({"tool": "x"}), "unavailable")  # outside a graph
        entry = {"event": threading.Event(), "decision": None, "thread": "t9"}
        chat_approvals._pending["a" * 32] = entry
        self.addCleanup(chat_approvals._pending.clear)
        self.assertEqual(chat_approvals.cancel_thread("t9"), 1)
        self.assertEqual(entry["decision"], "deny")
        self.assertFalse(chat_approvals.answer("a" * 32, "allow"))  # already answered

    def test_tool_names_are_safe_and_unique(self):
        used = set()
        self.assertEqual(mcp_tools._tool_name("gh", "get.issue", used), "gh__get_issue")
        self.assertEqual(mcp_tools._tool_name("gh", "get issue", used), "gh__get_issue_2")
        self.assertLessEqual(len(mcp_tools._tool_name("x" * 40, "y" * 40, used)), 64)


class ApprovalRouteTests(unittest.TestCase):
    def test_unknown_approval_is_404(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.chat import chat_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(chat_router, prefix="/api")
        client = TestClient(app)
        self.assertEqual(client.post(f"/api/chat/approvals/{'b' * 32}", json={"decision": "allow"}).status_code, 404)
        self.assertEqual(client.post("/api/chat/approvals/x", json={"decision": "allow"}).status_code, 404)
        self.assertEqual(client.post(f"/api/chat/approvals/{'b' * 32}", json={"decision": "yes"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()

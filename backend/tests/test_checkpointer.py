"""MySQLCheckpointSaver against an in-memory SQLite database, driven by LangGraph."""
import asyncio
import operator
import pickle
import unittest
import uuid
from typing import Annotated, TypedDict

from tests import _helpers

_helpers.use_sqlite()

from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from langgraph.graph.message import add_messages  # noqa: E402

import app.database.mysql_checkpoint as mc  # noqa: E402
from app.database.mysql_checkpoint import LegacyCheckpointError, MySQLCheckpointSaver, dumps, loads  # noqa: E402


class S(TypedDict):
    messages: Annotated[list, add_messages]


def chat_graph(saver):
    g = StateGraph(S)
    g.add_node("n", lambda s: {"messages": [AIMessage("reply")]})
    g.add_edge(START, "n")
    g.add_edge("n", END)
    return g.compile(checkpointer=saver)


def cfg():
    return {"configurable": {"thread_id": str(uuid.uuid4())}}


class CheckpointerTests(unittest.TestCase):
    def setUp(self):
        self.saver = MySQLCheckpointSaver()
        self.app = chat_graph(self.saver)

    def test_round_trip(self):
        c = cfg()
        self.app.invoke({"messages": [HumanMessage("hi")]}, c)
        self.app.invoke({"messages": [HumanMessage("again")]}, c)
        contents = [m.content for m in self.app.get_state(c).values["messages"]]
        self.assertEqual(contents, ["hi", "reply", "again", "reply"])

    def test_list_limit_filter_before_and_parent(self):
        c = cfg()
        for i in range(3):
            self.app.invoke({"messages": [HumanMessage(str(i))]}, c)
        history = list(self.app.get_state_history(c, limit=2))
        self.assertEqual(len(history), 2)
        inputs = list(self.app.get_state_history(c, filter={"source": "input"}))
        self.assertTrue(inputs and all(h.metadata["source"] == "input" for h in inputs))
        older = list(self.saver.list(c, before=history[0].config))
        self.assertEqual(len(older), len(list(self.saver.list(c))) - 1)
        state = self.app.get_state(c)
        self.assertIsNotNone(state.parent_config)
        self.assertIsNotNone(self.saver.get_tuple(state.parent_config))

    def test_pending_writes_resume(self):
        runs = {"p1": 0}
        fail = {"on": True}

        class P(TypedDict):
            out: Annotated[list, operator.add]

        def p1(s):
            runs["p1"] += 1
            return {"out": ["p1"]}

        def p2(s):
            if fail["on"]:
                raise RuntimeError("flaky")
            return {"out": ["p2"]}

        g = StateGraph(P)
        g.add_node("p1", p1)
        g.add_node("p2", p2)
        g.add_edge(START, "p1")
        g.add_edge(START, "p2")
        g.add_edge("p1", END)
        g.add_edge("p2", END)
        app = g.compile(checkpointer=self.saver)
        c = cfg()
        with self.assertRaises(RuntimeError):
            app.invoke({"out": []}, c)
        fail["on"] = False
        app.invoke(None, c)
        self.assertEqual(runs["p1"], 1)
        self.assertEqual(sorted(app.get_state(c).values["out"]), ["p1", "p2"])

    def test_async(self):
        c = cfg()

        async def go():
            await self.app.ainvoke({"messages": [HumanMessage("a")]}, c)
            return await self.saver.aget_tuple(c)

        self.assertEqual(len(asyncio.run(go()).checkpoint["channel_values"]["messages"]), 2)

    def test_pruning(self):
        old = mc.MAX_CHECKPOINTS_PER_THREAD
        mc.MAX_CHECKPOINTS_PER_THREAD = 4
        try:
            c = cfg()
            for i in range(5):
                self.app.invoke({"messages": [HumanMessage(str(i))]}, c)
            self.assertEqual(len(list(self.saver.list(c))), 4)
            self.assertEqual(len(self.app.get_state(c).values["messages"]), 10)
        finally:
            mc.MAX_CHECKPOINTS_PER_THREAD = old

    def test_delete_thread_and_ignore_late_writes(self):
        c = cfg()
        self.app.invoke({"messages": [HumanMessage("x")]}, c)
        tid = c["configurable"]["thread_id"]
        self.assertIn(tid, self.saver.list_thread_ids())
        self.saver.delete_thread(tid)
        self.app.update_state(c, {"messages": [AIMessage("late")]}, as_node="n")
        self.assertNotIn(tid, self.saver.list_thread_ids())

    def test_special_writes_overwrite_regular_do_not(self):
        c = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": "", "checkpoint_id": "x1"}}
        self.saver.put_writes(c, [("messages", "first")], "t")
        self.saver.put_writes(c, [("messages", "second")], "t")
        self.saver.put_writes(c, [("__error__", "e1")], "t")
        self.saver.put_writes(c, [("__error__", "e2")], "t")
        session = self.saver.session_factory()
        try:
            writes = self.saver._pending_writes(session, c["configurable"]["thread_id"], "", "x1")
        finally:
            session.close()
        self.assertIn(("t", "messages", "first"), writes)
        self.assertIn(("t", "__error__", "e2"), writes)

    def test_no_pickle(self):
        self.assertEqual(loads(dumps({"a": [1, 2]})), {"a": [1, 2]})
        with self.assertRaises(LegacyCheckpointError):
            loads(pickle.dumps({"a": 1}))


if __name__ == "__main__":
    unittest.main()

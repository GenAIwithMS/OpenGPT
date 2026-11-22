"""Agent sessions: runs with a scripted model, questions, approvals, stop, limits, routes."""
import unittest
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessage, ToolMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402

from app import llm  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402
from app.exceptions import ValidationError  # noqa: E402
from app.router.agent import agent_router  # noqa: E402
from app.services import agent, chat_approvals  # noqa: E402
from app.services.agent import graph as agent_graph  # noqa: E402
from app.services.agent import runner, store  # noqa: E402


def call(name, args=None, call_id=None):
    return {"name": name, "args": args or {}, "id": call_id or f"call_{name}", "type": "tool_call"}


class Scripted:
    """A chat model that answers with the given messages, in order."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.seen = []

    def bind_tools(self, tools):
        return self

    def invoke(self, messages, config=None):
        self.seen.append(messages)
        if not self.responses:
            return AIMessage(content="Nothing more to do.")
        reply = self.responses.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


counts = {"read": 0, "write": 0}
stop_target = {"id": ""}


@tool
def Read_things() -> str:
    """Read something (no approval)."""
    counts["read"] += 1
    return "three things"


@tool
def Change_things(what: str) -> str:
    """Change something; asks first, like a connector tool."""
    decision = chat_approvals.ask({"connector": "Demo", "tool": "Change things", "arguments": what,
                                   "description": "Changes things", "destructive": True})
    if decision != "allow":
        return "The user did not allow this action."
    counts["write"] += 1
    return f"changed {what}"


@tool
def Stop_me() -> str:
    """A tool that presses Stop while it runs."""
    runner.request_stop(stop_target["id"])
    return "pressed stop"


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        counts.update(read=0, write=0)
        from langgraph.checkpoint.memory import MemorySaver
        self.saved = (runner.build_tools_and_prompt, runner.checkpointer, runner.model, runner.MAX_STEPS)
        runner.checkpointer = MemorySaver()
        runner.build_tools_and_prompt = lambda thread: (
            [agent_graph.Update_plan, agent_graph.Ask_user, Read_things, Change_things, Stop_me], "Be an agent.")
        self.submitted = []
        patcher = mock.patch.object(runner, "submit", side_effect=lambda sid, run_input=None:
                                    self.submitted.append((sid, run_input)))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        runner.build_tools_and_prompt, runner.checkpointer, runner.model, runner.MAX_STEPS = self.saved

    def run_next(self):
        session_id, run_input = self.submitted.pop(0)
        runner.run(session_id, run_input)
        return store.get(session_id)

    def types(self, session_id):
        return [e["type"] for e in store.events(session_id)]


class RunTests(AgentTestCase):
    def test_plans_uses_tools_and_finishes(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Update_plan", {"steps": ["Read", "Report"], "completed": 0})]),
            AIMessage(content="Reading first.", tool_calls=[call("Read_things")]),
            AIMessage(content="There are three things."),
        )
        session = agent.create("Count the things")
        self.assertEqual(session["status"], "queued")
        self.assertEqual(session["title"], "Count the things")
        done = self.run_next()
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["result"], "There are three things.")
        self.assertEqual(self.types(session["id"]),
                         ["task", "status", "plan", "message", "tool_call", "tool_result", "result", "status"])
        events = store.events(session["id"])
        self.assertEqual(events[2]["data"], {"steps": ["Read", "Report"], "completed": 0})
        self.assertEqual(events[4]["data"]["name"], "Read_things")
        self.assertEqual(events[5]["data"]["text"], "three things")
        # Only events after a given one.
        self.assertEqual([e["seq"] for e in agent.get(session["id"], after=6)["events"]], [7, 8])

    def test_question_waits_and_resumes_with_the_answer(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Ask_user", {"question": "Which colour?"})]),
            AIMessage(content="Blue it is."),
        )
        session = agent.create("Pick a colour")
        waiting = self.run_next()
        self.assertEqual(waiting["status"], "waiting")
        self.assertEqual(waiting["waiting"]["kind"], "question")
        self.assertEqual(waiting["waiting"]["question"], "Which colour?")
        with self.assertRaises(ValidationError):
            agent.decide(session["id"], "allow")   # it's a question, not an approval

        agent.answer(session["id"], "blue")
        done = self.run_next()
        self.assertEqual(done["status"], "done")
        tool_results = [m for m in runner.model.seen[-1] if isinstance(m, ToolMessage)]
        self.assertEqual(tool_results[-1].content, "The user answered: blue")
        self.assertIn("answer", self.types(session["id"]))

    def test_approval_runs_each_call_once(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Read_things"), call("Change_things", {"what": "x"})]),
            AIMessage(content="Changed x."),
        )
        session = agent.create("Change x")
        waiting = self.run_next()
        self.assertEqual(waiting["status"], "waiting")
        self.assertEqual(waiting["waiting"]["kind"], "approval")
        self.assertEqual(waiting["waiting"]["tool"], "Change things")
        self.assertEqual(counts, {"read": 1, "write": 0})

        agent.decide(session["id"], "allow")
        done = self.run_next()
        self.assertEqual(done["status"], "done")
        self.assertEqual(counts, {"read": 1, "write": 1})   # the read did not run again

    def test_pause_and_resume_with_the_database_checkpointer(self):
        # The app's own checkpointer, on a SQLite file with a connection per
        # thread like MySQL (the shared in-memory connection isn't thread-safe).
        import tempfile
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.database.config import DatabaseConfig
        from app.database.models import Base
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        engine = create_engine(f"sqlite:///{folder.name}/agent.db", connect_args={"timeout": 30})
        self.addCleanup(engine.dispose)
        previous = (DatabaseConfig._engine, DatabaseConfig._session_factory)
        self.addCleanup(lambda: setattr(DatabaseConfig, "_engine", previous[0])
                        or setattr(DatabaseConfig, "_session_factory", previous[1]))
        Base.metadata.create_all(engine)
        DatabaseConfig._engine, DatabaseConfig._session_factory = engine, sessionmaker(bind=engine)
        runner.checkpointer = None
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Read_things"), call("Change_things", {"what": "y"})]),
            AIMessage(content="Changed y."),
        )
        session = agent.create("Change y")
        self.assertEqual(self.run_next()["status"], "waiting")
        agent.decide(session["id"], "allow")
        self.assertEqual(self.run_next()["status"], "done")
        self.assertEqual(counts, {"read": 1, "write": 1})
        agent.delete(session["id"])
        self.assertIsNone(agent.runner_state(session["id"]))

    def test_denied_approval_changes_nothing(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Change_things", {"what": "x"})]),
            AIMessage(content="The user said no."),
        )
        session = agent.create("Change x")
        self.run_next()
        agent.decide(session["id"], "deny")
        done = self.run_next()
        self.assertEqual(done["status"], "done")
        self.assertEqual(counts["write"], 0)
        results = [e for e in store.events(session["id"]) if e["type"] == "tool_result"]
        self.assertIn("did not allow", results[-1]["data"]["text"])

    def test_stop_then_continue(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Stop_me"), call("Read_things")]),
            AIMessage(content="Finished."),
        )
        session = agent.create("Work")
        stop_target["id"] = session["id"]
        stopped = self.run_next()
        self.assertEqual(stopped["status"], "stopped")
        self.assertEqual(counts["read"], 0)

        agent.continue_(session["id"])
        done = self.run_next()
        self.assertEqual(done["status"], "done")
        self.assertEqual(counts["read"], 1)
        with self.assertRaises(ValidationError):
            agent.continue_(session["id"])   # finished: needs an instruction

        runner.model = Scripted(AIMessage(content="Did more."))
        agent.continue_(session["id"], "Now do more")
        again = self.run_next()
        self.assertEqual(again["result"], "Did more.")
        self.assertIn("instruction", self.types(session["id"]))

    def test_stop_while_waiting_and_continue_shows_the_question_again(self):
        runner.model = Scripted(AIMessage(content="", tool_calls=[call("Ask_user", {"question": "Sure?"})]))
        session = agent.create("Ask me")
        self.run_next()
        self.assertEqual(agent.stop(session["id"])["status"], "stopped")
        again = agent.continue_(session["id"])
        self.assertEqual(again["status"], "waiting")
        self.assertEqual(again["waiting"]["question"], "Sure?")

    def test_step_limit(self):
        runner.MAX_STEPS = 1
        runner.model = Scripted(AIMessage(content="", tool_calls=[call("Read_things")]), AIMessage(content="Done."))
        session = agent.create("Loop")
        stopped = self.run_next()
        self.assertEqual(stopped["status"], "stopped")
        self.assertIn("limit of 1 steps", store.events(session["id"])[-1]["data"]["reason"])

    def test_model_failure(self):
        runner.model = Scripted(RuntimeError("secret upstream detail"))
        session = agent.create("Fail")
        failed = self.run_next()
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn("secret", failed["error"])

    def test_restart_recovery(self):
        running = agent.create("Was running")
        queued = agent.create("Was queued")
        store.update(running["id"], status="running")
        self.submitted.clear()
        with mock.patch.object(runner._queue, "put") as put:
            runner.recover()
        self.assertEqual(store.get(running["id"])["status"], "interrupted")
        put.assert_called_once_with((queued["id"], None))

    def test_queued_session_stopped_before_it_runs(self):
        runner.model = Scripted(AIMessage(content="Hi"))
        session = agent.create("Wait")
        agent.stop(session["id"])
        self.assertEqual(self.run_next()["status"], "stopped")
        self.assertEqual(runner.model.seen, [])


class HelperTests(unittest.TestCase):
    def test_agent_threads_are_not_chats_and_agent_model_role(self):
        import importlib
        chatbot = importlib.import_module("app.services.chatbot")
        with mock.patch.object(chatbot.check_pointer, "list_thread_ids", return_value=["agent-1", "chat-1"]):
            self.assertEqual(chatbot.retrieve_all_threads(), ["chat-1"])
        env = llm.env_settings()   # not the cached settings: other tests change the env
        self.assertEqual(env["agent_model"], env["model"])

    def test_task_validation(self):
        _helpers.use_sqlite()
        for bad in ("", "   ", "x" * (store.MAX_TASK_CHARS + 1)):
            with self.assertRaises(ValidationError):
                store.create(bad)
        long = store.create("word " * 40)
        self.assertTrue(long["title"].endswith("..."))


class RouteTests(AgentTestCase):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(agent_router, prefix="/api")
        self.client = TestClient(app)

    def test_routes(self):
        c = self.client
        self.assertEqual(c.post("/api/agent/sessions", json={"task": ""}).status_code, 422)
        created = c.post("/api/agent/sessions", json={"task": "Do it"})
        self.assertEqual(created.status_code, 201)
        sid = created.json()["id"]
        self.assertEqual([s["id"] for s in c.get("/api/agent/sessions").json()["sessions"]], [sid])
        self.assertEqual(c.get(f"/api/agent/sessions/{sid}").json()["events"][0]["type"], "task")
        self.assertEqual(c.put(f"/api/agent/sessions/{sid}", json={"title": "Renamed"}).json()["title"], "Renamed")
        self.assertEqual(c.post(f"/api/agent/sessions/{sid}/answer", json={"text": "hi"}).status_code, 422)
        self.assertEqual(c.post(f"/api/agent/sessions/{sid}/approval", json={"decision": "maybe"}).status_code, 422)
        self.assertEqual(c.get("/api/agent/sessions/not-an-id").status_code, 404)

        store.update(sid, status="running")
        self.assertEqual(c.delete(f"/api/agent/sessions/{sid}").status_code, 422)
        with mock.patch.object(runner, "request_stop") as request_stop:
            c.post(f"/api/agent/sessions/{sid}/stop")
        request_stop.assert_called_once_with(sid)
        store.update(sid, status="stopped")
        self.assertEqual(c.delete(f"/api/agent/sessions/{sid}").status_code, 204)
        self.assertEqual(c.get(f"/api/agent/sessions/{sid}").status_code, 404)


if __name__ == "__main__":
    unittest.main()

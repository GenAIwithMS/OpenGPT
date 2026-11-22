"""The agent's browser: site permissions, the engine's questions (logins never stored), saved tools."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database.config import DatabaseConfig  # noqa: E402
from app.database.models import AgentEvent, AgentSession, Base  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402
from app.exceptions import NotFoundError, ValidationError  # noqa: E402
from app.router.agent import agent_router  # noqa: E402
from app.router.browser import browser_router  # noqa: E402
from app.services import agent, browser_engine  # noqa: E402
from app.services.agent import browser, runner, store  # noqa: E402
from app.services.agent import graph as agent_graph  # noqa: E402

FAKE = Path(__file__).with_name("fake_browser_engine.py")
PASSWORD = "hunter2-very-secret"


def call(name, args=None, call_id=None):
    return {"name": name, "args": args or {}, "id": call_id or f"call_{name}", "type": "tool_call"}


class Scripted:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.seen = []

    def bind_tools(self, tools):
        return self

    def invoke(self, messages, config=None):
        self.seen.append(messages)
        return self.responses.pop(0) if self.responses else AIMessage(content="Done.")


class BrowserTestCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        # A database file with a connection per thread: the run happens in another thread.
        engine = create_engine(f"sqlite:///{self.folder}/db.sqlite", connect_args={"timeout": 30})
        self.addCleanup(engine.dispose)
        previous = (DatabaseConfig._engine, DatabaseConfig._session_factory)
        self.addCleanup(lambda: setattr(DatabaseConfig, "_engine", previous[0])
                        or setattr(DatabaseConfig, "_session_factory", previous[1]))
        Base.metadata.create_all(engine)
        DatabaseConfig._engine, DatabaseConfig._session_factory = engine, sessionmaker(bind=engine)

        self.log = self.folder / "engine.log"
        patches = [
            mock.patch.object(browser, "INTEGRATIONS", self.folder / "integrations"),
            mock.patch.object(browser_engine, "MCP_CLI", FAKE),
            mock.patch.object(browser_engine, "check"),
            mock.patch.object(browser_engine, "node_path", return_value=sys.executable),
            mock.patch.object(browser_engine, "unavailable_reason", return_value=None),
            mock.patch.object(browser_engine, "config", return_value={"api": "chat", "apiKey": "k"}),
            mock.patch.dict(os.environ, {"FAKE_ENGINE_LOG": str(self.log)}),
            mock.patch.object(runner, "submit", side_effect=lambda sid, run_input=None:
                              self.submitted.append((sid, run_input))),
            mock.patch.object(browser, "POLL_SECONDS", 1),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        from langgraph.checkpoint.memory import MemorySaver
        self.saved = (runner.build_tools_and_prompt, runner.checkpointer, runner.model)
        runner.checkpointer = MemorySaver()
        runner.build_tools_and_prompt = lambda thread: (list(browser.TOOLS), "Be an agent.")
        self.submitted = []

    def tearDown(self):
        runner.build_tools_and_prompt, runner.checkpointer, runner.model = self.saved

    def run_next(self, answer_with=None):
        """Run the next queued run in a thread; answer the browser's questions when they come."""
        session_id, run_input = self.submitted.pop(0)
        worker = threading.Thread(target=runner.run, args=(session_id, run_input))
        worker.start()
        while worker.is_alive():
            if answer_with and browser.waiting_for_input(session_id):
                waiting = store.get(session_id)["waiting"]
                answer_with(session_id, waiting)
                answer_with = None
            time.sleep(0.05)
        worker.join()
        return store.get(session_id)

    def engine_calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def everything_stored(self) -> str:
        with DatabaseConfig.get_session_factory()() as db:
            rows = [r.data for r in db.query(AgentEvent).all()]
            rows += [f"{r.waiting} {r.result} {r.error}" for r in db.query(AgentSession).all()]
        return "\n".join(str(r) for r in rows)


class BrowserTaskTests(BrowserTestCase):
    def test_read_task_asks_for_the_site_then_the_login_and_returns_the_result(self):
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Browser_task", {"url": "https://example.com/about",
                                                                    "task": "Read the heading"})]),
            AIMessage(content="The heading is Example Domain."),
        )
        session = agent.create("What's the heading on example.com?")
        waiting = self.run_next()
        self.assertEqual(waiting["status"], "waiting")
        self.assertEqual(waiting["waiting"]["kind"], "approval")
        self.assertEqual(waiting["waiting"]["tool"], "Use example.com")
        self.assertEqual(self.engine_calls(), [])            # nothing started before permission

        agent.decide(session["id"], "allow")

        def give_login(session_id, shown):
            self.assertEqual(shown["kind"], "browser_input")
            question = shown["questions"][0]
            self.assertEqual((question["type"], question["siteOrigin"]), ("credential", "https://example.com"))
            self.assertNotIn("username", question)           # the expected username isn't shown or stored
            with self.assertRaises(ValidationError):
                agent.answer_browser(session_id, "wrong-request", {"login": {}})
            agent.answer_browser(session_id, shown["request_id"],
                                 {"login": {"username": "me", "password": PASSWORD, "saveLogin": False}})

        done = self.run_next(answer_with=give_login)
        self.assertEqual(done["status"], "done")
        self.assertEqual(browser.list_sites(), {"https://example.com": "read"})

        calls = self.engine_calls()
        mint = next(c for c in calls if c["tool"] == "mint")
        self.assertEqual((mint["arguments"]["url"], mint["arguments"]["effect"]), ("https://example.com/about", "read"))
        given = next(c for c in calls if c["tool"] == "provide_input")
        self.assertEqual(given["arguments"]["answers"]["login"]["password"], PASSWORD)   # reached the engine
        self.assertTrue(any(c["mode"] == "serve" for c in calls))                         # then ran the tool

        result = next(e for e in store.events(session["id"]) if e["type"] == "tool_result")
        self.assertIn("Example Domain", result["data"]["text"])
        # The password is nowhere in the database or in what the model saw.
        self.assertNotIn(PASSWORD, self.everything_stored())
        self.assertNotIn(PASSWORD, json.dumps([str(m) for m in runner.model.seen[-1]]))
        self.assertEqual([t["name"] for t in browser.saved_tools()], [mint["arguments"]["name"]])

    def test_every_write_asks_and_a_denied_write_starts_nothing(self):
        browser.set_site("https://example.com", "write")
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Browser_task", {"url": "https://example.com",
                                                                    "task": "Post a comment", "effect": "write"})]),
            AIMessage(content="Not posted."),
        )
        session = agent.create("Post a comment")
        waiting = self.run_next()
        self.assertEqual(waiting["waiting"]["tool"], "Make changes on example.com")
        agent.decide(session["id"], "deny")
        self.assertEqual(self.run_next()["status"], "done")
        self.assertEqual(self.engine_calls(), [])

    def test_stop_while_the_browser_waits_cancels_the_job(self):
        browser.set_site("https://example.com", "read")
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Browser_task", {"url": "https://example.com", "task": "Read it"})]),
        )
        session = agent.create("Read it")

        def press_stop(session_id, shown):
            with self.assertRaises(ValidationError):
                agent.delete(session_id)                     # not while the browser waits
            agent.stop(session_id)

        stopped = self.run_next(answer_with=press_stop)
        self.assertEqual(stopped["status"], "stopped")
        self.assertIn("cancel_job", [c["tool"] for c in self.engine_calls()])
        self.assertNotIn("provide_input", [c["tool"] for c in self.engine_calls()])

    def test_saved_tools_run_again_without_building(self):
        folder = self.folder / "integrations" / "read_heading"
        folder.mkdir(parents=True)
        (folder / "deployment.json").write_text(json.dumps({"name": "read_heading", "description": "Reads it",
            "request": {"url": "https://example.com", "intent": "Read the heading", "effect": "read"}}))
        (folder / "integration.json").write_text(json.dumps({"inputSchema": {"type": "object"}}))
        browser.set_site("https://example.com", "read")
        runner.model = Scripted(
            AIMessage(content="", tool_calls=[call("Browser_tools"), call("Run_browser_tool", {"name": "read_heading"})]),
            AIMessage(content="Example Domain."),
        )
        agent.create("Heading again")
        self.assertEqual(self.run_next()["status"], "done")
        self.assertEqual([c["mode"] for c in self.engine_calls()], ["serve"])

    def test_restart_recovery_for_a_browser_wait(self):
        session = agent.create("Was waiting")
        store.update(session["id"], status="waiting", waiting={"kind": "browser_input", "request_id": "r"})
        with mock.patch.object(runner._queue, "put"):
            runner.recover()
        self.assertEqual(store.get(session["id"])["status"], "interrupted")

    def test_unavailable_browser(self):
        with mock.patch.object(browser_engine, "unavailable_reason", return_value="Node.js 24 is needed."):
            with mock.patch.object(agent_graph, "mcp_tools") as mcp:
                mcp.chat_tools.return_value = []
                tools, _ = agent_graph.build_tools_and_prompt("agent-x")
            self.assertNotIn("Browser_task", [t.name for t in tools])
            with mock.patch.object(browser, "_session_id", return_value="s"):
                self.assertIn("Node.js 24", browser.Browser_task.invoke({"url": "https://example.com", "task": "x"}))


class SiteAndRouteTests(BrowserTestCase):
    def test_sites_tools_and_routes(self):
        self.assertEqual(browser.origin_of("https://Example.com:8443/a?b"), "https://example.com:8443")
        with self.assertRaises(ValidationError):
            browser.origin_of("ftp://example.com")
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(browser_router, prefix="/api")
        app.include_router(agent_router, prefix="/api")
        c = TestClient(app)
        self.assertEqual(c.put("/api/browser/sites", json={"url": "https://a.test/x", "access": "write"}).json(),
                         {"sites": {"https://a.test": "write"}})
        self.assertEqual(c.put("/api/browser/sites", json={"url": "https://a.test", "access": "maybe"}).status_code, 422)
        self.assertEqual(c.get("/api/browser/sites").json(), {"sites": {"https://a.test": "write"}})
        self.assertEqual(c.delete("/api/browser/sites", params={"url": "https://a.test"}).json(), {"sites": {}})
        self.assertEqual(c.delete("/api/browser/sites", params={"url": "https://a.test"}).status_code, 404)
        self.assertEqual(c.get("/api/browser/tools").json(), {"tools": []})
        self.assertEqual(c.delete("/api/browser/tools/../../etc").status_code, 404)
        self.assertEqual(c.get("/api/browser/status").json(), {"available": True, "reason": None})
        session = agent.create("x")
        self.assertEqual(c.post(f"/api/agent/sessions/{session['id']}/browser-input",
                                json={"request_id": "r", "answers": {"a": 1}}).status_code, 422)
        with self.assertRaises(NotFoundError):
            browser.delete_tool("missing_tool")


if __name__ == "__main__":
    unittest.main()

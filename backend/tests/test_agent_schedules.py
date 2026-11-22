"""Scheduled agent tasks: next times (timezones, daylight saving, cron), the scheduler, expiry, routes."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402

from app.database.config import DatabaseConfig  # noqa: E402
from app.database.models import AgentSchedule, AgentSession  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402
from app.exceptions import ValidationError  # noqa: E402
from app.router.agent import agent_router  # noqa: E402
from app.services import agent  # noqa: E402
from app.services.agent import runner, schedules, store  # noqa: E402

UTC = timezone.utc


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


class NextRunTests(unittest.TestCase):
    def test_daily_weekly_once_in_a_timezone(self):
        daily = {"repeat": "daily", "time": "09:00", "timezone": "Asia/Karachi"}   # UTC+5
        self.assertEqual(schedules.next_run(daily, at("2026-11-23T03:00:00")), at("2026-11-23T04:00:00"))
        self.assertEqual(schedules.next_run(daily, at("2026-11-23T04:00:00")), at("2026-11-24T04:00:00"))
        weekly = {"repeat": "weekly", "time": "09:00", "days": [0, 4], "timezone": "UTC"}  # Mon, Fri
        self.assertEqual(schedules.next_run(weekly, at("2026-11-24T10:00:00")), at("2026-11-27T09:00:00"))
        once = {"repeat": "once", "date": "2026-12-01", "time": "18:30", "timezone": "UTC"}
        self.assertEqual(schedules.next_run(once, at("2026-11-23T00:00:00")), at("2026-12-01T18:30:00"))
        self.assertIsNone(schedules.next_run(once, at("2026-12-02T00:00:00")))

    def test_wall_clock_time_across_daylight_saving(self):
        london = {"repeat": "daily", "time": "09:00", "timezone": "Europe/London"}
        self.assertEqual(schedules.next_run(london, at("2026-03-28T10:00:00")), at("2026-03-29T08:00:00"))  # BST
        self.assertEqual(schedules.next_run(london, at("2026-10-24T10:00:00")), at("2026-10-25T09:00:00"))  # GMT
        # 01:30 doesn't exist on the spring-forward day; it still gives one time that day.
        gap = {"repeat": "daily", "time": "01:30", "timezone": "Europe/London"}
        self.assertEqual(schedules.next_run(gap, at("2026-03-28T12:00:00")).date().isoformat(), "2026-03-29")

    def test_cron(self):
        weekday_quarters = {"repeat": "cron", "cron": "*/15 9-17 * * 1-5", "timezone": "UTC"}
        self.assertEqual(schedules.next_run(weekday_quarters, at("2026-11-28T12:00:00")),  # Saturday
                         at("2026-11-30T09:00:00"))
        self.assertEqual(schedules.next_run(weekday_quarters, at("2026-11-30T09:07:00")), at("2026-11-30T09:15:00"))
        sunday = {"repeat": "cron", "cron": "0 8 * * 7", "timezone": "UTC"}
        self.assertEqual(schedules.next_run(sunday, at("2026-11-23T00:00:00")), at("2026-11-29T08:00:00"))
        for bad in ("* * *", "60 * * * *", "a b c d e", "*/0 * * * *"):
            with self.assertRaises(ValidationError):
                schedules.parse_cron(bad)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        self.submitted = []
        patcher = mock.patch.object(runner, "submit", side_effect=lambda sid, run_input=None:
                                    self.submitted.append(sid))
        patcher.start()
        self.addCleanup(patcher.stop)

    def make(self, **fields):
        spec = {"task": "Summarise my unread issues", "repeat": "daily", "time": "09:00", "timezone": "UTC", **fields}
        return schedules.create(spec)

    def set_next(self, schedule_id, when):
        with DatabaseConfig.get_session_factory()() as db:
            db.get(AgentSchedule, schedule_id).next_run_at = when.replace(tzinfo=None)
            db.commit()

    def test_validation(self):
        with self.assertRaises(ValidationError):
            self.make(repeat="weekly", days=[])
        with self.assertRaises(ValidationError):
            self.make(timezone="Mars/Olympus")
        with self.assertRaises(ValidationError):
            self.make(repeat="once", date="2001-01-01")
        with self.assertRaises(ValidationError):
            self.make(time="25:00")
        self.assertEqual(self.make(repeat="weekly", days=[4, 0, 4])["days"], [0, 4])

    def test_tick_starts_due_runs_once_at_a_time(self):
        schedule = self.make()
        self.set_next(schedule["id"], at("2026-11-23T09:00:00"))
        started = schedules.tick(at("2026-11-23T09:00:30"))
        self.assertEqual(len(started), 1)
        session = store.get(started[0])
        self.assertEqual((session["schedule_id"], session["title"]), (schedule["id"], schedule["title"]))
        updated = schedules.get(schedule["id"])
        self.assertEqual(updated["last_outcome"], "started")
        self.assertTrue(updated["next_run_at"].startswith("2026-11-24T09:00"))

        # Its run is still going: the next time is skipped.
        self.set_next(schedule["id"], at("2026-11-24T09:00:00"))
        self.assertEqual(schedules.tick(at("2026-11-24T09:00:10")), [])
        self.assertEqual(schedules.get(schedule["id"])["last_outcome"], "skipped_busy")
        self.assertEqual([r["id"] for r in schedules.runs(schedule["id"])], started)
        with self.assertRaises(ValidationError):
            schedules.run_now(schedule["id"])

    def test_once_turns_off_after_its_run_and_paused_never_runs(self):
        once = self.make(repeat="once", date="2999-01-01", time="10:00")
        self.assertEqual(schedules.tick(at("2999-01-01T10:01:00")).__len__(), 1)
        self.assertFalse(schedules.get(once["id"])["enabled"])
        paused = schedules.update(self.make()["id"], {"enabled": False})
        self.assertIsNone(paused["next_run_at"])
        self.assertEqual(schedules.tick(at("2999-12-31T00:00:00")), [])

    def test_missed_times_are_skipped_unless_catching_up(self):
        schedule = self.make()
        self.set_next(schedule["id"], datetime.now(UTC) - timedelta(hours=2))
        with mock.patch.dict(os.environ, {"AGENT_SCHEDULE_CATCH_UP": "true"}):
            schedules.recover()
        self.assertNotEqual(schedules.get(schedule["id"])["last_outcome"], "missed")   # left for the tick
        schedules.recover()
        after = schedules.get(schedule["id"])
        self.assertEqual(after["last_outcome"], "missed")
        self.assertGreater(datetime.fromisoformat(after["next_run_at"]), datetime.now(UTC))

    def test_unanswered_approval_expires(self):
        schedule = self.make()
        session = agent.create("Post the summary", schedule_id=schedule["id"])
        store.update(session["id"], status="waiting", waiting={"kind": "approval", "tool": "Post"})
        with DatabaseConfig.get_session_factory()() as db:
            db.get(AgentSession, session["id"]).updated_at = datetime(2026, 1, 1)
            db.commit()
        schedules.tick(datetime(2026, 1, 2, 1, tzinfo=UTC))
        self.assertEqual(store.get(session["id"])["status"], "expired")
        self.assertIn("Nobody answered", store.events(session["id"])[-1]["data"]["reason"])


class ScheduledRunTests(unittest.TestCase):
    def test_a_scheduled_session_is_told_nobody_is_watching(self):
        _helpers.use_sqlite()
        from langgraph.checkpoint.memory import MemorySaver

        seen = []

        class Model:
            def bind_tools(self, tools):
                return self

            def invoke(self, messages, config=None):
                seen.append(messages)
                return AIMessage(content="Ready for you.")

        saved = (runner.build_tools_and_prompt, runner.checkpointer, runner.model)
        runner.build_tools_and_prompt, runner.checkpointer, runner.model = (lambda t: ([], "x"), MemorySaver(), Model())
        try:
            with mock.patch.object(runner, "submit"):
                session = agent.create("Check the news", schedule_id="s-1")
            runner.run(session["id"])
        finally:
            runner.build_tools_and_prompt, runner.checkpointer, runner.model = saved
        first = next(m for m in seen[0] if isinstance(m, HumanMessage))
        self.assertIn("scheduled run", first.content)
        self.assertEqual(store.get(session["id"])["task"], "Check the news")   # the page shows the task as typed


class RouteTests(unittest.TestCase):
    def test_routes(self):
        _helpers.use_sqlite()
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(agent_router, prefix="/api")
        c = TestClient(app)
        body = {"task": "Daily digest", "repeat": "daily", "time": "08:00", "timezone": "Europe/London"}
        created = c.post("/api/agent/schedules", json=body)
        self.assertEqual(created.status_code, 201)
        sid = created.json()["id"]
        self.assertEqual(c.post("/api/agent/schedules", json={**body, "repeat": "hourly"}).status_code, 422)
        self.assertEqual([s["id"] for s in c.get("/api/agent/schedules").json()["schedules"]], [sid])
        self.assertEqual(c.put(f"/api/agent/schedules/{sid}", json={"time": "07:30"}).json()["time"], "07:30")
        self.assertFalse(c.put(f"/api/agent/schedules/{sid}", json={"enabled": False}).json()["enabled"])
        with mock.patch.object(runner, "submit"):
            run = c.post(f"/api/agent/schedules/{sid}/run")
        self.assertEqual(run.status_code, 201)
        self.assertEqual(c.get(f"/api/agent/schedules/{sid}/runs").json()["runs"][0]["id"], run.json()["id"])
        self.assertEqual(c.delete(f"/api/agent/schedules/{sid}").status_code, 204)
        self.assertEqual(c.get(f"/api/agent/schedules/{sid}/runs").status_code, 404)


if __name__ == "__main__":
    unittest.main()

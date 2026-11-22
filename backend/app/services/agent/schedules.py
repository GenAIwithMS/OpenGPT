"""Scheduled agent tasks: a task that starts an agent session at set times.

A schedule repeats ``once`` (date + time), ``daily`` (time), ``weekly`` (days +
time) or by a ``cron`` line ("m h dom mon dow"), in the user's timezone.
Times are wall-clock times in that timezone, so 09:00 stays 09:00 across
daylight saving changes.

The scheduler (a thread in the backend) checks every 30 seconds. A due
schedule starts a normal agent session (its ``schedule_id`` set) that is told
the user isn't watching: it reads and prepares, and anything that changes data
waits for approval, as every change does. An approval nobody answers within
``AGENT_APPROVAL_HOURS`` (default 24) ends the session as ``expired``.

* A schedule never runs twice at once: while its last session still works or
  waits, the next time is skipped (``skipped_busy``).
* A time missed while OpenGPT was off is skipped and shown as ``missed``;
  with ``AGENT_SCHEDULE_CATCH_UP=true`` it runs once at startup instead.
"""
import logging
import os
import threading
import uuid
from datetime import date as Date, datetime, time as Time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.database.config import DatabaseConfig
from app.database.models import AgentSchedule, AgentSession
from app.exceptions import NotFoundError, ValidationError
from app.services.agent import store

logger = logging.getLogger(__name__)

REPEATS = ("once", "daily", "weekly", "cron")
TICK_SECONDS = 30
MAX_SCHEDULES = 100
UTC = timezone.utc


def _hours_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name) or default))
    except ValueError:
        return default


APPROVAL_HOURS = _hours_env("AGENT_APPROVAL_HOURS", 24)


def catch_up() -> bool:
    return (os.getenv("AGENT_SCHEDULE_CATCH_UP") or "").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------- cron

_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))   # minute hour day month weekday (0 and 7 = Sunday)


def _field(text: str, low: int, high: int) -> set[int]:
    values: set[int] = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            step = int(step_text)
            if step < 1:
                raise ValueError
        if part == "*":
            start, end = low, high
        elif "-" in part:
            start, end = (int(x) for x in part.split("-", 1))
        else:
            start = end = int(part)
        if start < low or end > high or start > end:
            raise ValueError
        values.update(range(start, end + 1, step))
    return values


def parse_cron(line: str) -> tuple[set[int], ...]:
    parts = str(line or "").split()
    if len(parts) != 5:
        raise ValidationError("Cron: five fields, minute hour day month weekday (e.g. 0 9 * * 1-5)")
    try:
        fields = [_field(p, lo, hi) for p, (lo, hi) in zip(parts, _RANGES)]
    except ValueError:
        raise ValidationError("Cron: use numbers, *, lists (1,2), ranges (1-5) and steps (*/15) in range")
    # Weekday 7 is also Sunday, as in most cron dialects.
    if 7 in fields[4]:
        fields[4] = (fields[4] - {7}) | {0}
    return tuple(fields)


def _cron_next(line: str, after: datetime, tz: ZoneInfo) -> Optional[datetime]:
    minutes, hours, days, months, weekdays = parse_cron(line)
    day_restricted, weekday_restricted = line.split()[2] != "*", line.split()[4] != "*"
    local = after.astimezone(tz)
    day = local.date()
    for _ in range(400):  # up to a little over a year ahead
        cron_weekday = (day.weekday() + 1) % 7
        if day_restricted and weekday_restricted:   # classic cron: either matches
            day_ok = day.day in days or cron_weekday in weekdays
        else:
            day_ok = day.day in days and cron_weekday in weekdays
        if day.month in months and day_ok:
            for hour in sorted(hours):
                for minute in sorted(minutes):
                    candidate = datetime.combine(day, Time(hour, minute), tz)
                    if candidate > local:
                        return candidate.astimezone(UTC)
        day += timedelta(days=1)
    return None


# ---------------------------------------------------------------- next time

def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(str(name or "UTC"))
    except (ZoneInfoNotFoundError, ValueError):
        raise ValidationError("Timezone: use a name like Europe/London or Asia/Karachi")


def _time(text: Optional[str]) -> Time:
    try:
        hour, minute = (int(x) for x in str(text).split(":"))
        return Time(hour, minute)
    except (ValueError, TypeError):
        raise ValidationError("Time: use HH:MM, e.g. 09:00")


def next_run(spec: dict, after: datetime) -> Optional[datetime]:
    """The schedule's next time after ``after`` (UTC), or None when there is none."""
    tz = _zone(spec.get("timezone"))
    repeat = spec.get("repeat")
    if repeat == "cron":
        return _cron_next(spec.get("cron") or "", after, tz)
    at = _time(spec.get("time"))
    local = after.astimezone(tz)
    if repeat == "once":
        try:
            day = Date.fromisoformat(str(spec.get("date")))
        except ValueError:
            raise ValidationError("Date: use YYYY-MM-DD")
        when = datetime.combine(day, at, tz)
        return when.astimezone(UTC) if when > local else None
    days = {int(d) for d in spec.get("days") or []} if repeat == "weekly" else set(range(7))
    day = local.date()
    for _ in range(8):
        if day.weekday() in days:
            when = datetime.combine(day, at, tz)
            if when > local:
                return when.astimezone(UTC)
        day += timedelta(days=1)
    return None


# ---------------------------------------------------------------- schedules

def _session():
    return DatabaseConfig.get_session_factory()()


def _now() -> datetime:
    return datetime.now(UTC)


def _naive(dt: Optional[datetime]) -> Optional[datetime]:
    """Stored as naive UTC (TIMESTAMP)."""
    return dt.astimezone(UTC).replace(tzinfo=None) if dt else None


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    return dt.replace(tzinfo=UTC) if dt and dt.tzinfo is None else dt


def _info(row: AgentSchedule) -> dict:
    return {
        "id": row.id, "title": row.title, "task": row.task, "repeat": row.repeat, "time": row.time,
        "date": row.date, "days": [int(d) for d in row.days.split(",")] if row.days else [],
        "cron": row.cron, "timezone": row.timezone, "enabled": bool(row.enabled),
        "next_run_at": _aware(row.next_run_at).isoformat() if row.next_run_at else None,
        "last_run_at": _aware(row.last_run_at).isoformat() if row.last_run_at else None,
        "last_outcome": row.last_outcome,
    }


def _clean(fields: dict) -> dict:
    """Validate a full schedule spec; returns the columns to store."""
    task = str(fields.get("task") or "").strip()
    if not task:
        raise ValidationError("Task: describe what the agent should do")
    if len(task) > store.MAX_TASK_CHARS:
        raise ValidationError(f"Task: at most {store.MAX_TASK_CHARS} characters")
    repeat = fields.get("repeat")
    if repeat not in REPEATS:
        raise ValidationError("Repeat: once, daily, weekly or cron")
    out = {"task": task, "repeat": repeat, "timezone": str(fields.get("timezone") or "UTC")[:64],
           "title": store.clean_title(fields.get("title") or store.title_from_task(task)),
           "time": None, "date": None, "days": None, "cron": None}
    _zone(out["timezone"])
    if repeat == "cron":
        out["cron"] = " ".join(str(fields.get("cron") or "").split())
        parse_cron(out["cron"])
    else:
        out["time"] = _time(fields.get("time")).strftime("%H:%M")
    if repeat == "once":
        out["date"] = str(fields.get("date") or "")
    if repeat == "weekly":
        days = sorted({int(d) for d in fields.get("days") or [] if str(d).isdigit() and 0 <= int(d) <= 6})
        if not days:
            raise ValidationError("Days: pick at least one day")
        out["days"] = ",".join(map(str, days))
    return out


def _spec(row_or_dict) -> dict:
    get = (lambda k: getattr(row_or_dict, k)) if isinstance(row_or_dict, AgentSchedule) else row_or_dict.get
    days = get("days")
    if isinstance(days, str):
        days = [int(d) for d in days.split(",") if d]
    return {"repeat": get("repeat"), "time": get("time"), "date": get("date"), "days": days,
            "cron": get("cron"), "timezone": get("timezone")}


def create(fields: dict) -> dict:
    values = _clean(fields)
    upcoming = next_run(_spec(values), _now())
    if upcoming is None:
        raise ValidationError("That time has passed. Pick a time in the future.")
    with _session() as db:
        if db.query(AgentSchedule).count() >= MAX_SCHEDULES:
            raise ValidationError(f"At most {MAX_SCHEDULES} schedules")
        row = AgentSchedule(id=str(uuid.uuid4()), enabled=True, next_run_at=_naive(upcoming), **values)
        db.add(row)
        db.commit()
        return _info(row)


def update(schedule_id: str, fields: dict) -> dict:
    with _session() as db:
        row = _get(db, schedule_id)
        current = {**_info(row), **{k: v for k, v in fields.items() if v is not None}}
        values = _clean(current)
        for key, value in values.items():
            setattr(row, key, value)
        if "enabled" in fields and fields["enabled"] is not None:
            row.enabled = bool(fields["enabled"])
        row.next_run_at = _naive(next_run(_spec(values), _now())) if row.enabled else None
        db.commit()
        return _info(row)


def _get(db, schedule_id: str) -> AgentSchedule:
    row = db.get(AgentSchedule, str(schedule_id))
    if row is None:
        raise NotFoundError("Schedule not found")
    return row


def get(schedule_id: str) -> dict:
    with _session() as db:
        return _info(_get(db, schedule_id))


def list_schedules() -> list[dict]:
    with _session() as db:
        rows = db.query(AgentSchedule).order_by(AgentSchedule.created_at).all()
        return [_info(r) for r in rows]


def delete(schedule_id: str) -> None:
    with _session() as db:
        db.delete(_get(db, schedule_id))
        db.commit()


def runs(schedule_id: str, limit: int = 20) -> list[dict]:
    with _session() as db:
        _get(db, schedule_id)
        rows = (db.query(AgentSession).filter_by(schedule_id=schedule_id)
                .order_by(AgentSession.created_at.desc()).limit(limit).all())
        return [{"id": r.id, "status": r.status, "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows]


# ---------------------------------------------------------------- the scheduler

def _busy(db, schedule_id: str) -> bool:
    return db.query(AgentSession).filter(
        AgentSession.schedule_id == schedule_id,
        AgentSession.status.in_(("queued", "running", "waiting"))).count() > 0


def run_now(schedule_id: str) -> dict:
    """Start the schedule's task now (the Run now button); its times stay as they are."""
    from app.services import agent
    with _session() as db:
        row = _get(db, schedule_id)
        if _busy(db, row.id):
            raise ValidationError("Its last run is still working or waiting for you.")
        task, title = row.task, row.title
    return agent.create(task, schedule_id=schedule_id, title=title)


def recover() -> None:
    """At startup: times missed while OpenGPT was off are skipped (or run once with catch-up)."""
    now = _now()
    with _session() as db:
        for row in db.query(AgentSchedule).filter(AgentSchedule.enabled.is_(True)).all():
            due = _aware(row.next_run_at)
            if due is None or due > now:
                continue
            if catch_up():
                continue  # the first tick runs it
            row.last_outcome = "missed"
            row.last_run_at = _naive(due)
            upcoming = next_run(_spec(row), now)
            row.next_run_at = _naive(upcoming)
            if upcoming is None:
                row.enabled = False
        db.commit()


def tick(now: Optional[datetime] = None) -> list[str]:
    """Start due schedules and expire old approvals. Returns the sessions started."""
    from app.services import agent
    now = now or _now()
    started = []
    with _session() as db:
        due = (db.query(AgentSchedule)
               .filter(AgentSchedule.enabled.is_(True), AgentSchedule.next_run_at.isnot(None),
                       AgentSchedule.next_run_at <= _naive(now)).all())
        plans = []
        for row in due:
            busy = _busy(db, row.id)
            row.last_run_at = _naive(now)
            row.last_outcome = "skipped_busy" if busy else "started"
            upcoming = next_run(_spec(row), now)
            row.next_run_at = _naive(upcoming)
            if upcoming is None:
                row.enabled = False
            if not busy:
                plans.append((row.id, row.task, row.title))
        db.commit()
    for schedule_id, task, title in plans:
        try:
            started.append(agent.create(task, schedule_id=schedule_id, title=title)["id"])
        except Exception:  # noqa: BLE001 - one schedule must not stop the others
            logger.exception("Scheduled task %s couldn't start", schedule_id)
    _expire_approvals(now)
    return started


def _expire_approvals(now: datetime) -> None:
    """A scheduled session waiting for an approval longer than APPROVAL_HOURS ends as expired."""
    limit = _naive(now - timedelta(hours=APPROVAL_HOURS))
    with _session() as db:
        stale = [r.id for r in db.query(AgentSession).filter(
            AgentSession.schedule_id.isnot(None), AgentSession.status == "waiting",
            AgentSession.updated_at <= limit).all()]
    for session_id in stale:
        if (store.get(session_id)["waiting"] or {}).get("kind") == "approval":
            store.update(session_id, status="expired", waiting=None)
            store.add_event(session_id, "status", {
                "status": "expired",
                "reason": f"Nobody answered within {APPROVAL_HOURS} hours, so nothing was changed."})


_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def _loop() -> None:
    while not _stop.wait(TICK_SECONDS):
        try:
            tick()
        except Exception:  # noqa: BLE001
            logger.exception("Scheduler tick failed")


def start() -> None:
    global _thread
    recover()
    if _thread is None or not _thread.is_alive():
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="agent-scheduler", daemon=True)
        _thread.start()


def shutdown() -> None:
    _stop.set()

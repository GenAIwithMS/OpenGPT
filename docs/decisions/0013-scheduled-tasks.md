# 0013. Scheduled tasks prepare and wait

Status: accepted (2026-11-23)

## Context

Users want tasks to run at set times ("every Monday at 09:00, summarise my
GitHub activity and post it on LinkedIn"). A scheduled run happens while the
user is away, but OpenGPT asks before every change, so a run can't simply act
on its own.

## Decision

- A schedule starts a normal agent session. Its task gets a note that nobody
  is watching, so the agent prepares and then **waits for approval** at the
  first change. Pre-approved actions were considered and left out: a
  schedule that acts with no one checking is the riskier default.
- An approval nobody answers within a day (configurable) **expires**; nothing
  is changed.
- **One run at a time** per schedule: a time is skipped while the last run
  still works or waits.
- The scheduler is a thread in the backend, so **OpenGPT must be running**.
  A missed time is skipped and shown, unless catch-up is turned on, so a
  restart after a week doesn't fire a week of runs.
- Times are wall-clock times in the user's timezone, so daylight saving
  doesn't move them. Cron lines use a small parser, with no extra dependency.

## Consequences

- A scheduled task that needs a website login stops to ask each time (logins
  aren't saved; see 0012).
- Nothing runs while OpenGPT is off; a desktop or server install that stays
  up is needed for schedules to be reliable.

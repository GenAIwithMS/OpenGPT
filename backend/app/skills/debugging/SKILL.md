---
name: debugging
description: A systematic way to find the cause of a bug before fixing it - reproduce, narrow down, form and test hypotheses, then fix and verify. Use when something fails, crashes, gives wrong output or behaves unexpectedly.
---

# Debugging

Find the cause before changing code. A fix without a known cause usually
moves the bug somewhere else.

## 1. Reproduce

- Get the exact error, stack trace, input and environment (versions, OS,
  configuration).
- Find the smallest steps that make it happen every time. If it is
  intermittent, note what differs between good and bad runs.

## 2. Narrow down

- Read the stack trace from the first line in your own code.
- Bisect: remove half of the input, the code path or the recent changes
  (`git bisect` for regressions) until the failure points at one place.
- Add temporary logging around the suspect lines: values in, values out.

## 3. Hypothesize and test

- Write down one specific explanation ("the cache returns the old user
  because the key ignores the tenant").
- Predict what you would see if it were true, then check. If the check
  fails, drop the hypothesis; don't bend the evidence.

## 4. Fix and verify

- Fix the cause, not the symptom. Keep the change as small as possible.
- Add a test that fails without the fix and passes with it.
- Re-run the original reproduction and the related tests. Remove the
  temporary logging.

## Report

State the cause in one or two sentences, the fix, and how you verified it.
If you could not find the cause, say what you ruled out and what to try
next.

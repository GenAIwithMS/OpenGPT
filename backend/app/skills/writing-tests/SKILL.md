---
name: writing-tests
description: Write focused automated tests that prove behaviour and catch regressions, following the project's existing test style. Use when the user asks to add tests, improve coverage, or verify a fix.
---

# Writing tests

## Before writing

- Find the existing tests and copy their style: framework, file layout,
  naming, fixtures and helpers. Run them once to see how they are run.
- Decide what behaviour matters: the public contract, not private details.

## What to cover

- The normal case, with realistic input.
- Edges: empty, None/null, zero, boundaries (first/last, min/max), very
  large, unicode, duplicates.
- Failures: invalid input, a dependency that errors or times out, missing
  permissions. Check the error type and message the caller sees.
- For a bug fix: a test that reproduces the bug. Confirm it fails without
  the fix.

## How to write them

- One behaviour per test, named after it (`test_expired_token_is_refreshed`).
- Arrange, act, assert. Keep setup short; use helpers for repeated setup.
- No real network, clock or randomness unless the test is about them: use
  fakes, fixed times and seeds. Clean up files and processes you create.
- Assert on outcomes the user would notice, not on how the code got there.

## Finish

Run the new tests and the whole suite. Report what is covered, anything
deliberately left out, and the command to run the tests.

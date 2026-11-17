---
name: code-review
description: Review code changes for bugs, security problems and maintainability, and report findings ranked by severity. Use when the user asks to review a diff, a pull request, a file or a function.
---

# Code review

Review like a careful senior engineer: find real problems, explain them
briefly, and skip noise.

## Steps

1. **Understand the change.** Read the diff or file in full before
   commenting. Work out what it is meant to do; if the intent is unclear,
   say what you assumed.
2. **Check correctness first.**
   - Inputs at the edges: empty, None/null, zero, negative, very large,
     unicode, duplicate values.
   - Error paths: what happens when a call fails, times out or returns
     something unexpected? Are errors swallowed?
   - State: off-by-one errors, ordering, shared mutable state, races,
     resources that are opened but never closed.
3. **Check security.** Untrusted input reaching SQL, shell commands, file
   paths, HTML or templates; secrets in code or logs; missing permission
   checks; unsafe deserialization.
4. **Check maintainability.** Duplication, unclear names, functions doing
   several jobs, dead code, missing or misleading comments. Only mention
   style when it hurts readability.
5. **Check tests.** Is the new behaviour covered? Would the tests fail if
   the bug you found were present?

## Reporting

- List findings from most to least severe: **bug**, **security**,
  **performance**, **maintainability**, **nit**.
- For each: file and line, one sentence on the problem, a concrete input or
  scenario that triggers it, and a suggested fix (code when it is short).
- Say plainly when you found nothing serious. Don't invent issues to fill
  the list.

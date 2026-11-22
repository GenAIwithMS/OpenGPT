---
name: publication
description: What publication checks, which private values never go into published files, and how to act on each rejection.
---

# Publishing a build

Read this before your first `finish_build`. `finish_build` asks the host to review the current
source and publish it against an execution that already ran: a read's completed example, or the
write session step that recorded the confirmation (or read back the saved state; for a write
declared unverifiable, the step that committed). It never runs anything again. A read publishes
the schemas in its current source, which must still decode its example's own input and output; a
write publishes `src/tool.mjs`, composed from its act steps, with schemas the host extracts
offline and checks against the caller's input.

## Validate the outcome of the operation

Use intermediate observations while exploring a site and building the flow. In a published
multi-action browser operation, remove assertions whose only purpose is to declare each
intermediate action successful. Validate the requested outcome after the full flow, using the
site's meaningful result or saved-state readback. An intermediate UI state can be transient;
an assertion about it can stop a flow before the final outcome is available.

Keep Playwright's normal awaited actions and readiness waits, reads needed to choose the next
action, the input read-back before returning, native errors, and caller, authority, destination
and write-replay guards. These are
part of executing the flow, not extra success assertions. Do not add fixed pauses to make an
intermediate state pass. When a final check fails, use the retained execution evidence to
diagnose where the flow diverged.

Make this choice in source before running the full proving example. A changed read flow needs
an example of that changed source under the usual read rules. Do not strip checks from source
after its example and publish it against the old execution. For a write, preserve the recorded
session, confirmation and no-replay rules; do not run a possibly committed action again merely
to prove an edited script.

## Name and describe the tool<!-- opengpt:section publication.site-heading -->

`finish_build`'s metadata names the tool<!-- opengpt:section publication.metadata-readers:start
 and describes it in the public definition Guardian reviews
(`publication/definition.json`)
opengpt:section publication.metadata-readers:end -->:

- **Name.** A 2–5 word verb phrase naming what the tool does: "Search flights", "Get claim
  status", "Cancel reservation". Leave out the site's name<!-- opengpt:section publication.integration-name --> and words
  like "tool".<!-- opengpt:section publication.unique-name -->
- **Description.** 1–3 sentences for an agent deciding whether to call this tool: what it does,
  what it returns, and when to use it instead of a similar tool. Briefly state the design
  decisions, limits and interpretations a caller needs to read the result right (results per
  page, date range, the site's default location, what it doesn't cover) and, for a write,
  exactly what changes on the site and whether it can be undone. Don't repeat the inputs; their field descriptions cover them.<!-- opengpt:section publication.site-naming -->

## Check before `finish_build`

Before your first `finish_build`, prefer checking the tool against each rule the request states
for its inputs, outputs and refusals.

Before each `finish_build`, the first and every later one, prefer one pass over your own source
with four questions: for each output field, which line fills it and whether its description says
where that value comes from; for each branch that returns, whether it returns every required field
with values read on this run; for each value the caller gave or answered through `ask`, whether the
output labels it as caller input; and whether any live test case still ends failed or flaky on the
source you publish. Fix what this finds before you call.

Guardian reports what it finds in rounds, and each round costs minutes, so settle all of these
first:

- **Schemas.** The input schema accepts exactly what the code accepts, every input and output
  field has its own description, every output field is typed and each constraint has a JSON
  Schema form (core skill, the input schema). A read's schemas come from current source, so
  fix one there and call again with the same `executionId`; a required output field its example
  did not return is refused (`contract_output_mismatch`). Values the request needs are required
  and non-null: never loosen one. Only a record whose own page shows no such value may return
  null, together with a field saying why; a description never excuses a nullable needed value,
  and Guardian refuses a schema that makes one optional or nullable. No output is a constant
  where the page shows a value, and titles and names are returned in full (core skill, output
  fields).
- **Typed output.** Prefer parsing what the page shows into typed fields over returning a
  result row, card or itinerary as one text blob or summary. Give each fact a caller would
  filter, sort or compare its own field (core skill, output fields). A flight card reading "XX
  234, 7:00 AM-3:31 PM, Nonstop, 5h 31m" should return `{ "flight_number": "XX 234",
  "departure_time": "2026-11-16T07:00:00-08:00", "arrival_time": "2026-11-16T15:31:00-05:00",
  "stops": 0, "duration_minutes": 331 }` rather than `{ "summary": "XX 234 7:00 AM ..." }`. The site's own text may stand in for one value that
  truly does not parse, with that field's description saying so; a record's whole text is only
  an `include` section (core skill, optional sections).
- **Clean output.** Every string is clean displayed text: no code, styles, markup, template
  leftovers, control labels or repeated entries. `finish_build` refuses an example whose output
  holds code, styles, markup or template leftovers, and gives the publication review the host's
  other output checks as leads. Check each finding against the page and fix a wrong read in
  source. A check can be wrong: when a flagged value is correct as returned, such as code on a
  tool that returns code or the page's own text that only resembles code, name its path and
  check with the reason in `finish_build`'s `outputOverrides`; Guardian checks the reason against
  the captures. A field that holds code or markup on purpose may instead declare it with
  `contentMediaType`, such as `text/javascript`, `text/css` or `text/html`: its findings then name
  that type and never block, and Guardian checks that the type fits what the field holds.
- **Lists.** A tool that returns a list the site can run past one page takes `limit` and
  `cursor` and returns one page with `next_cursor` (pagination skill), or says the site shows the
  whole list at once.
- **Inputs.** Nothing the caller could vary is a literal, and every control the flow offers
  that narrows, orders or configures what the tool returns, a location included, is an optional
  input, even one the request never mentioned and one you never asked about (core skill, the
  input schema; the search skill, "Find the filters"). The one exception is a choice the request,
  the caller or the owner declined, which is never an input for any caller (core skill), unless
  it is a costly choice a write still meets on its path (writes skill). Guardian counts such an input as
  part of the tool, never as scope drift or an unsupported claim. Each input you accept is
  applied and read back (core skill, the input schema, and `AGENTS.md`; the search skill for a search). An input
  that tailors the answer, such as a location, store or vehicle, that the site won't apply
  returns what the site showed with the applied value beside the caller's and the site's
  message, which review accepts in place of a refusal (core skill, "Inputs that tailor the
  answer").
- **Personal data.** No personal data from the session in source, schemas, examples or metadata:
  names, emails, account numbers, addresses or the owner's answers (the list below).
- **Claims.** The name and description claim only what the example or session reached: a
  session that stopped at a form's third step never claims the steps after it. An output field
  the code reads from each record's own element on every run is no overclaim when the example's
  record lacked that fact. A field the code never reads is a defect, not a limit to disclose,
  and a fact the page shows is never listed as unsupported instead of being returned.
- **Coverage.** `coverage` says what exercised each behavior: live (the example or the act
  session, and a read's live tests, with the input each ran, such as page 1 of one
  query), offline only where a read signed out ran such checks (fixture<!-- opengpt:section publication.saved-http --> and parser tests, synthetic cases such as page boundaries included) and untested (such as
  a later page or another layout, live). Name each exposed input under
  the run that set it, or under untested (testing skill). An offline or synthetic check never
  stands in for a live one. For a read signed out, the host adds its own line from its record of
  your live test cases and gives the review that record (`publication/tests.json`): each case's
  purpose, input, expectation and result on the source you publish, and what you listed under
  `notTested` with why. Guardian judges the tool's claims no passing case tests, and failing and
  stale cases, and checks every `notTested` reason against the captures and the request. When a
  claimed part of the output only appears for some inputs and no case you can run shows it,
  prefer listing it in `notTested` with the reason and leaving it out of the description. Prefer
  that over asking the owner for evidence they may not have. A signed-in read reports its example
  and its signed-in cases, and gets the same host record of the
  cases it ran signed in; the review judges a failing case but never a gap. A write reports its
  one run, the act session, and lists what that run did not exercise as untested without testing
  it; the review judges that run alone.
- **Errors.** A thrown message states the cause the code observed, such as a status or a missing
  element, never a guessed one.
- **Edge cases.** Review misses these most often, so check each before every `finish_build`; the
  name in brackets is the rule a miss comes back under:
  - a search or filter with no results returns the empty result, never a throw ("Wrong
    failure");
  - every applied filter or option is read back from the page as the value the site applied,
    such as the chosen option's label, never `true` ("Applied without readback");
  - a requested value the site does not offer throws `InvalidInput` with the site's choices, and
    one the page ignored throws `InputNotApplied` unless it tailors the answer (core skill) or is
    a search query the site corrected, returned with `applied_query` and `query_corrected` (search
    skill); with
    no results a sort has nothing to apply, so return the empty result ("Unapplied supplied
    input");
  - A write's `<input>_note` reporting a value the site rewrote as it was typed, on leaving the
    field, or through its one suggestion is not unapplied input; the tool read the site's version
    back and returns it.
  - a free-text place, name or venue that matches several of the site's options equally either
    takes the first in the site's order and returns the one it used, as the site labels it, or
    lists them for the caller to choose one, as the tool decides (core skill, the input schema);
  - a check that refuses a past date compares with today in the site's time zone, or the
    place's, not with today in UTC (caller-input skill) ("Past date in UTC");
  - in a read signed out, each declared input is used, or changed from its default, by a passing
    case, and a case whose expectation you changed because the site itself gave another answer
    for that input names the capture of that answer, such as the site's no-results page for that
    search, by its exact path in its `purpose` and in `coverage` (testing skill).
- **Write options.** Each option on the path is an input even when the caller left the choice to
  you; the script never takes the first, the alphabetically first or a hard-wired value.
- **Login URL.** A signed-in tool publishes the `loginUrl` you signed in from, and every run opens
  it. Check it is the site's own sign-in link as you clicked it (auth skill): no `state`, `nonce`,
  `code_challenge`, `code`, `session_state` or signed token in its query or fragment, and no
  identity provider's authorize endpoint. If it is not, follow that link again, call
  `authenticate` again with it as `loginUrl`, then call `finish_build` with the same `executionId`.<!-- opengpt:section publication.http -->
- **Page traffic.** Let the site's own scripts, fonts, images and analytics load. Guardian never
  refuses them for the username or keys they carry, so never block, route around or suppress
  them to satisfy review. Your code, page code it runs included, must never send the caller's
  password, codes or answers off the site: Guardian refuses that.<!-- opengpt:section publication.recorded-requests -->
- **Consent and privacy.** Turn safety defaults off (core skill, "Safety defaults"): an
  option that shares the caller's data with another company, opts into tracking or signs up for
  marketing ends off. Dismiss a cookie banner as the core skill says.
- **Imports.** Import `effect`, the workspace's `runtime/` and `browser/` modules and your own
  files; do not rely on any other package, such as an HTML parser, being installed.
- **Host-owned files.** <!-- opengpt:section publication.host-owned:start
Every `publication/` file is
opengpt:section publication.host-owned:end --> the
  host's; you cannot edit them. `publication/definition.json` changes only through your source
  schemas and `finish_build` metadata<!-- opengpt:section publication.host-bundle-files -->. For a finding in any other of them, fix the source that caused it (a read's
  example evidence changes only with a fresh example the host allows); otherwise report it, and
  never call `finish_build` again with nothing changed. A finding in `publication/tests.json` is
  about your cases: fix the cases, the source or `coverage`. A rejection with `reason` `host_owned`
  means every finding is in such a file, a host defect no source edit fixes: the host ends the
  attempt as its own failure, so never edit a host file or call `finish_build` again for it. A
  separate finding that names an editable source or metadata cause can be corrected on the same
  execution receipt; never repeat the business action.

## What publication checks

1. **Deterministic host checks**, before review:
   - Published files are all of `src/`, the named entrypoints and any `explore/`, `test/` or
     `scratch/` module they import<!-- opengpt:section publication.saved-files:start
, or every file under those four folders when Node could load a saved file those imports do
     not name, or the workspace has a `package.json`
opengpt:section publication.saved-files:end -->.
   - No published file holds a `{{secret.…}}` handle<!-- opengpt:section publication.host-checks -->.
   - A write declares `write.confirmation` and `write.commits` matching what the session
     entered and recorded, reports confirm popups to `decideDialog` under the session's step
     names, and its input schema decodes the caller's own values.<!-- opengpt:section publication.route-evidence -->
2. **Guardian's publication review** reads what it needs of the published files and the public
   definition (`publication/definition.json`), the example's screened output
   (`publication/example-output.json`), or a write's session steps and output<!-- opengpt:section publication.review-host -->. It checks:
   - privacy: no hardcoded customer or private data, credentials, private examples, unsafe
     logging or exfiltration<!-- opengpt:section publication.recorded-sends -->;
   - claims: the name, description, output schema and variants are supported by what the example
     actually returned, and still satisfy the original request, not a narrower diagnostic tool;<!-- opengpt:section publication.site-claims -->
   - the input schema: no account-specific value (a passenger, loyalty or member number, saved
     card or address, account ID) as an enum member, example or default; every input as general
     as the site's field, never narrowed to the example's value; on a write, every option the
     session met on the path is an input or a settled default, and a costly choice is an input
     or a run-time question whose default may only decline it (writes skill); a paid upsell
     outside the tool's purpose is declined;
   - a pop-up that shows only for some accounts, states or visits is handled when present and
     never required;
   - declared questions ask only what the page or the caller uniquely knows, never a login;
   <!-- opengpt:section publication.declared-refusal:start
- a write runs every check that can refuse, such as a limit on its total, before the mark of
     the commit it guards, and refuses with `InvalidInput`, or returns a refusal its output
     schema declares before its first mark, never in an undeclared output shape;
opengpt:section publication.declared-refusal:end -->
   - a composed write reproduces the session's flow and returns the confirmation or read-back it
     declares, without committing twice, and its checks reject no correct write: a
     before-and-after comparison that compares whole objects or serialized text, reads through
     another query after the commit than before it, or counts a field the site maintains as a
     change, a branch the session did not run that confirms through its own code (its own commit
     call is fine), and a throw after a confirmed commit whose requested fields read back as asked,
     are findings too, as is a coverage claim that a check passed offline over a body that was not
     saved whole.

## Never put these in published files

- The caller's input values, the owner's answers, account identifiers or numbers, names, emails,
  addresses or anything from their account that the example happened to show. Read them from
  the input, `ask` or the page at run time.
- Session tokens, cookies, authorization headers or CSRF values. Read each at run time from the
  response, cookie or page that issues it.
- `{{secret.…}}` handles or secret answers. A value the tool needs at run time is a declared
  `secret` question it asks with `ask` (.agents/caller-input/SKILL.md).
- Account-specific values as schema enums, examples or defaults. A site's public options, such as
  sizes or fare classes, may be an enum that lists the full set.
- Logging of private values.

## Reading a rejection

A `not_published` result says why in `reason` and, for most reasons, what to do in
`instruction`: follow it. A Guardian denial comes back as `code` `ReviewDenied` with no top-level
`reason`; its `diagnostic` holds `review.reason` and `review.findings`. The common cases:

| Where                      | Value                                                                                                                                  | What it means                                                                      | What to do                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`                   | `input_feedback`                                                                                                                       | Guardian found `account_specific_enum` or `input_option` findings | Correct the source (make the value free-form or add the option as an input) and call `finish_build` again with the same `executionId`. Never run the write again. After the last round the host publishes privately and flags it                 |
| `reason`                   | `host_owned`                                                                                                                           | Every finding is in a host-owned file                                              | The host ends the attempt as its own failure. Do not edit host files, repeat the action or call `finish_build` again.                                                                                                                                                                        |
| `reason`                   | `input_feedback_unresolved`                                                                                                            | The feedback rounds are spent                                                      | End the attempt; do not execute again                                                                                                                                                                                                                                                        |<!-- opengpt:section publication.http-rejections -->
| `reason`                   | `secret_handle`<!-- opengpt:section publication.token-codes -->                                                                  | A published file holds a handle<!-- opengpt:section publication.token-meaning -->                                         | Read the value at run time instead (a declared question<!-- opengpt:section publication.token-source -->), then call again.<!-- opengpt:section publication.token-retest -->                                                                                                                            |
| `reason`                   | `confirmation_undeclared`, `commit_marks_undeclared`, `confirmation_unrecorded`, `confirm_action_unmatched`, `contract_input_mismatch` | The composed write's contract does not match its session                           | Fix the declaration the instruction names and call again with the same `executionId`. Never run the write again                                                                                                                                                                              |
| `reason`                   | `commit_marks_unentered`                                                                                                               | The composed script declares a mark no session act step entered                    | Correct the declaration only to match marks the session actually entered, then call again with the same `executionId`. When the session stopped before later save steps because the caller's facts ran out, keep those steps in `write.commits` after the entered ones and list them again in `write.commitsUnproven`. A completed session with no entered marks cannot publish: end and explain that its commit steps were not marked. Never repeat the write or enter a retrospective mark |
| `reason`                   | `write_not_submitted`                                                                                                                  | The session did not demonstrate the requested write                                | Follow the instruction: read back first, continue the remaining work, or ask about revising inputs the site cannot take                                                                                                                                                                                                                                                     |
| `reason`                   | `write_path_unfinished`                                                                                                                | The session has not settled every mark of its recorded write path                  | Read back first where a receipt says so; run only steps that never ran, or declare a revised path when the site skips one; never redo one that finished or may have. Then call again naming the step that confirmed the path's end                                                                                                                                          |
| `reason`                   | `write_path_undeclared`                                                                                                                | The composed script leaves marks of the recorded write path out of `write.commits` | Run and declare every step of the path in the composed script, then call again with the same `executionId`. Never run the write again                                                                                                                                                                                                                                       |<!-- opengpt:section publication.host-rejections -->
| `reason`                   | `missing_receipt`, `receipt_incomplete`<!-- opengpt:section publication.protected-result -->, `wrong_execution_purpose`                                         | The `executionId` names no completed example or confirming act step                | Call again with the `executionId` of the completed read example or the write step that confirmed it                                                                                                                                                                                          |<!-- opengpt:section publication.screening-rejections -->
| `diagnostic.review.reason` | `privacy`, `source_correction`, `unsupported_claim`, `authority`, `evidence`                                                           | Guardian's review blocked it                                                       | Each finding names a published file (`path`, and `file` as your workspace names it), a UTF-8 byte range (`byteStart`, `byteEnd`) and a `category`, and its `explanation` says what is wrong, the evidence and the fix. Fix every finding in source or metadata, then call again with the same `executionId`. For a host-owned file, see the check list |

Any other reason: read `diagnostic` and the instruction; the existing example stays recorded.

Finding categories: `private_literal`, `credential` and `customer_data` are private values in a
published file; `exfiltration` is a send off the site your code causes, never the site's own page traffic; `unsafe_logging` logs private data;
`schema_mismatch` and `unsupported_claim` are claims the example does not support (fix the
source so it reads the value from the page, or correct a description that promises what the
code does not do; remove an output field only when the page never shows that fact, and never
narrow the inputs); `confirmation` is a composed write that does not perform or return what it declares;
`example_value` is an input narrowed to the example's value, or code that works only for it, and
blocks like any other finding.

A rejection never authorizes repeating a claimed example or a write that may have committed.
Another fresh example read needs explicit host `repeatableRead:true`.

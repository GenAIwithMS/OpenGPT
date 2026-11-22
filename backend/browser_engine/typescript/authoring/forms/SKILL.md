---
name: forms
description: Guarded native/custom selection, dynamic choices and consequential form completion.
---

# Author the site's behavior

Prefer one question round per form page. Before the first `act` step, read what is already
visible on the page, and read the page's own scripts or<!-- opengpt:section forms.step-rules --> responses that describe the form
(field lists, validation rules, step definitions) to anticipate what later steps ask, then ask
up front, in one `request_input`, for every field you can see or anticipate that the input does
not settle. On each later page, first fill every value the request, the input and earlier
answers supply, including the choices that reveal follow-up fields, then read the page and ask
everything still open on it in one `request_input`, rather than a question per field. A field
that appears only after an answer is asked in place, with `request_input` during the session,
or as a declared `ask` in the next step's script for a choice that exists only on that page.
Check the page again after the answer.

Use Playwright locators and frame chains inside the call. Check unique target identity
separately from visibility/readiness and semantic completion. Arm relevant event
waiters before triggers, in the same call. Native dialogs go to the host through
`decideDialog`, as the core skill describes; do not click again while deciding a dialog.

`page.waitForLoadState("domcontentloaded")` may resolve for the document already
loaded. Pairing it with a click does not prove a new navigation has completed.
When the observed control navigates, arm a waiter tied to that transition before
clicking, then wait with `waitForOutcome`, the click passed as its `action`, for every answer
the site can give under the verified query: its results, its explicit empty state, a greyed-out
choice, its error or refusal (core skill).
For an in-page update, wait for evidence that the new query has completed. An
immediate snapshot with an empty title and missing controls can be a transition
observation; it does not establish an empty business result.

Derive `getByRole` names from a scoped `locator.ariaSnapshot()` or a retained ARIA
snapshot. `getAttribute("aria-label")` reads only that DOM attribute, not the
computed accessible name. The name may exist when the attribute is absent because
it comes from text, labels or `aria-labelledby`. Read the snapshot or use an
observed `getByRole` name; an `aria-label || innerText` fallback does not compute it.
Use the observed role/name to build native locators and check their count,
visibility and current value. Do not make exact indentation or adjacency in a
whole-page ARIA snapshot a prerequisite for using an otherwise verified control.
Snapshots describe a tree whose nesting and extra siblings can change. If a
locator is missing or ambiguous, inspect its relevant scope and report what was
observed before changing the locator. Use `inputValue()` on that same verified
input for query readback instead of reconstructing its accessible name from DOM
attributes inside a separate `evaluate` call.
One broad body or main snapshot can be useful for initial orientation. When that
snapshot has already succeeded, reuse it for related reads. If broad snapshot work
is measured slow or times out during repeated-result extraction, prefer the
established local result container or item locators instead of recomputing the
whole subtree. CSS `locator("main")` matches a literal `main` element, while
`getByRole("main")` matches the computed accessible role. When retained evidence
does not establish which structure exists, compare their finite counts once under
a bounded call, require the intended scope to be unique, then use that scope.
Do this before changing timeouts. ARIA snapshots are multiline structured text;
do not use a greedy cross-line capture for one quoted accessible name. Keep parsing
bounded to the intended record, handle quoted escapes, and fail explicitly when
the observed record does not match the established grammar.
Keep the control's label, current value and selected state as separate observations.
Use `inputValue()` for an input's current value; a nonempty label must not hide it.
Treat counts as presentation text: support the site's observed singular and plural
forms, and allow an owned menu option's computed accessible name to include an
observed count suffix. Scope the option lookup to that menu and match only the
established suffix grammar; do not require an exact raw `aria-label`.
During exploration, read the selected state after the action to establish how this
control commits a choice. For dates, establish the committed day, month and year
from the control and its owned calendar state; a navigation URL, field label or
requested input alone does not prove that the application accepted the date. In
published code, keep a committed-state check when selection is the operation's
final result or the next action needs that value. Do not turn every selection in a
larger flow into an intermediate success assertion; the read-back before returning
(`AGENTS.md`) checks each input the page shows. Reuse the current authorized
page for missing observations instead of restarting a completed search.

A committed selection can change a control's accessible name. During exploration,
reinspect its owned container to learn the committed state. If a later action needs
that control, locate it by the observed label and value instead of reusing an exact
name from the empty control; an airport code, for example, may be in the label while
the value contains its city or full name. Read confirmed background values before
opening a modal, which can hide those controls from the accessibility tree. A timeout
does not identify which of these occurred;
use its named phase and current evidence before diagnosing or changing the locator.

Drive every field from the input. Choose the option that matches the input value, by
the option's value or its observed label pattern, and read back that the field took it.
When the control shows only labels, prefer matching against the site's own table of option
values and labels, such as the form definitions or option data the page or an earlier page
loads, over the visible words alone, so an input holding the site's code for an option picks
that option.
Never click a label or option copied from the example, and never reject an input value
the schema accepts. Enums and typeahead matching follow the core skill's input schema; a
caller's answer picks an option but does not show which exist. Prefer matching an existing
record by a fuzzy match on its name (core skill), and prefer never picking an "Add new"
row when an existing record matches.

Fill dates with the SDK's form controls and choose values with its picker: import
`formControlsCode` and `pickerCode` from the runtime, put each once at the top of the call's
code, and call their functions on your verified locators. `fillDate(control, isoDate, format)`
fills an ISO date into whatever date control the page has: a native date input, a text box in
`format` (typed key by key when an input mask rewrites it), or one part of a split date (`MM`,
`MMMM`, `D`, `YYYY` and so on) in a text box, a select or a dropdown, whose option it matches by
number or month name. It throws an `Error` named `FormControlFailure` whose message is a fixed
reason, never a value.

`pickValue(control, wanted, options)` chooses one value in any picker: a native select, a
datalist, an autocomplete or typeahead, an ARIA combobox, a dropdown built from divs, or a
lookup dialog with a search box and a results table. `wanted` is the input's value or a list of
its spellings (`["CA", "California"]`). `pickValues` adds or replaces chips and tags in a
multi-select, and `pickerOptions` returns the options a picker lists, for a caller question.
They wait for suggestions to settle, scroll lists that render as they scroll, match the value
exactly, then loosely, never pick an "Add" or "Create" row, and confirm the field kept the choice,
picking again when the page reverts it. A read of a category or term, such as a specialty, passes
`stem: true`, so a caller's word also matches an option word it begins or that begins it, such as
Dentist and Dentistry, and returns the option it used. Leave it off for names of people and places,
and on writes, which ask the caller or list the options instead. A value the picker lacks, or several options that tie,
comes back as `{ picked: false, reason, available, matches }`: decode it with `PickOutcome` and
throw `pickRefusal(outcome, field)`, which lists options that tie as `available`, or ask the
caller to choose among `matches`. On a write, a single suggestion for a free-text value the caller
typed is the site's correction instead, never for a picker that selects a record: take it as the
writes skill says. In a tool that takes the first of options that tie instead (each tool decides,
core skill), pass `tie: "first"`, so the picker takes the first of them in the site's order and
returns the one it used, and return that option's label in the tool's output. In a read whose
typed field is the site's own search, when `pickValue` returns `option_missing` with an empty
`available`, prefer a person's fallback: type the caller's own text into the field again, then
run the search as after a pick, with the site's Search button or Enter, and read the results
page as any search's. Prefer refusing on the site's own words that it found nothing for that text
over `pickRefusal`. Never use this fallback in a write. Handle a site's quirk with the helper's options, such as `query`,
`answered`, `committed`, `commit: "keyboard"` or `blur: "tab"`, never with a picker of your own.
`references/picker.ts` picks a typeahead value and refuses a missing one,
`references/picker-first.ts` takes the first of several equal matches and returns it,
`references/dates-and-dropdowns.ts` fills a split date and `references/selection.ts` a native
select. `references/custom-selection.ts` and
`references/dialog-picker.ts` write out a combobox and a dialog picker step by step, for a
control the helper cannot drive; report that gap with what the page showed.

Preserve add/replace and single/multiple intent. `pickValues`' `mode` keeps or replaces
the chips already chosen. Query aliases
are alternate spellings of one stable choice, not extra selections. An ambiguous choice
on a write needs a resolver or a `request_input` question, as `AGENTS.md`'s "Try hard, then
ask" says; take the site's default only when the choice is not a write and is easy
to reverse, and list it in `finish_build` `assumptions`. Do not claim uncaptured
options do not exist.

Playwright `locator.count()` and `locator.isVisible()` are immediate observations,
not waits. After opening a popup, wait for its owned, named container and requested
option to become visible before checking uniqueness. For a known popup locator, open it
with `waitForOutcome({ popup }, { action: () => field.click({ timeout: 5000 }) })` in the
call, so a popup that never opens fails in seconds; then wait the same way, without an
action, for the exact option within that popup. A zero count directly
after a click does not establish absence. Inspect the post-action accessibility
snapshot before changing the selector or attempting another action.

A filled query plus a visible listbox can still show the previous response. `pickValue`
waits for the list to settle and types again when it lacks the value; when the site marks
which query its options answer, pass that check as `answered`. A matching old option alone
does not establish the answer.

When a cookie or tracking consent banner covers the target, dismiss it with the control the core
skill's cookie banner section picks. Name that control as `dismiss` of `waitForReady` (core
skill) to close the banner before the action, and one that opens later.

Decide whether each pop-up, banner or interstitial is conditional or always triggered. A
conditional one shows only for some accounts, states or visits, such as a cookie banner, a
one-time promotion or a membership upsell shown only to non-members: name its close control as
`dismiss` of `waitForReady` (core skill), which closes it whenever it opens, rather than checking
for it at one point. Never wait for it or require it. One the page always opens in answer to an action,
such as a confirmation dialog a button always opens, may be expected, and the script accepts it
when it only restates what this run entered or acts on. One that shows something new, such as a
fee, a consequence beyond the request, another record or a warning about this input, goes to the
caller as a declared question. A pop-up the session met once is conditional unless the page
shows it always follows that action.

Type each date-only input and output as the runtime's `CalendarDate`, imported beside
`formControlsCode`, never a bare `YYYY-MM-DD` pattern, which accepts `2026-02-30`. It checks
the format and that the date exists, the check `fillDate` makes, so the host refuses an
impossible date before the run, in a browser or an HTTP tool alike. It sets no range: never
narrow it to the example's date or a guessed window. A rule of the task or the site, such as
a range that ends before it starts, a past date or a booking limit, is the tool's own check:
fail as `InvalidInput` with a message naming the field and the rule, before any site action
when the input alone breaks it, and when the site refuses the date. The message's start and
the time zone that makes a date past follow the caller-input skill ("Validate it, and fail
with the right error").

Date ranges, calendar-only pickers, validation messages, uploads, staged forms and
autosave need site-specific semantic checks. A date field that takes typing goes
through `fillDate`; one that opens a calendar and takes no typing does not.
`references/dates-and-files.ts` picks a calendar date by full `data-date` within an
owned popup, attaches a file and downloads one. Beyond the SDK's form controls and
picker, do not invent a universal widget resolver. A field change, file upload or draft creation may
already be a website write.

A file never travels as bytes in code, input or output. Type a file input field as the
runtime's `FileInput`; the caller's file reaches the build as a `{{file.fN}}` handle in
the input, with its name, type and size in the request's `files`. Pass the input's value
as given to `files.place(input.receipt, { field: { label: "Receipt" } })`; `field` names
the `<input type="file">` as data, its label or a `selector`, never code. The host checks
the file and puts it there, and never anywhere else. Return a download as a `FileOutput`
from `files.collect(trigger)`, where `trigger` makes the execute call that starts it; you
see only its name, type, size and sha256. While the tool is being built, the file has no
download_url or expires_at; the published tool's runs add them. Prefer returning the file as
collected, and never require those fields in code. A downloaded file meant for the caller goes
through `files.collect`. Never write a handle in source, set file inputs, handle downloads
yourself, route the page's requests or read a file's contents back (`.files` items,
`FileReader`, `FormData`, a request body): the host refuses such source. An older tool that
sets a file input from base64 input with `setInputFiles` uses a deprecated pattern the host
still allows while the build has no file handle and no `FileInput`: a repair keeps its input
as it is, and a new tool takes a `FileInput` and uses `files.place`.

Some sites' Download or Share button only prints the page, through `window.print` or a print
frame in the site's code, and offers no file. Prefer checking the site's code or page before
clicking such a button live, since its print dialog can stop the page from answering. When the
site offers no file, prefer returning the details the page shows and saying the site offers no
downloadable file, over asking the owner to change how it's delivered.

## Multi-step forms

Filling in or advancing a form that saves data on the site (an application, a profile,
a contracting or checkout form) is a write, even when nothing is submitted yet: many
such forms save each step as you go. A read build may not fill in or advance such a
form (it asks the caller and changes its task to a write with `mint_update` first, as the
writes skill says); a write build does the whole form as its one task. A search, filter or query form
whose read semantics are established stays a read, and so does a signed-out store or location
form (core skill). A signed-out quote or price form that only fetches is a read too, but a
quote, contact or inquiry form that sends a name, email, phone number or similar personal detail
creates a lead or other lasting record on the site, so it is a write: ask the caller first, as
the writes skill says. A step that only sets an input that tailors the answer with details the
caller gave, a name, email or phone the site requires for it included, stays part of the read
unless the step creates an account or a lasting record; the build's example asks the owner first
before entering a name, email or phone (core skill, "Inputs that tailor the answer").

- Walk every step for real, in the session, with the caller's values. Never infer a
  later step's fields, options or wording in place of reaching it; the page after
  "Continue" is evidence only once you are on it.
- A step the site saved stays saved. If a step fails, read the page before running it
  again; redo it only when it did not finish.

Expose prerequisite resolvers for valid choices. A prepare/confirm flow binds the
draft to the account and requires caller-expected item, quantity, amount/currency
and destination. Read current terms immediately before commitment; fail with a
specific correction when changed. Use server quote/version checks where available;
otherwise report the read-to-submit race. Ask about choices as `AGENTS.md` ("Try hard,
then ask") says, and never keep or clear an add-on, pre-selected paid option or saved
payment unasked; every optional field the flow offers is still an optional input (core
skill, the input schema). Prefer confirming from the commit request the final click sends,
checked as the writes skill says, and otherwise from the confirmation the page shows after
the click, such as a reference number, a success message or a toast, never from another
request's 200. Match a confirmation message only against text
the site showed for this submission, never wording you expect; when no such message was
observed, read back the saved state (the record, its quantity or status) instead.

Once that check or read-back matches the request, call the context's `verified()` with no
argument just before returning, so the run reports the write as landed, whether it read the
site's confirmation for this submission or the saved state. Without it the write stays a
possible effect. Never call it for a status code without the page's error check (a 201
whose Location names the new record needs none), or a
missing confirmation, and make no execute call after it: a
later call makes the effect possible again. Missing confirmation preserves uncertainty; it
does not authorize another submit.
<!-- opengpt:section forms.fixture-checks:start

## Standalone fixture checks

Use the same supplied-input/observed-control rules and browser helper APIs. A read signed out may check pure parsers with `pureFiles` and supplied fixtures (testing skill); a signed-in read proves its form flow with its example and its signed-in cases, and a write with its act session, and neither builds fixture checks. Never invent a live field value merely to test a control.

opengpt:section forms.fixture-checks:end -->

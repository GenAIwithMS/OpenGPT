---
name: core
description: Kernel script operation SDK, mint intake, execution targets and ownership.
---

# Start here

Identify the requested operation, website/login realm, required account, business
inputs, desired result and permitted effects. A read build explores, then iterates its
script from a reset start by running its example until it works (re-running a read's
example is normal); resolve its missing choices with reads when possible. A write build
does the caller's requested task once, live (in as many write steps as it takes), then
composes its script from what happened (the `writes` skill). A read tests what its example
did not exercise with a few combined live cases (the `testing` skill). A write proves its tool
with its act session; it never reads
the `testing` skill or designs further tests<!-- opengpt:section core.write-http-check -->.
That forbids running the write again or testing it live, not writing checks: a write's script
checks its own result, and its read-back and comparison are checked offline over what the session
read (the `writes` skill). The scope follows what the tool is now, as the `testing` skill says. Credentials and
sign-in codes
belong to the host; never request a password, cookie or TOTP seed in model-visible text.

Asking the caller follows `AGENTS.md` ("Try hard, then ask"). When neither the request nor an
answer says whether the tool looks things up or changes something, prefer asking the
read-or-write choice before your first execution.

Write ordinary TypeScript or JavaScript files. Export a default Kernel script, as
described below. Import the actual canonical SDK entrypoint given in the workspace
README; do not assume an unconfigured package alias. Repository examples compile
against `typescript/src/runtime/index.ts` and show the real method signatures.

## Secret answers

A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value,
which you never see. In explore, test or `act` source, write the handle exactly as given as
the whole string passed as the value to `fill`, `type` or `pressSequentially` on a `page`
chain, or as a field of a `fetch` call to a literal URL on this site, inside
the code of a `kernel.browsers.playwright.execute` call, such as
`await page.getByLabel("Code").fill("{{secret.s1}}")`. The host fills in the value when it runs
that source live and masks it in what comes back; offline targets get the handle unchanged.
A handle anywhere else is refused before anything runs, naming its file and line: in a
variable or a locator held in one, joined or transformed, returned, logged, in a URL or a JSON
file, or beside code that reads the field back (`inputValue`, `evaluate`), reads its own source,
or redefines JSON, a global, a prototype or a page or Kernel method; check the result in a later
execute call. So is a handle the attempt never issued. An example and published
source never hold a handle: a value the finished tool needs at run time is a declared
`secret` question it asks with `ask` (caller-input skill).

## Kernel scripts

An operation is `defineOperation({ name, input, output }, async ({ kernel, sessionId,
siteOrigin, siteDomain, input, decideDialog, ask, waitPastChallenge, verified, remainingMs, errors }) => ...)`. Its browser
work is its own `kernel.browsers.playwright.execute(sessionId, { code, timeout_sec })`
calls. <!-- opengpt:section core.operation-shape:start
The host runs
opengpt:section core.operation-shape:end --> each `code` string as plain Playwright code on its own `page` and
answers `{ success, result, error, stderr }`. Throw
`new errors.OperationFailure(String(answer.error), { stderr: answer.stderr })` when
`success` is false or the page is not what the operation needs.

- Make one execute call per operation. Add a call only at a `decideDialog` decision, an
  `ask` for the caller's choice, after `waitPastChallenge`, where the flow could run past
  300 s, or in a composed write, which keeps one call per `act` step.
  `timeout_sec` is at most 300.
- The code cannot see your variables. Write outside values into it with `JSON.stringify`,
  and return plain JSON, never a Locator or Response.
- Click with a plain `locator.click()`, with at most a `timeout`. A hosted browser may make
  it a real pointer click, after the same checks Playwright makes. `force`, `position`,
  `modifiers`, `button`, `clickCount` and `delay` keep a synthetic click, so pass them only
  when the step needs them.
- Prefer waiting for the page a click opens, which may be a new tab, over waiting on the old
  page's URL.
- Prefer clicking a control's visible label when its input is hidden.
- Prefer taking a role locator's name from an ARIA snapshot (the host's `*.aria.yml` capture or a
  scoped `ariaSnapshot()`) over `textContent` or `innerText`, which include hidden labels. When the
  snapshot shows a link with no name, prefer its `href`.
- After a step whose answer can vary or that redraws part of the page, such as a click that may
  navigate, a search, a filter, a pick from a list, a date pick, adding a table row or a submit,
  prefer `waitForOutcome`, the step passed as its `action`, naming every result it can lead to: the
  next page's own control, a dialog on the same URL, an empty or sold-out message, a greyed-out
  choice (`getByRole(role, { name, disabled: true })` or the site's own disabled marker), the site's
  error or validation message, a pick-one list, or the element the next step uses. Prefer it over
  `waitForURL` or `waitForLoadState`: a dialog keeps the URL, and a page that changes route without
  loading a document passes `waitForLoadState` at once. Opening a record by its identifier or URL
  can also answer with a removed or not-found page, or an exact lookup of its key with an empty
  result: name it, and throw `InvalidInput` with `field` and what the page shows, before any
  commit mark, never a readiness timeout; below says when it starts "Caller input error:". The waits paragraph below shows how to
  paste `waitCode` and call it.
- For a search step, wait for either the site's results or its own no-match state, and return the
  site's no-match answer with its message rather than waiting on results that may never appear.
  Prefer refusing a typed value on that no-match state, quoting it, over an empty suggestion list
  read before the site answered, which is still loading. Prefer refusing a requested date only on
  what the site's own calendar shows for that day once its month has loaded, such as a greyed-out,
  disabled or missing day, quoting it, over a calendar read before it filled.
- Wait for a change (`waitForChange`, or a settle of your own) only after a step that changed the
  page or should have, such as a click, fill or navigation that loads new results. Skip it when no
  step changed the page since the last wait, such as after closing a panel without picking
  anything or skipping a control already in the requested state. The values you return still get
  their one `waitForRows` or `waitForValues` after the last change, which passes at once on a
  settled page.
- `waitForOutcome` already waited for its answer, so prefer no extra wait for that same answer after it.
- Check the null case if possible. Make sure the tool handles a lookup or filter that matches
  nothing.
- Start a response wait in the same call as the click that causes it: name the response as a
  `{ response }` answer of `waitForOutcomeResult`, beside the page's other answers, with the click
  as its `action`. Listeners do not outlive a call.
- Do site HTTP inside the page with `page.evaluate(() => fetch(...))`. Never use
  `page.request` or a Node-side fetch<!-- opengpt:section core.execute-calls:start
.
opengpt:section core.execute-calls:end -->
- Console logs do not work. Return what you need to see.
- When a challenge appears, call `await waitPastChallenge({ ready })`. `ready` is code that
  returns true once the page is usable. It throws `ChallengeFailure` if the page stays blocked.
  Naming a challenge the build saw as one answer of the same `waitForOutcome` that waits for the
  expected content, as `references/navigation.ts` does, is right and costs nothing extra. Avoid a
  separate challenge probe or call on every pass of a polling loop of your own, and never wait out
  a timeout and swallow it to probe for a challenge.
- Never repeat a call that may have run.
- When the site itself refuses a caller's value, such as a past date, an unknown airport code
  or a party size over its limit, throw `new errors.InvalidInput(message, { field })` saying why,
  with `field` the input's name, starting the message "Caller input error:" only when the
  refusal is obvious (caller-input skill). When the value is not among choices the page lists, throw
  `new errors.InvalidInput(message, { field, available })` instead, as "Configure, then read"
  below says. Add `kind`, the reason as a stable lowercase token such as `out_of_stock`, when
  a caller needs to tell refusals apart (caller-input skill). `errors` exists only in the
  script, never in a call's `code`, so when the page
  shows the refusal, return a marker such as `{ refused: "why", field, available }` from the
  call and throw once it returns. The run then fails as the caller's input; with `available`,
  the host ends it at once with those choices and no repair. A repair never asks the caller for
  a replacement value and never runs the tool with a value the caller did not send: when the
  page does not offer the caller's value, the repair makes the code throw with `available`,
  shows it with the caller's own input, and the run ends with those choices. A write that throws it before entering a commit mark reports that it changed nothing. A page,
  control or response that changed is still `OperationFailure`.
- Check every rule the input alone breaks before any site action, such as a check-out on or
  before its check-in, a count below one or a past date, and throw `InvalidInput` at once. Hold
  in the input schema every rule it can express. The caller-input skill, "Validate it, and
  fail with the right error", lists the rules, the time zone that makes a date past, and when
  to throw each error.
- When the page does not apply a valid value the caller supplied, such as a filter, sort or
  date it ignored, reset or replaced with its own, after the tool's bounded retries, throw
  `new errors.InputNotApplied(message, { field, requested, applied, step, siteMessage })`,
  never a flag in the output; the caller-input skill says what each field holds and lists the
  exceptions, such as an input that tailors the answer (the input schema, below).
- After a write, call `verified()` with no argument just before returning, once a call has
  read the result back, either the site's confirmation for this submission or the saved state.
  Return the confirmation number or record in the output. Without it the write stays a
  possible effect. A write declares which in its contract's `write`, and a write build runs
  as `act` steps; see `writes/SKILL.md` and `forms/SKILL.md`.

**The input schema.** Every caller sees the tool's input schema, so build it from the
request and the flow, never from one caller's account or example.

A value the request's text supplies, such as a code, a quantity or a choice, is the build's to
use even when the caller's structured input is empty: pass the request's values as
`exampleInput`, as `AGENTS.md` says (`execute`), never as a build-time question. Decide from the request and the site which inputs are
required. An optional input plus a declared question the tool asks before any effect is only for
a value the request genuinely leaves open; never make a required field optional with nothing
that asks. A choice the request or the owner's answer settled as how the tool behaves, such as
sorting by price or which kind of record it creates, is the tool's default, never a required
input or a question at run time. When a caller could reasonably want another value, declare it
with `defaultedInput(schema, answeredValue)` from the runtime, an optional input whose published
schema shows that default and whose run gets it when the caller leaves it out, and say in its
description that it defaults to what the owner chose; keep it fixed with no input only where
varying it would be unsafe or meaningless. A costly choice never takes one owner's answer as
its default (writes skill, "Compose and publish"). A write asks
its questions before its first save wherever the page lets it, so an unanswered question never
leaves a partial save on the site (caller-input skill). An input that tailors the answer on a read is the
exception: it is optional unless the task can't run without it (below).

- The code works for every value the schema accepts. Never let the schema promise what
  the code rejects or ignores, such as a string the code throws on unless it is the example's
  value, or an input the code accepts and then never applies, skips or always reports
  unsupported or unapplied: wire it to the site's control. Leave an input out only when the
  site offers no control for it, and say so in the description.
- Every value the code types, selects or fills on the site comes from the input and
  accepts what the site's field accepts. An enum lists the site's full set of options,
  never just the example's value. The example's values are one case, never limits.
- Prefer keying only on what the caller asked for. A detail that changes from one listing to
  the next, such as a seating label or a room name, shouldn't decide whether the tool books or
  refuses unless the caller chose it.
- Read results for every option the schema lists. When an option leads to a page with a
  different structure (other fields or sections), handle that layout too, and on a read signed
  out run it live as a test case (testing skill); an option that only reorders or filters the
  same rows needs no case of its own. Never return results for another option in its place.
- A repair that finds a declared input broken, never applied or always reported unsupported
  fixes it in the same repair, whether or not a caller is waiting. Keeping a tool's contract
  means every input and output it declares works, not leaving a broken one as it was. An input
  whose description starts "By design:" is applied in the use it records, a caller's decision:
  keep that use and its description word for word, and change them only after asking the same
  design question again (the input schema, "Inputs that tailor the answer").
- Prefer fixing the whole class of a failure over its one instance: when the page requires a control the input has no value for, prefer making every such control a declared caller question with the page's live options over throwing for it.
- Never derive a format from one sample: not an input format, an element key, a selector, a
  URL path or a label. A key the page showed for the example's value says nothing about the
  next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read
  the format off the page for the value you need, such as the day cell whose visible label or
  accessible name is the caller's date, or a key the page itself lists, never a key rebuilt
  from the one you saw.
- Inputs are values a caller knows, such as codes, names, dates and counts, never a
  suggestion's full display text or an internal id the caller cannot know (an id the site
  shows on its own pages, such as a product number, is not internal). Prefer a unique input,
  such as an ID: a tool that acts on one record takes the ID the site's other tools use for it,
  and finds the record another way, such as by name, only when the caller gives none. A closed
  list of options stays an enum of the site's options, as above. When the options come from a
  query, as in a search box, autocomplete, typeahead or searchable combobox, look the value
  up the way a person would, with `pickValue` from `pickerCode` (forms skill). It types the
  caller's value into the site's own search, reads every suggestion, matches names loosely
  (case, accents, spacing, punctuation, and whole words, so a name with a neighborhood or an
  airport code in brackets still matches) with a whole-name or code match outranking a partial
  one, and counts the matches at the best rank. A read of a category or term passes `stem: true`
  so a caller's word also matches an option word it begins or that begins it, such as Dentist and
  Dentistry, and returns the option it used (forms skill). With none, throw its `pickRefusal`, an
  `InvalidInput` with `field` and `available`, the entries the site showed, except on a write
  whose site offered exactly one suggestion for a free-text value the caller typed, never a
  picker that selects a record: take it as the writes skill says for a value the site
  rewrites. With one, use it. With several, decide per tool: take the first in the site's own
  order and return the one it used, as the site labels it, or list those matches as the site
  labels them for the caller to choose one, each selecting exactly one, with a declared choice
  question (.agents/caller-input/SKILL.md) or `pickRefusal`, which lists them as `available`.
- Match the caller's proper nouns, such as places, venues and company names, with a fuzzy
  match that accepts the usual forms of the same name, such as a name with or without its
  accents (Abaca for Abacá), a city alone or with its state and country, or a company with
  or without Ltd. or Inc. Never require an exact match. `sameText` from `opengpt-browser-engine/runtime`
  matches a name that differs only in case, accents, spacing, apostrophes, periods, commas or
  hyphens, or in a word the site writes short, such as St-Jean for Saint-Jean, but not one
  with a word added or dropped. Prefer it for confirming the pick, so the read-back agrees with
  the choice, but not for choosing from a list, where a short label can match a longer name it
  isn't, such as UK for Ukraine.
  When more than one option matches equally, decide per tool: take the first in the site's
  order and return the one it used, as the site labels it, or list them for the caller to
  choose one, each selecting exactly one.
- On a write, every choice the session met is an input, costly choices included, and any
  other option, such as a seat, is an optional input, as the writes skill says ("Compose and
  publish").
- Never make an account-specific value (a passenger, loyalty number, saved card or
  address, account or member ID) an enum member, example or default in a public
  schema. Take it as a free-form input when the caller can name it, such as a loyalty
  number; a choice among the account's saved items that the caller cannot name is a
  declared `ask` with `accountSpecific` options (caller-input skill).
- The host's `businessInputTypes` is a value-free tree of the JSON types in the caller's
  input. Use it to pick compatible types when a credential in the input is masked; a mask
  does not mean the value was a string. It says nothing about
  required fields, array lengths, numeric bounds or future values: derive those from
  the request and reviewed evidence.
- Never hard-code a value the caller could vary: it comes from the input, never a literal
  in source, a schema default or the definition. Record every control the flow offers that
  narrows, orders or configures what the tool returns as an optional input wired to its
  control, even when the request never mentions it, except a choice that was declined
  (below). Open collapsed groups, drawers and "more" links before you decide what the page
  offers: a collapsed group is not an absent one. Leave out controls unrelated to the purpose,
  such as a language switch or a newsletter opt-in on a search. The search skill's "Find the
  filters" says how a search records them.
- Declare input fields in the order a person fills in the site's form: what or where first,
  then when (a start date before an end date), then who and how many, then optional
  refinements, with sorting and paging (`limit`, `cursor`) last.
- Turn safety defaults off. They are never an input or a question ("Safety defaults", below).
- Inputs that tailor the answer. Many sites tailor what they show to facts about the visitor,
  not just what they searched for: where they are (ZIP, address, store, delivery or pickup),
  what they have (a vehicle, a device), or who they are (a membership or rate type, an insurance
  plan, a business account). Find them yourself; the request will not list them all. Look on a
  search, details or cart tool alike. When the site lets a visitor set one, make it an input even
  if the request didn't mention it; it makes the tool more useful.
  - Make it optional unless the task can't run without it. Left out, the site's own default
    applies: return the value the site used, such as the store the page shows, and say in the
    description that the site picks it, which can differ from run to run.
  - When the caller gives one, honor it. Try each way the site offers, preferring one that needs
    nothing more from the caller, then read the applied value back from the page and return it
    as `applied_<input>`, such as `applied_store`, `applied_zip` or `applied_vehicle`. For a
    location, those ways are the store picker, the ZIP or postal-code box, the delivery or pickup
    choice and the manual entry beside "use current location". Decline the browser's location
    permission when the site asks; declining often reveals a manual ZIP field.
  - When the site needs more detail to apply it, such as a street address instead of a ZIP or a
    vehicle's trim, add that detail as its own optional input. Its description says what it is
    for and that it is sent to the site. Submit only what the caller gave; never invent or reuse
    details. A name, email or phone is offered only when the site won't apply the input without
    it. A step that creates an account or a lasting record on the site is a write, so a read
    stops before it. While building, a live step, the example's or a test case's, that enters a
    name, email or phone asks the owner first (`request_input`), since the execution review
    escalates it otherwise. The owner's answer keeps the build a read, with no `mint_update`.
  - Only when the site still won't apply what the caller gave, on a read: return what the site
    did show, with the value it actually applied (`applied_<input>`, null only when the page
    shows none) beside the one the caller asked for, and the site's message in an optional
    output field, `<input>_note`, such as `zip_note`, set only on this fallback, which also says
    why when the applied value is null. Never present it as the answer for the caller's value. A location the site says it
    does not serve is such a case: return the site's own answer with its message. A write throws
    `InputNotApplied` (above) before its first commit step instead; for a location the site
    says it does not serve, it prefers the writes skill's refusal quoting the site.
  - Inputs that narrow the results (filters, sort, dates) stay strict: a value the page ignores
    throws `InputNotApplied` (above).
  - Give a tailoring input a limited use, such as a postal code used only to look up nearby
    stores without changing the selected one, only when the caller chose it. When how the tool
    should use such an input is genuinely ambiguous, such as whether a postal code sets the
    store or only lists nearby ones, ask the owner one `request_input` choice question with id
    `input_use_<input>`, `<input>` being the input's name in lowercase snake_case
    (`postalCode` is `input_use_postal_code`), with each use as an option. Always offer the
    full use, such as setting the store from the postal code, never only limited uses. When the
    caller chooses a limited use, start the input's description with "By design:", then state
    how many values it takes and that use in plain words, such as "By design: one postal code,
    used only to find nearby stores; it does not change the selected store." Write it only from that answer, never from the request's
    wording, a free-text instruction or your own judgment, and never for a filter, sort or date,
    which stay strict whatever an answer says. The code still applies the value in that use, and
    a value the page does not take in it throws `InputNotApplied` (above).
  - While building, ask the owner for a location or other tailoring value the result depends on
    (`AGENTS.md`, "Try hard, then ask"); they may skip it. Skipping that question only leaves
    the example without one, and the input stays; saying the tool should use none declines it
    (below).
  - Setting a location, store or delivery or pickup mode in the run's own browser is part of
    the read, never a write, even through a Save button: the run's browser is fresh and
    discarded, so nothing is saved, and a tool that never signs in has no account to change.
    Entering a guest address the caller gave to apply it is part of the read too; a name, email
    or phone follows the rules above. In a signed-in tool,
    use the site's per-visit control and never save an address, default store or preference to
    the account.
- A choice the request, the caller or the owner declined, or a step they said not to take (no
  location, no store, skip a filter, don't sign in), is not part of the tool for any caller:
  never offer it as an input, never set it in the example or a test, and never put it in
  `exampleInput`. Note it in coverage. That covers a step the tool then never takes. A costly
  choice a write still meets on its path is never settled this way (writes skill).
- Callers and Guardian see the JSON Schema form, so write every constraint in one it
  shows: a `Schema.filter` shows nothing, its description included, so use
  `Schema.NonEmptyTrimmedString`, `pattern`, `minLength`, `Int`, `between` or `Literal`. Type
  every output field, never `Schema.Unknown`. A read publishes the schemas in its current source,
  and its example's own input and output must decode under them, so settle both before that
  example.
- Make each input as strict as the site's field: required text is non-empty and not whitespace
  alone (`Schema.NonEmptyString.pipe(Schema.pattern(/\S/u))`, which still takes a caller's stray
  space); free text takes a `maxLength` no longer than the site's own field takes, so a blank or
  over-long value is refused before the site is touched; a date, time or code keeps its
  `pattern`; a fixed set is a `Literal` enum. Make an input
  optional only when the site accepts the field blank and the tool works without it.
- Start each field's description with how many values it takes and what each one is, such as "One city name" or "A list of airport codes", so the input's cardinality is clear. A description that starts "By design:" keeps that marker first and puts the number of values after it, such as "By design: one postal code, …", never before it.
- When a field takes one value and a caller might send several, say "one per call" and prefer a
  `pattern` that refuses a list, such as several codes separated by commas, while still accepting
  one value that contains a comma, such as "Portland, OR". Prefer `between` to a range written
  only in the description.
- Give every input and output field, nested object and array item fields included, a short
  `description` annotation saying what it is, with the unit or format where one applies:
  "Departure airport as a three-letter IATA code", "Departure date, YYYY-MM-DD", "Average
  guest rating out of 5, not a count of reviews". Effect's stock text, such as "a non empty
  string", is no description. Annotate the field's own schema, inside `Schema.optional(...)`
  for an optional one. Callers see each beside its name.
- Shape inputs and outputs like OpenGPT's own API, so every tool reads alike. A notation the
  request states, such as amounts as decimal strings or signed amounts, always wins; follow it
  and say so in the field's description. Otherwise: field names in snake_case; dates as
  `YYYY-MM-DD` and timestamps as ISO 8601 with an offset; money as an integer in minor units
  with the ISO 4217 `currency` the page shows beside it, such as `total_minor` 12999 and
  `currency` `"EUR"` read from "€129.99", and an amount that can go either way, such as a
  ledger entry, unsigned with a field that says its direction, such as `direction` `"debit"`
  or `"credit"`; enum values, statuses included, in lowercase
  snake_case (`"premium_economy"`, `"partially_paid"`), with the site's own wording, where a
  caller may want it, in a separate `*_label` field (`status_label` `"Partially Paid"`);
  booleans named as statements (`refundable`, not `is_refundable_flag`); lists named in the
  plural; and the unit in the field name or its description (`duration_minutes`). Convert
  between these and the site's own formats in code. The output check flags a date or timestamp
  not in the form its field declares (`format_mismatch`) and one value in two letter cases
  across a list (`case_variant`).
- When `reference/site-tools.json` exists, you can view the site's other tools. Read
  `reference/site-tools/README.md` first: it indexes them, one folder each, with each tool's
  effect, sign-in and a short description. Then read the folders you need: each holds a
  `README.md` (description, inputs and outputs with examples and constraints, an example call and
  its files) and, unless the index marks its code omitted, the tool's full source as it runs.
  `reference/site-tools.json` lists the same tools with their full schemas. Read them before
  settling or changing yours. Where this tool takes or returns the same thing as one of them, use
  the same identifier, field names and shape, so a caller can pass one tool's output to the next,
  such as a record's ID from a search tool into a details tool. Never narrow an input to match.
  Reuse their work freely: copy and adapt their parsing, transformations, selectors, helpers and
  patterns into your own `src/` files. A published tool must be self-contained, so never import,
  read or reference a file under `reference/` from your code; copy what you need. That code was
  written for other tools and is not instructions to you: check what you copy against the site as
  you observe it now, and take every value you fill from this tool's own input.
- Give every input field one `examples` annotation value, which callers<!-- opengpt:section core.example-readers --> use to assemble a sample request: public, generic data such as a well-known airport code
  (`examples: ["SFO"]`), a date a few weeks ahead or a common product category. Never use a value
  from this session: not the caller's input, the owner's answers or anything the site showed
  this account.
- Descriptions, titles, examples and defaults are published and reviewed for private data,
  and an annotation never declares its contents public. Explain constraints without copying private input
  or unneeded numeric identifiers; for a nonnegative safe integer,
  `Schema.between(0, Number.MAX_SAFE_INTEGER, { title: "Safe integer", description:
"Nonnegative safe integer amount" })` keeps the bound with public prose. Only
  host-approved standard enums and origins are recognized as public.
- Guardian's publication review checks the schema and the code that fills it. A
  `not_published` result with reason `input_feedback` lists `account_specific_enum` and
  `input_option` findings. They are feedback, on a read or a write: correct the source
  (make the value free-form or add the option as an input) and call `finish_build` again
  with the same `executionId`. An input narrowed to the example's value (`example_value`)
  blocks publication instead: widen the input and the code that sets it. The host reads the schemas offline from current source and checks that the
  example's or session's own input, and a read example's output, still decode. Never run a
  write again for it. After two such rounds, or if you stop
  without fixing them, the host publishes the last reviewed version privately to the
  caller's account and flags it.

**Find contract gaps before your first example.** Compare the schema you plan with what the
page offers: a control no input covers, an input you cannot wire, a value the request needs
that the page does not show, or a needed field you would have to make nullable. Settle each
then: wire it, ask the owner with `request_input` when the request reads two ways, when you are
unsure how to solve it, or before leaving out a part the site offers (`AGENTS.md`, "Try hard,
then ask", item 8), or state in the description why the tool lacks it, only for a part the site
does not offer, one the owner chose to leave out or, when no answer came, one that is hard and
optional to the request (`AGENTS.md`, "Solve before you narrow"). When the site never shows a
value the request needs, a field to return or a filter or option to apply, ask the owner with
`request_input` as soon as you find it missing, before you build, whether to build without it or
stop. When they need it, end with `report_blocked` reason `site_lacks_capability` (`AGENTS.md`,
"Impossible as asked"). Publication review blocks on the same gaps, and finding them at
`finish_build` costs a full fix-and-resubmit round.

**Never loosen a value the request needs.** The values the request needs are each value it
names, the record's identifier as the site shows it, and the context those depend on as the page
shows it, such as dates, a party size or a location. Make each one required and non-null, typed
so a value the code could not read fails the output check (`Schema.NonEmptyTrimmedString` for
text, `Schema.Int` for a count), never optional, nullable or plain `Schema.Number`, whatever a
description says. A run whose output fails its schema goes to repair.
- The owner may settle a different form for every run: in the request's own explicit words, in
  an answer to your design question or in a task update, such as blank fields returned as empty
  strings. Publication review honours that decision as stated. Build it that way, and say in
  the field's description what the owner chose. It never covers a value the page shows that
  the code failed to read, or anything personal or account-specific.
- Type each output field as strictly as its value: required text is non-empty and trimmed
  (`Schema.NonEmptyTrimmedString`), a date or time keeps its `pattern`, and a field that reports
  an input's value reuses that input's enum or pattern. Make one optional or nullable only where
  the page may genuinely not show the value.
- The one exception is a record whose own page genuinely does not show the value, such as an
  item that is sold out and shows no amount, or a listing that shows no date yet. Then the value may be null only together with a
  field that says why, such as its availability, and both descriptions say so.
- Null never covers a value the page shows that the code failed to read: that throws
  `OperationFailure` naming it. Never turn a read that found nothing into null
  (`?.innerText ?? null`); a missing element is a failure, not an absence.
- Before your first example, list the needed values. If the page may not show one, settle it
  then: find where the site shows it, on every layout its records use, or ask the owner.

**Output fields.** Design the output for what a caller could use, and lean toward more fields
and more information rather than the minimum: include the facts about each record or result
that a caller could reasonably use to identify, choose, compare or act on it, not only the values
the request names. Leave out what is unrelated to the tool's purpose or of no use to a caller.
- Keep each value's full displayed text. Read the element that holds the whole value, never a
  shorter or secondary one. When the page splits one value across elements, such as a maker
  line above a linked name or an author line above a title, return each part in its own field. Never drop either part.
- Prefer a separate typed field for each fact over folding it into another field's text. Never
  derive a value the page does not show.
- A field that is not a needed value is nullable when records on this site can lack it, and it
  is null exactly when this record does not show it.
- Never declare a field the code does not read. A field that is always null, empty or fixed is
  not a disclosed limit: read it from the page, or leave the field out.
- Expand collapsed text (a "more", "show all" or similar control) before reading it, and read it
  back: a value that ends in an ellipsis or holds the control's own label was read collapsed or
  cut short.
- Descriptions, specs, ingredients and variants often sit in collapsed accordion or tab sections
  that read empty while hidden. Prefer the page's embedded record data; otherwise open the section
  and read it back. Never guess a data key and fall back to null when it is missing.
- Before your first example, see each nullable field filled on at least one record that should
  have it. A field never seen filled is a wrong read: fix it or remove it. A field that says why a
  value is absent rests on evidence that this record lacks it, never on a read that found nothing.
  In `finish_build` coverage, name for each nullable field a tested record where it was filled.
- Return each fact once. Never add a field holding a whole row's or card's text beside the typed
  fields: give a fact they miss its own typed field, or offer the whole text only as the
  `card_text` section below.
- A list that can run past one page returns one page per call and a cursor to the next, as the
  pagination skill says.
- A tool that extracts records or table rows from an app whose fields are user-defined or found
  at run time, such as a CRM's records or a table's rows, follows the records skill, which takes
  precedence over the lean toward more fields above and one typed field per fact below: a small
  default keyed by field name, with every other field through its `fields` and `include` inputs.
  A record type whose fields are fixed and known keeps one typed field per fact.

**Optional sections (`include`).** Some parts of a page cost every run extra clicks or waits, or
are large and repeated on every record: the filters, facets and sorts the site offers, each
record's full displayed text, related or recommended records, options that show only on a hover
or a click, a panel each record opens. Leave each such section out of the default output and
offer it through one optional input, `include`: an array of the section names this tool can add,
empty by default (`{ "type": "array", "uniqueItems": true, "items": { "enum": [...] } }`), whose
description says what each name adds and what it costs.
- Decide by cost, not by bytes: a short list that takes a click to open on every run is a
  section; a fact each record already shows is a field.
- Use the standard names where they fit: `filters` (the filter groups, facets and sorts the site
  offers for these inputs), `card_text` (each record's full displayed text), `related` (the
  site's related or recommended records) and `variants` (each record's options). Name any other
  section for what it holds, in lowercase with underscores.
- Examples across kinds of sites: a shop's search offers `filters` and `card_text`; a fare search
  its `filters` and each fare's `fare_rules`, which open in a panel; a rentals or real-estate
  listing its `nearby` listings; a documentation search each hit's `full_section`, beyond its
  title and snippet; an orders list each order's `items`, when they show only after opening it.
- A section's output field is optional in the schema and absent unless asked for, never
  null-filled, and its description starts "Only with `include: ["name"]`".
- Without its name, the tool does none of a section's work: it opens no filter group, hovers on
  nothing and opens no panel. What the caller set is always read back whatever `include` says,
  such as the filters it applied, returned as `applied_filters`.

**Results, related records and groups.** A list holds only the records the site returned for the
inputs. Scope the row locator to the main list, and leave out related, recommended, recently
viewed and "others also" sections; with `include: ["related"]` return them in their own `related`
list of the same row shape, never mixed into the results and never counted toward a limit. A
sponsored or promoted row inside the main list stays where it is, marked as such, unless the list
already holds the same item (pagination skill); a promoted carousel, or any carousel or banner
with its own heading or scroller, is not part of the main list, even when its items are marked
sponsored. Return each item once.
A card that
stands for a group, such as one product in several flavours or sizes, a hotel with several room
types or a building with several units for rent, is one result marked as a group (for example
`kind: "group"`), with the options or count the card shows and a note that its link opens one
member, never presented as one of its members.

Then, for every field:
- Prefer parsing what the page shows into typed fields over returning a result row, card or
  itinerary as one text blob or summary, and keep every result row of the main list the page
  shows, up to the call's `limit` (pagination skill).
- Read every output from the page or response on every run, so every returned field has
  observable support: never a literal, a default you invented, or a constant `null`, `[]`,
  `false`, `0` or fixed label where the page can show the value.
- Return `null` for a field that is not a needed value only when this record's page lacks it,
  and an empty list only when the page shows none; never throw for either. When the code cannot
  read a value the request needs, throw `OperationFailure` naming it; never return a
  placeholder, a label or another record's value in its place.
- One field per fact, as the page states it, and variants as the dimensions and values the page
  lists.
- Prefer numbers for amounts and counts, ISO 8601 for dates and times and minutes for durations;
  type a date-only value as the runtime's `CalendarDate` (forms skill). A value that does not
  parse cleanly may be the site's own text.

**Configure, then read.** Many pages show values that depend on choices made on the page: a
record's options or variants, a plan or tier, dates, a party size or quantity, units, a
location or store. A search's filters and sort are such choices too. Before reading any value
that depends on them:

1. Discover. While building, read every choice group the page offers and each group's options
   exactly as shown, including which are unavailable, opening collapsed groups and menus as
   above. On a run, open and read only the groups the caller's inputs use. A group
   with one option, or a disabled control showing one value, is a
   fixed value: read it, never click it.
2. Set. Apply each input's value through the page's own control, in the order the page
   presents the groups, since one choice can change the options of the next. When the value is
   not among the options the page lists at all, throw
   `new errors.InvalidInput(message, { field, available })` before any commit mark, with
   `field` the input's name and `available` every option the page currently offers as
   selectable, exactly as shown. Leave disabled, sold-out and other unselectable options out of
   `available`, and say in the message that they were left out. Never pick a near match, the
   page's default or the first option; the same proper noun in another usual form is not a near
   match (input schema above). A write follows the site's preselected substitute instead when
   the caller's own task asks for whatever the site ends up with (writes skill). A broader
   choice that covers the value, such as "Show all", is allowed on a search (search skill).
   - An option the page lists but greys out, disables or marks unavailable, such as a booked
     date, a sold-out size or a full time slot: a read returns it as data, the requested value
     with `available: false`, the page's own reason when it shows one, and the alternatives the
     page offers beside it, such as the in-stock sizes, the open times or the valid stays, and
     the run succeeds. A write throws `InvalidInput` with `field` and `available`, the
     selectable options. Neither picks another value for the caller; a write follows the site's
     preselected substitute only when the caller's own task asks for whatever the site ends up
     with (writes skill).
   - For an input whose options depend on another, such as a check-out after a check-in or a
     time after a date, apply the input it depends on first and read `available` from that
     state, then drop the options the input alone rules out. Never list options read before
     the input they depend on applied.
   - A venue or record page that says it takes no online booking, or not yet, and shows no
     booking controls, such as "Reservations open November 1": the site says no to the whole
     request (caller-input skill), so a read returns those words, preferably as a declared
     refusal with `site_message`, never as no open times or an empty list.
   - A number on a scale the site steps, such as a price range slider or price boxes, is a
     number, not a choice: never refuse it because no label matches. Set the nearest step inside
     the caller's bound, down for a maximum and up for a minimum, so a maximum of 47 on steps of
     10 applies 40, never 50; use the control's end when the value is outside its range. Read the
     applied value back and return it, such as `applied_max_price`, beside the results. The rule above for a value
     the page does not offer covers choice lists only.
3. Confirm. After a step that changed a choice, read it back from the page's selected state and
   wait for the values that depend on it with `waitForChange`, passing that step as `action`:
   changed, or confirmed unchanged once the page's loading sign came and went; a value read
   before the page updates belongs to the previous choice. A choice already in the requested
   state needs no step and no wait. Compare text read back with `sameText(shown, wanted)` from
   `opengpt-browser-engine/runtime`, `wanted` being the option the tool picked from the site's list when it
   picked one, the site's version of a value a write typed and the site rewrote (writes skill),
   and the caller's value otherwise. It ignores case, accents, spacing, apostrophes, periods,
   commas and hyphens between letters, reads a space, hyphen, slash or parentheses between
   digits as one separator while the groups still count, so 29 59 matches 29-59 but never 2959
   or 2 959, and accepts a word the page shortened, such as St for Saint. Prefer it over
   exact equality, since a page may echo a query or name in its own case or short form, and
   prefer comparing numbers, dates and amounts as values. When the page kept another value
   after the tool's bounded retries, throw
   `InputNotApplied` (above); never read on with the page's value, except in the cases the
   caller-input skill lists as not unapplied, such as a number snapped as in step 2.
4. Read. Only then read the values the choices affect. Return the applied choices beside
   them. Return a group's offered options as a list when the page shows them without extra
   clicks, as a record page shows its variants, or when the caller asks (search skill).

An optional choice the caller leaves unset keeps the page's default: never set its control.
Read the default from the page's state or data where it shows, with no wait; otherwise, outside
a search (search skill), one open, read and close of its control is allowed; otherwise return
null and say why in the description.
Return it as applied. A control you could not find, open or read throws `OperationFailure`, never
`InvalidInput`.

<!-- opengpt:section core.host-ownership:start

The host owns input/output validation, deadlines, caller authority and the browser. Do not close the page.

opengpt:section core.host-ownership:end -->A newly allocated Page may start at `about:blank`; the supplied site origin does
not mean the host has navigated there. Navigate to the authorized site and wait
for a named page condition before inspecting its title or controls. Empty content
on a blank Page is not evidence about the website or its availability.

Take the site origin from the context's `siteOrigin`. If it is undefined, fail before
live navigation; offline fixtures intentionally have no live origin. Build URLs with
`new URL("/", siteOrigin).href` or a fixed path the site links to (`AGENTS.md` says when a
caller's value may go in a URL), and write them into the code. Never embed the site's hostname
or account-specific origin as a literal in authored source, schema examples, or logs, and never replace it with `page.url()`
after a redirect. The host supplies the primary origin even when the model cannot see
it. This value does not authorize other destinations or credential submission.
For a tool whose sign-in moves each account to its own workspace host, `siteOrigin` is that
account's workspace origin at run time, so a URL built from it, or from `siteDomain` for a
fixed API host, reaches the right workspace, and one built from `page.url()` or a literal does not.
The context's `siteDomain` is the site's registrable domain: check that a page is on the site
with it as `AGENTS.md` shows ("Check the page is on the site before exploring it"), writing it
into the code as you do `siteOrigin`, never derived from the hostname.
`references/native-page.ts` shows the check. Use `page.evaluate`,
`locator.evaluate` or `locator.evaluateAll` when code needs browser globals such as
`document`.
Read each output value from the element or structured-data entry that holds the whole value,
never a shorter or secondary one, found by a stable id, a `data-` attribute, a role and name or
the record's own key, with `visibleText`, `visibleTexts` or `readRows` (paste `visibleTextCode`
from `opengpt-browser-engine/runtime` at the top of the call's code). They return only the text a person sees
on the rendered page, with whitespace normalized and invisible characters removed, and fail
instead of returning hidden text; `as: "accessible"` reads what a screen reader reads instead.
`textContent` always includes hidden text, scripts and styles, and so does `innerText` of an
element that is not rendered, such as a hidden duplicate of the block you meant. `readRows`
reads a window of rows in one call, each field relative to its row. Read a list's rows in one
call: `readRows` and `waitForRows` read every returned row at once. A list of texts read from a
page, such as bullets, highlights or option names, can hold blank entries the site renders
invisibly: trim each entry and drop the empty ones, so one blank entry does not fail the result.
A single text field that can be blank on some records is nullable, and its description says when
(a needed value also takes a field that says why, as "Never loosen a value" says). Return a value
the site shows blank as null, never a question to the owner. Never select
by a generated CSS class, a hashed or build-numbered name such as `.e-1a2b3c` or `.css-1x2y3z`:
it changes on the site's next deploy.
Never read it from a broad container, whole-page text, tag-stripped HTML, a regex over page-wide
text or a page-wide setting such as a currency or language picker: a heading, label or
placeholder is not the value beside it. Read embedded data separately when it is relevant to
the requested operation.
On a hosted browser each Playwright call is a remote round trip, and each awaited call waits for
its own, so a read costs its number of calls, not its navigations. Read every field a page needs in
one `evaluate`, `readRows` or snapshot per page, never one locator call per field or a probe per
element. Prefer values the list page already holds, in its rows or its embedded data, or the
site's own data request<!-- opengpt:section core.data-request-reference -->, to opening each record's page. When the tool must open
each record's detail page, keep each to a few calls (open, wait, one read), and consider whether
the request is better served as two tools, a search and a details read by identifier; say so in
`coverage`. Prefer opening those detail pages only for the rows the call returns, after
`readList`, not inside the list reader (pagination skill).
Prefer the page's own structured data, its embedded JSON or the data response it renders from,
to its rendered cards when it holds the same fields for the same records, and check on the
example that it matches what the page shows. Embedded JSON holds the page as first rendered:
after an in-page change, such as a filter that reloads the list without a navigation, read that
change's data response or the rendered rows, never the initial JSON. Read the rendered page for
a value that exists only after client-side rendering, or that the page computes where you see
it, such as a total.
Budgets: navigation 30 s for the document to commit; a click, fill or other action 5 s, taken
only on an element a wait has shown ready. After a navigation commits or an action returns, the
page gets 8 s without progress to show one of the answers you named, and up to 30 s while it
keeps progressing: a loading sign showing, the part of the page you named changing, the site's own
request in flight, the URL changing, or the values you read filling in. Values the site fills in
after its answer get up to 15 s. The runtime's waits (`waitCode`, below) apply these budgets. Give
every other Playwright call in the code an explicit `timeout`, and keep `timeout_sec` within
`remainingMs()`.
Child waits cannot extend the outer deadline. Explicitly name observation conditions.
`domcontentloaded` is document readiness, not readiness of the requested page or
control. Initial navigation can land on a temporary verification page before the
site redirects or renders its controls. JavaScript challenges, redirects and
delayed rendering can be intermittent: a fast exploration load does not establish
that later executions will be immediately ready. Include a bounded wait for the
expected page or control even when exploration never observed a delay. Derive
that readiness condition from the intended page, not from having seen a particular
challenge. Wait for a unique operation control or page state before testing absence
or choosing a fallback. Use `locator.waitFor` for one expected state, `waitForOutcome`
(below) when the page can answer more than one way, `waitForRows`, `waitForValues` or
`waitForChange` (below) for the values you return, or, only where none fits, a bounded loop of
your own that reads every condition in one `evaluate` per pass;
`count()` and `isVisible()` only observe the current instant. Share one bounded navigation
deadline across navigation
and first-page readiness, as in `references/navigation.ts`. Readiness polling and every re-check
below only observe: do not repeat `goto`, reload, login, submission, the action that caused the
change or another action inside them. Preserve site/path and account guards while waiting.
Wait for the values you will return, not for their containers or the rest of the page. A record
is ready when each value you return is filled in and reads the same on two looks
(`waitForValues`): two consecutive identical reads, the first included. Call it after a step
that changed the page, and never again on a page nothing changed since. A list is ready when
the rows you return, the first `limit` from the page's
position (pagination skill), have their identifier and the values the request needs, filled in
and reading the same twice (`waitForRows`); keeping every result row means every row up to that
page size. A slot that is present but empty, a skeleton, `aria-busy` or reading "Loading…" is
still loading, never absent; a slot with no identifier is not a result. A value still loading
when the page stops progressing fails the run, optional or not: null is only for a field this
record's markup lacks altogether, as the build saw on records without it, never for a slow one.
When a list row shows the site's own plain "unavailable" state for a value, such as a price,
prefer treating that row as settled in the readiness wait and returning that state in an output
that can carry it, over waiting for a value the site will not show.
Use observed conditions: never add a fixed sleep, since a ready page passes immediately, and
never wait for rows you won't return, for the whole list to stop changing, for whole-page
network idle or for the page's `load` event. Read image links from attributes (`src`, `srcset`) without scrolling. A page with
an outcome is ready only when it shows that outcome: results, or the site's own empty message.
Before acting on a control, wait until loading overlays covering it are gone and its section is
expanded. `waitForReady(control, { overlays, expand, dismiss })` waits for all of it: the control
enabled, uncovered and still, the overlays you name gone, the section toggle you name opened once,
and the close controls you name for a tour, a what's-new dialog or a banner that opens on its own
clicked, now or before a later action. A panel or dialog you opened does not go away by waiting: close it with its own
control or Escape and check it closed. A click Playwright keeps reporting as intercepted by the
same element is a page state, not slowness. After an action that navigates or re-renders, wait
for the committed state
(URL, selected value or header) before checking identity or reading. Use bounded retrying
waits: re-check the condition until it holds or the budget ends, then throw `OperationFailure`
naming what was last observed and what was expected. Never swallow a failed wait and continue
(`try { await wait } catch {}`): either the condition is required, so throw, or it is not, so do
not wait for it. After extracting, confirm the page did not re-render under you: the same IDs
for the rows you returned, the same values for the fields you returned, and the same URL as
before extraction. If any changed, read again within the deadline.
Build any check that values stopped changing from stable keys, such as record IDs, names and
prices, never from text that changes on its own, such as a countdown, a timer, a rotating badge
or a live viewer count.
After an action that can navigate, prefer waiting with `waitForOutcome` for a control only the destination page has, beside every other answer the action can give, over waiting for the destination URL alone, then extract. Keep the action,
readiness wait and extraction in the same Kernel execute call when possible. If a read
reports “Execution context was destroyed,” the action may already have succeeded.
Reacquire page/frame locators, wait for readiness and retry only the read within the
original deadline. Never repeat the click or submission as part of that recovery.
Race every answer a step can give with `waitForOutcome` rather than waiting for one request you
saw, which the site may batch, cache or rename; name a write's commit request as a `{ response }`
answer beside them (writes skill).
For an unknown destination, inspect after the document transition; do not invent a
selector or repeat the action in a follow-up read.
Import `waitCode` from the runtime (`outcomeWaitCode` declares `waitForOutcome` alone, for code
written before; paste one, never both), paste it once at the top of the call's code, and wait with `waitForOutcome({ refused, failed, unavailable, empty,
results }, { action, loading, region })`, one scoped locator per answer, each an element only
that answer has and the step can cause, such as a results list that holds a
row. Prefer closing a banner, tour or dialog that opens on its own with `waitForReady`'s
`dismiss` over naming it as an answer, since `dismiss` also closes one that opens later, before
the next action. The first listed wins when several show, so list a refusal, error or greyed-out choice
first, then the empty state, then results. Pass the step itself as `action`, such as
`() => apply.click()`: the wait runs it once, and an answer the page already showed before it counts
only after staying unchanged for `unchangedMs`, 2 s by default, so a list the step has not yet
re-rendered is not read while a step that leaves the same answer still resolves; a new or
changed element counts at once. Without an `action`, an answer already on the page wins on the
first look, so prefer passing the step whenever the wait follows one, typing included.
`waitForOutcome` returns the name of the answer that showed.
An answer may also be `{ invalid: form }` (a field the site marked invalid), `{ gone: locator }`
(a form or dialog that closed), `{ url }` (a navigation or route change), `{ response }`,
`{ dialog }` (a native dialog, left open as `result.dialog`: keep it on `globalThis.dialog` and
return its type and message for `decideDialog`, as `references/native-dialog.ts` does), `{ popup }`, `{ announced: text }` (a toast or
alert a live region announced, even one gone before a look) or `{ check: fn }`.
`waitForOutcomeResult` returns the winner with its `evidence`, such as the invalid fields' labels
and messages, the toast's text or the `response`.
Prefer branching on that name over waiting again for the same answers or rechecking them with
`isVisible`. Pass the site's own loading sign as `loading`, the part of the
page the answer appears in as `region`, and the context's `siteDomain`, so the sign counts for as
long as it shows, changes in that part count as progress, and so do the site's own requests on
every host of its domain. A generic sign, such as `aria-busy` or a spinner class, counts only
while it is new, so a decoration holds a wait for at most the no-progress window; `waitForRows`
also waits while one shows beside its rows, never inside one, and for the requests its `action`
started. Without an `action`, a list beside a loader that never leaves costs about one
no-progress window. A request already in flight when a wait starts is not seen: on a page still
loading its list, name its loading sign as `loading`. Read results;
return an empty list for a listing's empty state;
throw `InvalidInput` with `field` and the site's own words for a refusal; handle a greyed-out
choice the input asked for as "Configure, then read" says; ask the caller about a pick-one list
(.agents/caller-input/SKILL.md). It throws an
`Error` named `OutcomeWaitFailure` whose message says what each outcome matched, which progress
signs it saw and when progress stopped: `outcome_ambiguous` when the winning locator matches more
than one element; `outcome_unknown` when the page stops progressing for `noProgressMs` (8 s)
while showing none of the answers; and `outcome_timeout` when it is still progressing at
`timeout` (30 s). An unknown page is a challenge, the site's error or a layout you have not
handled: do not turn it into your own timeout; the host reports it as one. `references/navigation.ts` waits for a search's answer and
a record's page this way.
The same code declares the waits for the values you return. `waitForRows(rows, fields, { count,
key })` returns `{ rows, more }`: the first `count` rows that have a `key`, each field filled in
and reading the same twice. It reads each field from its first visible match, skips a row without
a key, and returns fewer rows once their count holds; no rows is never its answer, so decide an empty list with `waitForOutcome` first.
`waitForValues(fields)` returns `{ values }` for a record, a quote or a form's state.
Prefer the wait helpers' own settling over loops of your own that poll until values hold still:
`waitForRows` and `waitForValues` already return only once what they read is filled in and reads
the same on two looks.
`waitForChange(fields, { before, action, loading })` returns `{ values, changed }` after a choice:
changed, or the same with no progress sign for `unchangedMs`. They throw a `ValueWaitFailure`:
`values_loading` when a value is still loading as progress stops, `change_unknown` when the
fields are missing, `values_timeout` at the cap. A host may retry a read once after
`outcome_timeout`, `outcome_unknown`, `values_loading`, `values_timeout` or `change_unknown`,
so let them throw. `waitReport()` returns a one-line summary of how each wait in the call ended.
A field is a Playwright locator, or `{ locator, attribute, optional, all }`, where `all` reads
every visible match as a list. After a search or a filter, use `waitForChange` on the rows you
return, such as `{ ids: { locator: rowIds, all: true } }`, with the site's own loading sign as
`loading` when it has one.
After a step that reloads the page, such as choosing a city, prefer typing into the search box
again when its suggestions still don't appear after the wait that passed the typing as `action`.
Typing or choosing can reload part of the page once per key or choice, such as suggestions or a
dependent list. The answers can land out of order, and the page may replace the element it
updates. Prefer waiting until every answer has landed, then look that element up again rather
than reading a node or handle found earlier, and check it shows the answer to the whole value.
When it doesn't, prefer entering the value once more over waiting longer, after the wait that
passed the typing as `action` has ended, since typing again while the site is still answering
can cancel that answer.
<!-- opengpt:section core.site-origin -->After a probe reveals a challenge, inspect the retained Page in follow-up probes
and wait for the intended page/control within the existing deadline and job budget;
do not click the challenge, reload, or navigate to another route merely because
the earlier probe timed out. A new probe execution does not require new navigation.
A live example, a live read `test`, and a write session's first `act` step are
different: they start from a reset page, as `AGENTS.md` says ("Reads, writes and examples"),
so the source sets every value its input controls and its own start state itself. A sign-in that started and was never verified is the exception: that
reset clears cookies and site storage. When the page is signed out after that reset, or after a
full page load your source asks about with `ensureSignedIn`, the host signs in again by itself;
do not call `authenticate` for it. When the host cannot keep the site signed in, the step fails with
`session_not_kept`: report that cause instead of signing in again. That source must perform
the flow from its input,
never rely on a page an exploration left open. So a read iterates from a reset start,
and re-running its example or live test is normal.
If the deadline expires, report the named readiness failure and use current
screened evidence to distinguish a remaining challenge, loading and changed
layout.<!-- opengpt:section core.challenge-reference --> Do not invent a CAPTCHA bypass or replace the target with an arbitrary
first element. Resolve role and computed accessible name from observed evidence;
`searchbox` and `textbox`, and their exact names, are not interchangeable.
When a locator is missing or a Playwright timeout names one, first check that the page's URL and
heading are the page you meant: a wrong or error page needs the site's own route to the right
page, never a new selector. Otherwise repair that wait and keep the checks that already
passed. A `DeadlineExceeded` phase of `execution` is the shared operation deadline. Before increasing a timeout, make one bounded observation of the candidate
target count or state; increase it only when evidence shows that the correct unique
target is slow. Do not catch-and-repeat timed-out work: a timed-out click or navigation is
an uncertain transition (`AGENTS.md`).

Never call `.first()` (or `.nth(0)`) on a broad text or regex match, whether to
click it or to wait for readiness: collapsed menus often hold an earlier hidden
match. Scope a role locator to its evidenced container and to visible elements,
for example `nav.getByRole("link", { name: /log in/i }).filter({ visible: true })`,
then check that exactly one element matches; `waitForOutcome` checks it for the outcome it
returns. When several candidates remain, inspect them and choose by evidence such as
section, accessible name and destination before clicking or waiting. A readiness wait targets one specific
evidenced element or page state.

Never search the open web, such as Google, to find the page a task needs. Make its URL an
input and ask the caller for it.

For a detail read whose input is the record's page URL, check that it is https on the tool's
site and open it unchanged. Otherwise reach the record through the site's own search, list or
link for the schema-validated caller identifier, or through a stable identifier route the site
itself uses when that is clearly better (AGENTS.md, "Work through the page's own controls").
A successful response or plausible content is insufficient: the final page's
site (any https host on the site's registrable domain), final path and stable page
identity must all agree with the requested identifier. A path agrees when it carries the
identifier; a site can serve one record under several of its own routes. Explicitly classify
a detail page, loading state, known interstitial and unsupported or mismatched page. Continue through an interstitial only when its
own stable identity matches the request and one unique continuation control belongs
to that interstitial. This exception does not include a CAPTCHA, login or unknown
challenge. Wait for the detail or proven interstitial, guard the continuation, then
wait again and recheck the final site, path and page identity before extraction. Use
typed failures for every other state; never return interstitial fields as a detail
result. `references/navigation.ts` shows this sequence in one call, reached through the site's
search (`detailNavigation`) and from a caller's page URL opened unchanged (`detailFromUrl`).

Target identity guards, effect authority and semantic completion are separate.
A dispatched click is not completed work. Missing completion after a possible
write, login or other consequential effect requires reconciliation before repeating
it. Bounded repeatable reads and transient search interactions may continue under
existing authority when source and current observations establish their semantics;
inspect state before choosing a retry or safe read reconstruction. A search/query
submission can be a read; autosave, drafts, uploads, holds and business commitments
are writes regardless of method or control names. <!-- opengpt:section core.raw-page-calls:start
Raw Page calls require host review and caller authority.

opengpt:section core.raw-page-calls:end -->Preserve the host's reported failure stage and dispatch state. Missing output or
a provider 404 does not prove that navigation, login or a previous action never
happened. A guard failure before one click says nothing about earlier actions in
that script. For a reviewed current-state inspection, check that the page is on the
site before reading the existing page, as `AGENTS.md` ("Check the page is on the site before exploring it")
shows. Prefer that retained state when usable;
reconstruct only established repeatable reads within the request's constraints.
For a repeatable read, use the exact returned failure phase to narrow the repair.
Do not replace a passed readiness condition or repeat successful setup merely
because a later extraction call timed out.
Never recreate a write or login to recover an observation. See
`references/native-page.ts` for a site-guarded read.

The tools and the files you may edit are in `AGENTS.md`. The host binds the caller's actual input/account; no tool
argument selects another account or private reference. A live test's `testInput`, on a
read only, is an input you choose as .agents/testing/SKILL.md says. Every new command/probe/execution gets Guardian review<!-- opengpt:section core.tools-and-files -->.
Nested Playwright actions do not each trigger review. A probe operation still receives the host-bound business
input. Its declared schema must accept that input even when the bounded observation
does not use every field; do not replace it with an empty or probe-only schema.

<!-- opengpt:section core.captured-checks -->

<!-- opengpt:section core.references:start
Choose relevant references: search for a search or listing tool, writes, cart for a cart or
checkout, pagination, forms, caller input for a choice only the page can offer, or a code,
during the run, and publication before the first `finish_build`.
opengpt:section core.references:end --> Read their bodies only when useful.
Finish with actual execution evidence and
truthful coverage through `finish_build`. A write finishes after its session's
confirmation read; never run the composed script live. Ask only as "Try hard, then
ask" allows. If infrastructure prevents further
work, report the recorded failure and unresolved effects, then end without
publication; the host preserves an incomplete build. Do not ask the user to
answer a provider outage. Publishing future code does not replace the build's own
result or resolve uncertain effects.

Examples: `references/parser.ts`, `references/native-page.ts`,
and `references/selection.ts`. For custom choices, the forms skill includes
`references/custom-selection.ts` and points to the relevant helper implementations.
Read those on demand when deciding whether a helper fits the observed control.
SDK reference gaps must be reported, not recreated as unreviewed infrastructure
in every site script.

For a demonstrated account/layout variant, handle every supported layout in one
script. The call that reads the page first observes which layout it shows, and the
script fails on a loading, ambiguous, unknown or mismatched layout. Inspect stable
containers, roles,
field organization and legitimate account/input capabilities; never classify a
layout from private customer literals, changing dates or whole-page hashes.
Loading is not proof of a new version. An identity mismatch blocks every candidate.

See the compiling `references/variants.ts` example.

<!-- opengpt:section core.layout-captures -->

## Cookie banners

Whenever a cookie or tracking consent banner shows, or a privacy notice, consent dialog or survey
pop-up, dismiss it before you do anything else on the page: in an `explore`, in each sign-in step as
its `dismiss` (the auth skill), and in the tool's own code, which dismisses it on every run where it
shows. Use its own control, in this order: its close or dismiss control, then one that rejects or
declines what is not essential, then accept, only when that is the only way out. A control such as
"I understand" or "OK" accepts too, so prefer its close or decline control whenever it has one.
Never click anything else in it, such as its settings or partner lists. A request that says
otherwise about cookies wins. This is only for such a banner or pop-up, never a marketing prompt or
terms the site asks you to accept.

## Safety defaults

Turn safety defaults off, on every tool, a read or a write. A preselected option whose only effect is to
share the caller's data with another company, such as a partner comparison that opens the search
on another site, to opt into tracking beyond what the site needs, or to sign the caller up for
marketing email, is never an input and never a question. The tool turns it off on every run
before the submit it affects, and reads back that it is off. When the site won't submit with it
off, leave it on and say so in the description. Name the ones the tool turns off in the
description in general words, such as "turns off partner comparisons". A repair keeps each one
the registered source turns off. Never turn one on yourself, in a form or a request body. For a
consent flag the site sets for the user in a request body, send the value read at run time or
leave the field out.

Find these boxes where you fill the form, unlabeled ones included. List every checkbox, switch
and toggle in and near the form by role and by `input[type=checkbox]`, never only by label, with
its checked state, its nearest text, its group's heading and the alt text or title of any logo
beside it. A preselected box whose group names another company or shows its logo is a partner
box. After a probe's first submit, check whether a new tab opened or the page left the site. If
one did, a box you missed sent it there.

## Authenticated operations

A signed-in operation needs no login or identity hooks. The host signs in before the
script runs, through an explicit direct HTTP request or host autofill, and the
script starts signed in. Each enters private values through the trusted host. The
script never receives a password. After a full page load mid-script, call
`ensureSignedIn()`, as the auth skill describes.

When inspection establishes a login entry, pass `loginUrl` and the first screen's
`signInStep` to `execute` with purpose `authenticate`. The host uses the URL exactly as given
and grants it no authority: credentials are typed only on the site's registrable domain or a configured sign-in
origin. Record the site's own sign-in link (auth skill) and include any observed fieldless
navigation steps needed to reach the credential form from it. A URL no sign-in can start from, and
a failed sign-in, come back with the reason and the next step; fix the cause and call
authenticate again. Author no login-routing file beyond the direct-request template the auth
skill describes.

Inspect login markup using reviewed read-only `explore` without private credential
injection. Use execute purpose `authenticate`, target `liveBrowser`, to sign in. The
host runs<!-- opengpt:section core.sign-in-request --> the observed `signInStep` and reports the sign-in. It runs no
generated code, and it does not claim or execute the business example. Login effects
have separate authentication evidence. If the same browser still shows a login page or
a signed-out state afterwards, inspect the page and correct the recorded steps or report the failure.
Credentials the site rejected are never resubmitted.<!-- opengpt:section core.login-markup --> Wait for the
signed-in page to become ready after login. Disappearance of the login form alone is
insufficient. The host requests codes and choices through protected input requests during
`authenticate`.

Only the host requests website credentials, and only during `authenticate`.
<!-- opengpt:section core.login-source -->`request_input` cannot request credentials. If the site cannot be reached, report that instead
of starting sign-in. Never request durable credentials in model arguments or
history.<!-- opengpt:section core.credentials -->

<!-- opengpt:section core.capture-evidence -->

Keep exploratory output focused on the current question: the relevant control or
container, its state, and the nearby choices. Prefer the existing accessibility
checkpoint to repeatedly returning whole-page text and all controls. If a probe
reports a missing choice, compare its post-action checkpoint before concluding
the site does not support it. Listing a filter panel's or option group's controls is a
focused observation. Return explicit partial coverage when an observation is bounded; never
describe a truncated list as complete. In a probe, count a locator before acting on it and give
each action `timeout: 5000`, the default the host also gives probe actions; take names from a
scoped `ariaSnapshot()`, not visible text. A probe that waits out a long timeout for a missing
element learns nothing a count would not. Return `waitReport()` from a probe that waits.

Supported login challenges during `authenticate` belong to the host's sign-in
(autofill or an explicit direct HTTP step) and its protected input requests. Generated `operation.run` and `explore` code
never request or enter a sign-in code, or sign in themselves: a code that is part of signing in
belongs to the `authenticate` step (auth skill). A code the site sends later, to confirm a protected action after sign-in, is different:
declare it as a `secret` question and ask it with `ask`, as the caller-input skill's
`caller-code.ts` shows. A missing ordinary page
control alone does not establish a human-verification challenge. Observe the
current page state within the existing deadline. When a few distinct attempts have
not found the way, ask the caller for directions with `request_input` before
reporting a blocked or unknown state whose cause cannot be established. Completing a
challenge does not prove login.

For a native dialog, the call that raises it keeps it on `globalThis.dialog` from a
`page.once("dialog")` listener and returns its type, message and URL without awaiting the
click. Pass that to `decideDialog` with a stable step name, and apply the host's choice in
the next call with `globalThis.dialog.accept(promptText)` or `globalThis.dialog.dismiss()`,
as in `references/native-dialog.ts`. Never pre-dismiss the dialog or retry the action.

## State-changing requests

A live execute result may carry `stateChangingRequests`: every request other than
GET, HEAD or OPTIONS the page sent since the last execution result, by `method`,
`origin`, `path` and `resourceType`, with a `count` (`omitted` counts routes past
the list). Each entry also lists its requests' final response `statuses` in order, and
`unanswered` counts any with no answer when the step ended. Nothing refused them; the
list exists so you can catch writes you did not intend. Telemetry, analytics and bot-sensor POSTs are normal and need no change.
So is an anonymous recent-search, prefill or search-state save the site fires when
you submit a search.

For a read tool, look for a write your own action caused, such as adding an item to
a cart, submitting a form, saving a preference or starting a checkout. If you find
one, change the code so it reads without causing it, for example by reading the
value from the page instead of clicking the control that changes it, and run it
again. Setting a read's location, filter, sort or option through the site's control is part of
the read, not a saved preference (the input schema above). For a write session, the list shows the commit your step caused and any
autosave, with the status the site answered: a 2xx or 3xx on the commit's route, with no
error after it, is what the writes skill confirms from. A 200 whose body reports an error, as
GraphQL can, did not go through. The list is the evidence for the `http` version, and any
other write is unintended and must not be in the composed script. `initiator` is evidence, not proof: `evaluated_script` is usually your own
page evaluation, `page_script` is the site's script (which your click can also
start), and `parser` is markup such as a form submission.

## Host incidents

The host records every request your code causes and blocks none. An execute or inspect result
may carry `hostIncidents`. The first model request may carry `hostIncidentsBeforeStart` for the
host's own entry-page load. The mint continued past each listed gap.

`hostIncidents` kinds:

<!-- opengpt:section core.incident-kinds -->

Unclear means possible. `websiteEffect: may_have_dispatched` makes that execution's
effect possible: reconcile current state before claiming success, and never repeat
a claimed example or an uncertain write blindly: in a write session or a maintenance
repair, read back whether the write happened first, and do the write only if it did not.
`hostBug: true` marks a suspected OpenGPT defect, which the host has reported. On a
`dialog`, report it in your diagnostics and do not work around it. On an `observation_gap`
or `capture_unavailable`, note it in `finish_build` coverage and keep building. A gap never
stops a read. A write the gap covers has an unknown outcome, so never repeat it without the
read-back above.
<!-- opengpt:section core.standalone-completion:start

## Standalone execution and completion

Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above. `liveBrowser` is native Playwright and `pureFiles` is local computation. The host retains Guardian review, caller authority, source reads, questions, deadline/cleanup and no-replay rules. It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.

Declare explicit input and output schemas, concrete types and bounds for each supported field. A detail read verifies the requested record identity and final page state.

`finish_build` returns the current integration files and schemas after shared checks. A read needs a successful example using supplied values. A write needs its original confirming act receipt and current source; compose it without running it again. Return the task result and honest evidence, not unsupported success claims.

Only the host asks for website credentials and only during `authenticate`. Give it the observed field selectors, slots, allowed identifier kinds, format and submit. No generated source receives the raw password; follow the same destination, stale field/focus, no-readback and code-handle rules as hosted execution. Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.

opengpt:section core.standalone-completion:end -->

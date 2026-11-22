---
name: writes
description: Do a write build's requested task once as a live act session, confirm it, then compose and publish its script without running it again.
---

# Do the task once, then compose its script

A write build changes something real on the caller's account: an order, a booking,
a submitted form, a saved profile. There is no practice run. The write is the whole
task the request asks for, done once, live, with the caller's values, as a series
of `act` steps. When the caller's input is empty (`{}`), pass the request's values and
the owner's answers as `exampleInput` (JSON text) on each act step that needs them. The
first act step that passes it fixes it: later steps repeat it unchanged or omit it, and
every step from then on runs that one input. Decide from the
request and the site which inputs are required, and keep them required. An optional
input plus a declared question the tool asks before any effect is only for a value the
request genuinely leaves open; never make a value the request states optional with
nothing that asks. It may take several write steps: filling in and advancing a
multi-step form, choosing options, saving, then submitting. Drafts, autosaves and the
saves a site makes at each step along the way are part of that one task. You never
redo the whole task, and never redo a step that finished; run a step again only when
a fresh read of the page shows it did not finish, or the task cannot complete without it. Then you compose the
published script from what those steps did and publish it. Nothing runs again.

A read build may search, filter and query, but may not fill in or advance a form that
saves data on the site, save or submit anything; a task that needs that is a write build.
Signed out, setting the session's store, location or delivery or pickup mode is part of a
read, even through a Save button, and so is entering the details the caller gave to set it,
unless the step creates an account or a lasting record on the site (core skill). While building,
a live step, the example's or a test case's, that enters a name, email or phone asks the owner
first, as the execution review requires; the answer keeps the build a read. Adding to a cart, a hold on inventory, a seat or a time slot, an upload and a draft stay writes,
signed out too.

## When a read build finds it needs to write

When a read build's task turns out to need that (a form that saves each step, a search
that is really a booking), ask the caller with `request_input` whether the build may make
that change, saying in one or two plain sentences what it would change on the site and why
the task needs it. Ask as soon as exploration shows it; a live read example that already ran
is fine, though it never stands in for the write. Once they confirm, by picking your option
or in their own words, call `mint_update` with the change `{"setting": "effect", "effect":
"write"}` and the answered question in `confirmedBy`. Guardian reviews it. An `updated` result
makes this a write build in place: every later step is reviewed under write authority and the
rules below, what you explored stays valid evidence, and the first `act` step starts on the
site origin page. If they keep it read-only, finish what a read can do, or recommend a new
write build with `mint_update` and `recommend: "new_mint"`.

## Before the session

Sign in first when the site needs it, and for a cart or checkout as .agents/cart/SKILL.md
says, with the auth skill: read-only `explore` to find the login, then
`authenticate`. Before the first `act` step you may still explore
read-only, for example to read the first page's options, but never fill, select,
add, save or submit anything there, except one made-up key in the site's own format, with a
serial past any the site lists, per input that takes a record's own key, looked up once in the
site's own lookup to see what it shows for a key it has no record of (core skill).

Settle the whole path before the first `act` step, from the request and what read-only
exploration shows, such as the form's list of pages or steps: every step that saves or submits
on the site, through to the outcome the request asks for, such as the quote or decline, the
placed order or the confirmed booking; prefer not to end at a saved draft or a new account on
the way to it. Publication judges the finished tool by the same rule
(`reference/publication-review.md`). Declare it as `writePath` on the first `act` step: in
`steps`, each step that saves or submits, in order, with the `commit` mark its helper will
enter and what it saves (`does`); in `ends`, what the last step leaves the caller with.
Guardian reviews the path before anything is sent, and the host keeps it: the session is not
over until every mark on it is entered, so a step that confirms earlier leaves the session
open, and its receipt's `writePath` lists the marks not yet settled. When the page shows the
path must change, such as a page the site skips or adds for this input, declare the revised
path in `writePath` on the next `act` step, keeping every mark already entered. When no single
session can reach the outcome, such as a step that waits for another person's approval, an
emailed link or a later date, or Guardian denies the path for that, end with `report_blocked`
reason `site_lacks_capability` before the first `act` step, naming that step: a build has one
write session, never a second.

Read the path's options with read-only exploration where you can, and settle them before the
first `act` step where possible: ask with
`request_input` about the ones the caller's input does not settle, as `AGENTS.md` ("Try
hard, then ask") says: each costly choice you saw, one that changes what the caller buys or
pays or whether the action can be cancelled or refunded (each paid add-on and pre-selected paid
option within the tool's purpose, a rate, fare or plan tier, a refundable or non-refundable
option, shipping speed, how much of a balance to pay, the payment method and the delivery
address), and any other option only when
the request's purpose clearly depends on it. An unasked optional field keeps the page's
default and is still an optional input of the script. Prefer keeping the value the page
already shows in an optional field that adds no cost over asking the caller to confirm or
correct it, and list it in `finish_build` `assumptions`. Ask only about options the site
actually shows. A control with exactly one possible value (a select or radio group with a
single option), or one the input or an earlier answer already settles, is no choice: never ask
about it. An add-on toggle, a pre-selected checkbox or a lone saved payment method or address
is still a choice to ask about. Never keep, clear, accept or decline one of those unasked. A paid upsell
outside the tool's purpose, such as a membership, subscription or trial offered during a
checkout, is not a question: the script declines it, and never accepts one without an input
the caller set for it. A safety default (core skill, "Safety defaults") is
neither: never ask about it, and the script turns it off. Credentials never go through a
question; the host's protected form owns them.

During the session:

- Finish everything that can still refuse the task or change what it commits before the
  mark of the commit it guards: choose each option that changes the price, decide each add-on
  from the input or an answer and decline an out-of-scope upsell, read the selected options
  and total from the current page or an available read-only summary, check the total against
  any limit the input sets, check that no option the input does not settle is selected, and
  check the items, address and payment. Use a review page when the site has one; a separate
  review page is not required, and submitting a form is never a way to discover whether one
  exists. A check that can only run after an earlier
  marked step, such as a total that shows only once a saved address step has run, runs before
  the later step's mark; its refusal then reports a possible change, because the earlier step
  may have saved something, and that is honest. Still mark that earlier step.
- When one of those checks rules the task out, such as a total over the caller's limit, an
  item out of stock or a variant the page does not offer, the script refuses before the mark
  with `InvalidInput` (the caller-input skill, "Throw the error that matches what happened"),
  or returns a refusal its output schema declares before its first mark (below). Never return
  a refusal in an output shape the schema does not declare. Apart from such a declared
  refusal, prefer throwing over returning when a write stops before its last commit step. A
  report of the form's fields, its validation messages or the options to pick from is a
  refusal (`InvalidInput` with `available`) or a failure (`OperationFailure`), not the write's
  output. While building, a limit the session meets is the
  owner's to settle first: ask them to revise or stop, and end with `report_blocked` when they
  stop, as the cart skill's "Minimums and refusals" says. When they stop, or the session cannot
  reach the task's end, end with `report_blocked` (`site_declined` when the site refused this
  example). A build whose session never reached the end publishes nothing.
- When the caller's own task asks for whatever the site ends up with, such as the product a
  quote ended up on, follow the site's preselected substitute and return the value the site
  used instead of throwing `InvalidInput`. Only the caller's task text counts this way; an
  output field or description you wrote does not.
- When a write's form adds required fields that depend on earlier answers, prefer declaring
  the site-field question and asking it for a required field that no input covers, before that
  step's commit mark, over refusing. When such a field shows only after the step's click, ask it
  once `blockingRequiredFields` returns it, which proves the click saved nothing: call
  `notCommitted` for the step before you ask, then fill the answer, check the step again, then
  call `enteringCommit` again with the step's name, and click once. When a step shows several
  such fields at once, ask them in one round, declaring one site-field question per field. It
  isn't for passwords, codes or logins.
  When `blockingRequiredFields(form, before, { unaskable: true })` returns `{ unaskable: true }`
  after the step's first click, the click saved nothing but a field it flagged is one no
  site-field question may ask, such as a card or bank field: call `notCommitted` for the step,
  then throw `InvalidInput` that names the field by its label, and don't click again.
- On a write saved across several pages, when the site's own option lists for a later page can
  be read before the first save and do not depend on what an earlier page saves, such as the
  form definitions or option data an earlier page loads, prefer reading them and checking every
  caller value for those fields against them before the first commit mark, in the session and
  on every run of the composed script. Match each value by the site's option value as well as
  its label (forms skill), and refuse with `InvalidInput` and `available` before anything is
  saved when a value matches neither. A refusal after an earlier save leaves a half-made record
  and an outcome the caller can't know.
- A pop-up, banner or interstitial on the path, such as an upsell, is conditional unless the
  page always opens it in answer to an action: handle it as the forms skill says, so the tool
  still works for a caller who never sees it.
- Before committing, read back from the page what you are about to submit and check each
  value as the core skill's Confirm step says, against the option the tool picked when it
  picked one, or the site's version of a typed value it rewrote (below), in the session and
  on every branch of the composed script. Fail if one does not match, and prefer running
  this check before the step's commit mark, so a mismatch stops the step before it sends
  anything. Never read back a field filled with a secret handle.
- Read each typed value back once its field settles, before the step's commit. When the site
  rewrote it as it was typed or on leaving the field, such as an address it standardized, or
  offered exactly one suggestion for it, take the site's version, as you would a picked
  option: later read-backs, such as a review page, summary or confirmation, compare against
  it, and the output returns it for that field. The one suggestion counts only for a
  free-text value the caller typed, such as an address or a name in a text box the site
  completes, never for a picker that selects a record, such as a person, assignee, customer,
  linked record, store or account, which keeps the reference rules in "Check the read-back"
  and the caller-input skill's. Add an optional output field `<input>_note`, such as
  `address_note`, that reports the rewrite with what the caller sent and what the site kept.
  Check it once with `sameText(shown, typed, { rewrite: true })`, which only decides what the
  note says: when it holds, the site only reformatted the value, and the note says so; when it
  fails, the site dropped or changed part of what the caller gave, and the note says it
  changed. The write goes on either way: never throw `InputNotApplied` for such a rewrite. A
  value cut short by the field's length limit, digits an input mask dropped, or a field that
  cleared is a failed fill, not a rewrite: fill it again in the field's format, or refuse as
  today. A value the site replaces only when a step saves follows the read-back before
  committing, above.
- On a form saved over several pages, before the final commit, read back what the site saved
  for the caller's values, from a summary, a review page or each saved page, in the session
  and in the composed script. Compare each value the site shows with
  `readBackMatches(shown, wanted)` from `opengpt-browser-engine/runtime`, against the option the tool picked
  when it picked one, or the site's version of a typed value it rewrote (above): `wanted` is
  that option's label or that version, and the caller's value otherwise. It
  accepts the same value in another format or word order, and every number must match
  exactly, the same numbers in the same order. When the site kept a different value, save that
  page again once with the same entries and read it back again, but only when saving it again
  updates the same record or page, never when the save adds an item, such as a cart line or a
  row. Prefer `saveAndReadBack` from `opengpt-browser-engine/runtime` for such a page's save: it does both
  and returns the values that still differ. When one still differs, or a page whose save adds
  an item kept a different value, stop before the final commit's mark and throw
  `InputNotApplied` with its `field`, `requested` and `applied`.<!-- opengpt:section writes.several-saves -->
- When the write changes state that already exists, such as a saved record or a cart
  (.agents/cart/SKILL.md), read that state before the committing step and again after it,
  in the session and in the composed script. Fail when a field the input sets did not change
  as asked. Any other difference follows "Check the read-back" below: the script still calls
  `verified()` and reports the difference in its output. Read both through the same query or
  view, selecting the same fields: two read paths, such as a list's row and the record's own
  detail view, can return the same unchanged field in different shapes, and a comparison
  across them then reports a change that never happened.
- If a step meets an option the input does not settle, stop that step before choosing
  it and ask, in one round for the whole page once every value the input and earlier answers supply on it is filled (forms skill). A `request_input` question during the session waits in place; a choice
  that exists only on the page mid-flow, such as a seat on the flight just chosen, is
  a declared `ask` in the next `act` step's script (the caller-input skill). An
  answered question settles the option. Check the page again before continuing.

## The session

Author each step as a Kernel script under `src/` with the caller's input schema (the
core skill), and keep the flow's calls in a module the composed script will import
too. Run each step with `execute` purpose `act`, target `liveBrowser`.

- The first `act` step claims the build's write. It carries the `writePath` (above). The
  host resets the browser to the site origin page first, with fresh page state that keeps
  the browser's cookies and site storage (a signed-in build keeps its session), so that
  step starts the flow there and sets every value its input controls itself.
- Later steps continue on the page exactly as the previous step left it. Keep steps
  small and read the actual state after each submission. On multi-step forms, a
  button named Continue, Next or Save may save a draft, persist that page, or finish
  the task immediately; its label does not establish that another review or final
  submit follows. A step that saves or advances a form page is part of the task,
  not a second write. The composed script runs the steps back to back, without the
  pauses you took between them. So prefer ending a step that redraws the page, such
  as a filter, a pick or a new table row, with `waitForOutcome` naming the element
  the next step uses.
- When a step waits for the site's answer, wait for every answer the site can give, such
  as results, a no-results message or an out-of-area notice, rather than waiting for
  results alone. A message about a value the caller gave, such as a field error, is the
  caller's input error: throw `InvalidInput` naming the field, with the options the site
  offers as `available` when it lists them.
- When the site says no to a valid request, such as sold out, no availability, not
  eligible, not offered for these facts or not served in this area, that no is the task's
  answer. Prefer returning it as a refusal the output schema declares (below), with a
  `reason` code of the tool's own, listed in the tool's description, `site_message`, the
  site's own words exactly as the page shows them, and any alternatives the site offers,
  exactly as shown. Return it only from what the site shows in this run, never from a rule
  copied into the tool's own checks, and never from a challenge, block, access-denied,
  error or maintenance page, which is a failure (`OperationFailure`). After a commit mark,
  return it only where the declared-refusal rule below says one returned there completes
  the run; otherwise prefer throwing `InvalidInput` with the site's words.
- When the site swaps the request for something the caller didn't ask for, such as another
  product, a later date or a higher amount, stop before the step that would confirm it and
  return the refusal as above, with the site's words and its offer, unless the caller's own
  task asks for whatever the site ends up with.
- Report a confirm popup to `decideDialog` with a literal `step` name, and keep that
  literal in the helper the composed script imports. Runs accept a popup without
  asking only at the step the session accepted it at, so the host refuses to publish
  a composed script that drops one.
- Place a commit mark only on the step that sends the change to the site, such as a
  submit, save or confirm control, or a control whose handler sends the caller's change to
  the site. Opening a form and typing into its fields change only the page's own state, so
  leave them unmarked unless the site's requests show they save the caller's change, such as
  an autosave; a lookup, suggestion, validation or analytics request saves nothing. Place
  the first commit mark at the first step that saves on the site. Mark every such step other
  than a hold that expires on its own, including an autosave, a saved form step and a
  payment submission whose next screen is unknown. Call `enteringCommit("place-order")` right before the
  execute call that can send that change, and declare the names in order as
  `write.commits`. Use the same marked helper in the session and the composed
  script. The marked call does the commit and nothing that can still refuse: it re-reads
  only what a change since the checks would make wrong, such as the total and items they
  read, and when one moved it returns before clicking and the script throws
  `OperationFailure` naming the change, such as `total_changed`; otherwise it clicks once
  and waits for the confirmation. That guard is expected. An entered mark counts as possibly
  sent even when its call stopped before the click, so a check that can refuse placed there
  reports a possible change and sends a write that never happened to maintenance. If the call
  returns an unexpected page or fails while waiting for an assumed review, read back before another submission: the task may already be
  complete. The host cannot see a commit sent as a GET link or over a websocket, so
  the mark is its evidence of whether the commit step ran.
- Mark the commit at the step that submits the booking or order; a hold that expires on
  its own, such as a reserved table or a cart timer, is not the commit.
- When the site's own answer to a commit click proves it created nothing, by a response, read
  whole, that names the site's reason for refusing, such as an expired quote, a changed price or
  sold out, and returns no record, call `notCommitted` for that step, then end with the site's
  words, preferably as a declared refusal (below): the run then reports the write not applied.
  Wait for that answer in the commit call, beside the confirmation. A 5xx, a timeout, a conflict or
  duplicate answer, or an error inside a returned record is not that proof.
- A quote the site issued earlier, such as a fare, rate, cart price or hold, can expire before
  the commit, for example while the step waits for review. Prefer having the commit step reload
  or re-select it right before its mark, so the site issues a fresh one, and check that one
  against the caller's limits, such as the cap and the same item or route, before the mark as
  above. When the site answers the click by saying the quote expired or the price changed, with
  that proof that it created nothing, call `notCommitted` for the step, refresh the quote and check it again,
  then call `enteringCommit` again and click once more. A fresh quote that breaks a limit refuses
  before the mark, so the run reports nothing applied. Retry only once: a step goes back once a
  run, so a second such answer ends the run with the site's words, returned where the
  declared-refusal rule below allows a refusal after a mark, else thrown as `OperationFailure`.
  Neither answer is about the caller's input, so neither is `InvalidInput`.
- The host refuses an `act` step whose source is unchanged since it ran and sent
  state-changing requests: submitting it again could commit twice.
- Read `stateChangingRequests` on every step. It lists the commit your step caused,
  with each request's response status, and any autosave or draft save. That is the
  evidence for the `http` version; any other write is unintended and must not be in
  the script.
- Prefer confirming the write from its commit request. Keep the click on the final commit
  control, such as Save, Send, Submit, Book or Pay, in its own step. In the same call as
  that click, wait for the site's response to the request it sends, matched by the method
  and path the session saw carry the commit on the site, and by its body where the body
  shows the caller's values, as `references/write-readback.ts` does: a `{ response }` answer of
  `waitForOutcomeResult`, beside every way the page can answer, listing the site's error or
  validation message (`{ invalid: form }`) first. The write went through when that response is 2xx or 3xx, a body the call can read
  shows no error, and the page shows no error or validation message after it. A 201 whose
  Location names the new record went through as soon as it arrives, with no wait for the
  page. A 200 whose
  body reports an error, as GraphQL can, did not go through. A 202, or a 2xx whose body says
  the work is queued, went through too; return that in the output as a status in the core
  notation, such as `queued`, with the site's own word in a `status_label` field. Then read
  what the output promises from that response or from the page the commit
  left, match it to the caller's values, and call `verified()` with no argument just before
  returning. Declare `write: { confirmation: "readback" }`. Prefer not opening another page,
  such as a list, a history or an account screen, only to prove the write: a commit that went
  through, with the new record's id, already proves it. When a commit
  step returned without calling `verified()` and its `stateChangingRequests` list the commit
  request with a 2xx or 3xx status, prefer confirming it in the next step from the page as
  it stands. Make no execute
  call after `verified()`: a later call reopens the effect. After the confirming step,
  further `act` steps are refused.
- Prefer confirming the final commit with `confirmCommit(answer, page)`: import
  `confirmCommitCode` from `opengpt-browser-engine/runtime`, paste it after `waitCode` in the commit call,
  once the form is filled and just before the click's wait, and pass it the `{ response }`
  answer of that click's `waitForOutcomeResult` and the page. It applies the commit-response and
  page-error rules above in one place, so prefer it over writing your own status and body
  checks, and call `verified()` only when it reports done.
- Read the site's own proof instead only when the commit request can't confirm the write:
  no such request went out; it failed, got no answer or returned an error status; its body
  shows an error, or can't be read on an endpoint that reports errors with a 200, such as
  GraphQL or a batch call; the page shows an error; the commit went over a websocket or a GET
  link; or a later stage the site can still refuse, such as sending what an earlier click
  saved, sent no request of its own. Then prefer the confirmation the page shows after the
  click: an order, booking or reference number, or a success message or toast that appears
  after the click with no error on the page. Open the saved state, such as the orders page,
  the booking list or the updated profile, only when the page shows no confirmation. Match
  it to the caller's values, return the number or record in the output, and call
  `verified()` as above. A 200 from any other request is not a confirmation.
- Only if the site offers none of these, a commit response the call can check, a
  confirmation or the saved state, the write is `unverifiable`: do not call
  `verified`. It publishes flagged, and its runs report the write as possibly
  completed. A session in which any step recorded a confirmation is never
  `unverifiable`; publish against the confirming step.
- When a read-back is needed, the first one that matches confirms the write; stop there. It
  matches when it shows
  the written record after the write, found by something the write produced or entered (its
  number, its own reference or the values entered), and every field the caller asked
  for that the view shows agrees (the read before the commit already checked what you
  entered). Sites reformat what they save, such as line breaks, spaces and dates in the
  viewer's format, so compare text after the commit with `sameText`, as before it (the core
  skill's Confirm step). Compare a chosen option's value only where the
  view shows that value; otherwise compare the label it shows. When the write changed state
  that already existed, the same read is also the after read of the before-and-after
  comparison, which runs after `verified()` ("Check the read-back"). Write each read-back step
  to check the requested fields in its own code and call `verified()` when they hold, so the
  first one that matches is the confirming step. Read one
  confirmation, list or detail view: find the record there by that identity, never by its
  position, such as the first or newest row, and prefer finding each value in it by a stable
  id, its column header or a `data-` attribute over its cell's position. Read only that record,
  and the view's other rows only where the before-and-after check or another skill, such as
  the cart skill, compares them. Read another page, in that same step before `verified()`,
  only for a field the view did not show and the tool's output promises. A reference the site
  saves as an ID follows "Check the read-back" below. A message the site shows after the commit
  about something else, such as a notification that failed to send, doesn't undo a read-back
  that confirms the record: call `verified()` and return it as a warning in the output.
- State from before the write never matches. Require something only the finished write can
  show: the number or reference it produced, or a value it changed from what you read before
  it, such as a status that now reads Sent or a row that was not there. A list still showing
  the row from before the write, or a table that has not reloaded yet, neither confirms the
  write nor shows that it did not happen. Values you entered find the record but never prove
  it new. When they are all a create's read-back can match, read that list before the write
  too, in the session and the composed script, note the rows that already match (their count
  or ids), and count only a new one: a row whose id you had not seen, or the one match where
  there was none. When two rows match after the write and no noted id shows which one is new,
  values alone do not confirm it.
- Never repeat a step blindly. If an `act` step fails after the page sent a
  state-changing request or opened a socket, after it entered a commit mark, or
  without returning a result at all (its page was lost), the write may already be
  committed; its receipt says so under `writeSession` (`verifyFirst`). Before any
  further write, run an `act` step that only reads the page or the account. When
  `stateChangingRequests` shows the failed step's commit request went through, that
  step starts from the page as it stands: check it for an error or validation
  message, read what the output needs, and call `verified()` there. When that page
  lacks something the output needs, such as the new record's ID, the same step may
  read it elsewhere on the site without changing anything, such as by finding the
  record in the site's list or search, then call `verified()`. If the
  write happened, call `verified()` there and publish against that step, never
  submitting it again. If nothing happened, do the write with the
  caller's values, which is the first commit, not a repeat, and read its confirmation. If no
  read-back can tell, never submit again: publish it as `unverifiable`. The host refuses only an unchanged
  commit step run again straight after it sent state-changing requests, and never
  resubmits for you. Make the composed script match what actually worked end to end.
- A failed step that sent no state-changing request changes nothing: the next `act`
  step reads the page as it is and continues, finishing what is still missing.
  A step that never calls `verified` does not end a session.

Once the session has started, a live `explore` or `test` is refused, and a write
build never runs a live `example`: read what the composed script will need, such as a lookup's
list, in an `act` step that changes nothing. The session is the one run that proves the write:
never run the write again, and run no live test of it.<!-- opengpt:section writes.http-replay -->
That rule is about running the write, not about writing checks: a write's script is expected to check its own
result, with a confirmation or read-back, a before-and-after comparison where it changes existing
state, and an offline check of that code.

The composed script's own checks never run live before publishing, so check them offline.
Keep the read-back match and the before-and-after comparison as plain functions in the module
the script imports, and before `finish_build` run them with Node in `exec_command` over what
the session read. They must pass for the write that happened, and must not flag a field the
site maintains or the same value in another form. This quick check sends nothing to the site
and is not a second write.

- Check against the before and after reads your `act` steps returned first. Use response bodies
  under `captures/` only for what those outputs lack.
- Only a body saved whole counts. A body the capture marks pending, incomplete, omitted, withheld
  or unavailable, an empty body where the site sends one, a truncated step output, or a field
  that carries a mask or redaction note leaves that part not checked, never passed: name it in
  `coverage`.
- An exchange you cannot find in `captures/` is not evidence that it was not sent. Read the
  capture index's gaps, the host's capture notices (a lost publication, a new browser) and every
  capture session before concluding anything from its absence.
- Pick the after body by the commit's time and the record's identity, never by its URL alone,
  and skip a duplicate a service worker served.
- Compare values, never serialized text: a screened body may be serialized again.

## Check the read-back

The read-back, as the session's rules above describe it, compares what the site saved with what
the caller asked for, in the form the site saves it.

- A reference, such as a person, an assignee, a linked record or a linked row, is often saved as
  the referenced record's ID while the page shows its label. Take the caller's label or ID as the
  input. Before the commit, look the ID up through the site's own list: the picker's options, the
  member list or the linked table's rows, which a read of the same site often already returns.
  Since nothing runs live after the session, prove the lookup in it: read the list in an `act`
  step that changes nothing, before the commit step, or from the response of the site's own
  lookup request in the session's captures. When a `not_published` asks for a lookup the session
  did not run, prove it in an `act` step that only reads, while the session is open (below),
  never by committing again.
  When no entry matches, throw `InvalidInput` with `field` and `available`; when several match
  equally, take the first in the site's order and return the one it used, as the site labels
  it, or list them for the caller to choose one, as the tool decides (core skill, the input
  schema). Write that ID or pick that entry, and
  compare the read-back by ID, never a label against an ID. Return the reference as
  `{ id, label }` (records skill). Do not drop a reference field only because the site saves an
  ID: the lookup is the fix. When the site shows no ID and offers no list to resolve one, compare
  the label the read-back shows with the caller's, normalized as above. When neither can tell,
  ask the owner in the build's one bundled `request_input` question, or follow the rules above:
  never call `verified()` on a read-back that cannot tell, and publish the write `unverifiable`
  when no read-back can.
- When the write changed state that already existed, check that every field the input sets
  now matches it. For every other field, flag only a change the session's own confirmed write
  did not make too. The session read the record before and after that write: a field the site
  changed there on its own, without being asked, such as an updated-at time, a version counter,
  an edit history, a last editor or text the site derives from what was written, changes on
  every correct save, so leave it out of the comparison. A field the flow itself cleared or
  reset by mistake, such as one a form sent back empty, is not one the site maintains: fix the
  flow, never leave it out. Compare the remaining fields by value, after
  bringing both reads to one shape, never by object identity, serialized text or the order of
  an object's keys: the same person or record returned as a new object is unchanged, and a
  reference compares by its ID, as above.
- Once the commit is confirmed and every field the input sets reads back as asked, the write
  applied: call `verified()` then. Run the before-and-after comparison after it, over the reads
  the call already made, and report a difference it finds in the output, in a field the output
  schema declares for it, never by throwing. A throw after a confirmed save fails the run: the
  caller gets an error in place of the output, though the write landed. When the script confirms from the
  commit response, take the comparison's after read through the before read's query in the same
  call, before `verified()`, so that `verified()` stays the last call to the site.
- A write with branches, such as create when nothing matches and update when one does, runs
  one branch in the session. Each branch may make its own commit call, such as a create call
  and an update call; keep their confirmation and comparison in shared code that reads back
  through the same calls. Check a branch the session did not run offline,
  as above, against captured shapes: a record from the session's before read, or from a list
  response, has the shape an update reads back. When no captured shape can stand in for it,
  ask the owner in the build's bundled `request_input` question, before the session's first
  commit, which branch the session should run live. Never run a second write only to try
  another branch. Name in `coverage` the branch the session ran.

## Compose and publish

Write `src/tool.mjs`, the `playwright` version: a Kernel script running the whole
flow from the site origin page and the caller's input, with the same calls, the commit
exactly once, and the same confirmation or read-back the session recorded. The call
that reads it, the commit call or a read-only call after it as in the session, reads
only what the session's confirming step read and returns it; the script matches those
values to the input and calls `verified()`, as the references do. Nothing runs live
before publishing, so a read the session never made, added to that call, can fail
after the write has landed, and a run that hits it reports a successful write as
possibly completed. When the session confirmed the write on another page but its commit
step's `stateChangingRequests` listed the commit request with a 2xx or 3xx status,
prefer confirming the script from that request in the commit call, as above, over
opening that page. Declare the script's contract, `defineOperation({ name,
input, output, write: { confirmation: "readback", commits: ["place-order"] } }, run)`
(or `"unverifiable"` when the site shows neither a confirmation nor the saved state),
marking the same commit steps as the session. A script declared `unverifiable` cannot call
`verified`. One that declares no commit marks is refused as `commit_marks_undeclared`,
and one that declares a mark no `act` step of the session entered is refused as
`commit_marks_unentered`. If the declaration names the wrong marks, correct it to
match the marks the session actually entered. It declares every mark of the session's
recorded `writePath`, in order: one that leaves a mark out is refused as
`write_path_undeclared`, and a publication before the session entered every mark of the
path as `write_path_unfinished`, which names the marks not yet settled while the session
stays open. If the completed session entered no
marks, it cannot publish: changing its source or entering a mark in a later read
cannot show that the earlier commit was marked. End the build and explain that
the task completed but its commit steps were not marked; never repeat the write
to add them.

Every option the session met on its path is an input of the script, add-ons and
pre-selected defaults included: required only when the site requires a choice that neither
the request nor an answer settled, optional otherwise. The script sets each option from its
input. An unset optional input leaves the page's default, as in a read. An option the request
or the owner's answer settled as how the tool behaves, such as which kind of record it
creates, which line type a free-text line takes or whether a save runs the site's automation,
is the tool's default: an optional input declared with `defaultedInput` and the answered value,
whose description says so (core skill), never a required input or a question the script asks.
The exception is a paid add-on or pre-selected paid option
within the tool's purpose, the payment method and the delivery address: each must be
explicit, so the script never keeps, clears, accepts or declines one the input leaves open. It
asks with a declared question before the commit mark (the caller-input skill), offering a
saved payment or address as an account-specific choice. The same holds for any choice that
changes what the caller buys or pays, or whether the action can be cancelled or refunded, such
as a rate, fare or plan tier, a refundable option, shipping speed or how much of a balance to pay. An owner's
answer may make declining such an option, turning it off or the option that adds no cost and
keeps the action cancellable the default of its optional input, never accepting, keeping or
choosing one. Choosing the address and payment is
part of a checkout's job, so the page's pre-selected one is never used silently. The request
and the owner's answers settle such a choice for the session only: the published tool serves
other callers, so it takes the choice as an input or asks, never hard-codes the build's answer,
and never leaves it to the page's default. A costly choice the request, the caller or the owner
declined still stays an input or a declared question, whose default may only decline it.
An out-of-scope paid upsell is declined, as above. A safety default
(core skill) is neither: never ask about it, and the script turns it off. An
account-specific value, such as a passenger, loyalty number, saved card, address or
account ID, is a free-form input, never an enum member, example or default in the
public schema (core's input schema rules).

The composed script publishes without ever running end to end, so it ends with a check that
tells whether its action succeeded: its commit response checked as above, the site's
confirmation for this submission, or a read-back of the saved state matched to the input,
unless the site offers none of them; then declare it
`unverifiable`. Compose it from the steps that worked, also when a commit step returned an
uncertain result and a later read-back showed the write landed.

<!-- opengpt:section writes.alternate-version -->

Call `finish_build` with entrypoint `src/tool.mjs` and the confirming step's
`executionId` (for an `unverifiable` write, the step that committed). The host reads
the script's contract offline, checks that the input the session ran (the caller's own,
or the `exampleInput` the first act step to pass one fixed) decodes against it and that
the named step recorded the declared confirmation, then publishes. A
`not_published` reason of `confirmation_undeclared`, `confirmation_unrecorded` or
`contract_input_mismatch` means correct the source and call `finish_build` again;
never run the write again. So does `input_feedback`, Guardian's findings on the input
schema; the host re-reads the corrected schema offline. `write_not_submitted` means the
session has not demonstrated the requested write: no step recorded a confirmation, and no
`act` step Guardian labelled a write reached the site unless the outcome review found it
did not happen. Continue the remaining authorized work. If a step may already have
committed, read back first, in a new file, as "Never repeat a step blindly" says. If the write
happened, publish with `readback`. The host runs
a step that may have committed only once, unless the outcome review finds it did not happen.
Filling a form or an offline example
is not the write. An unreadable step output never justifies a run either: the write
publishes with its output recorded as unavailable.

After a `not_published`, live `act` steps are open again while the write session is still
open (a commit that recorded its confirmation stays done), on the same browser, still signed
in: read `page.url()` first, and prefer not to sign in again. Only after a publication whose
capture failed do they run on a fresh browser on a new, empty profile: read `page.url()`
first and sign in again when the build signs in. Before
running a commit again, read back whether the earlier commit landed, as "Never repeat a step
blindly" says. Guardian reviews every
`act` step and denies one that would repeat a finished commit.

Guardian labels each step it allows `read`, `write` or `authentication`, and every step
that changes what the site keeps is a write, a draft, a saved field or a cart included.
A separate outcome reviewer then judges each write from your history and the host's
records. The host refuses a step that runs an earlier write's entrypoint again until
that review finds the write did not happen, so write a read-back as a new file. When a
tool result's `hostNotices` holds an `outcome_review_observation`, the reviewer needs
that readback: run it in a step that changes nothing when you can.

## What runs do with it

A run of the published write ends one of three ways. A recorded confirmation makes
it a result. A failure the host can prove sent nothing (its marks show no commit
step entered and the page sent only reads) may retry on a new browser, and a retry
that fails too goes to maintenance. On a host that repairs, a failure whose marks show no
commit step entered reports that it changed nothing, and its repair fixes the code and runs
the write once, without reading the site back. Anything
else, including a run that finished without its confirmation or lost its page
before reporting its marks, returns <!-- opengpt:section writes.uncertain-status:start
`may_have_applied`
opengpt:section writes.uncertain-status:end --> with any unconfirmed
result, and maintenance reads the site back and finishes the write at most once.
An `unverifiable` write reports <!-- opengpt:section writes.unverifiable-status:start
`may_have_applied`
opengpt:section writes.unverifiable-status:end --> too, and nothing repairs it.
A script that throws `errors.InvalidInput` (core skill) fails as the caller's input; with
`available`, the host ends the run at once with those choices. <!-- opengpt:section writes.declared-refusal:start
Before any commit
mark is entered, the run reports that it changed nothing, so throw a refusal before the
mark. A write may instead declare its refusals in its output schema: a branch that requires
`status` `"refused"` and a `reason` from a listed set of stable lowercase codes, such as
`over_price_limit`, beside the values the caller needs, such as the total and the limit, with
no other branch whose `status` could be `"refused"`. Prefer declaring each refusal as its own
branch of the output's top-level union, and prefer a listed `status` on every other branch, such
as `Schema.Literal("rated")`, so the host can tell a refusal from any other output. Returned
before the first commit mark, a declared refusal completes the run with that output and reports
the write not applied. A refusal returned in a shape the schema does not declare, or returned or
thrown after a mark, reports a possible change.
opengpt:section writes.declared-refusal:end -->

See `references/write-session.ts` for two steps and the composed script, and
`references/write-readback.ts` for a write confirmed from its own commit request.
<!-- opengpt:section writes.completion:start

## Standalone write completion

Perform the authorized task once through live `act` steps, preserving the shared effect journal and caller choices. Wait for actual confirmation, from the commit request's response or the page, and read back committed state only when neither confirms it. Declare `verified`, `unverifiable`, and their confirmation behavior accurately using the existing SDK; a missing result alone never proves the write absent.

Keep steps small and read the actual state after each submission. A button named Continue, Next or Save may save a draft, persist that page, or finish the task immediately; its label does not establish that another review or final submit follows. Place a commit mark only on the step that sends the change to the site, such as a submit, save or confirm control, or a control whose handler sends the caller's change to the site. Opening a form and typing into its fields change only the page's own state, so leave them unmarked unless the site's requests show they save the caller's change, such as an autosave; a lookup, suggestion, validation or analytics request saves nothing. Mark every such step, including autosaves, saved form steps and payment submissions whose next screen is unknown: call `enteringCommit("place-order")` right before the execute call that can send the change and declare the names in order as `write.commits`. Use the same marked helper in the session and the composed script. Finish every check that can refuse, such as a price limit, availability or the items, address and payment, before the mark of the commit it guards, and refuse there with `InvalidInput`; the marked call only re-reads what a change would make wrong, clicks once and confirms. If a call returns an unexpected page or fails while waiting for an assumed review, read back before another submission: the task may already be complete.

Compose `src/tool.mjs` from the original reviewed steps and confirming observation. Design no tests for it beyond an offline check of its read-back and comparison over what the session read, and never run the composed write live again. Call `finish_build` with its confirming `executionId`, declared entrypoint and honest coverage. It returns integration files/schemas. When a write's outcome remains uncertain, report that uncertainty and preserve the no-replay rule.

If the composed contract names the wrong commit marks, correct it to match the marks the session actually entered. If the completed session entered no marks, it cannot finish: changing its source or entering a mark in a later read cannot show that the earlier commit was marked. End the build and explain that the task completed but its commit steps were not marked; never repeat the write to add them.

opengpt:section writes.completion:end -->

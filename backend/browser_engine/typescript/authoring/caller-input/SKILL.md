---
name: caller-input
description: Validate the caller's input, refuse a bad value or fail on one the page did not apply with the right error, and ask the run's caller mid-run for what only they know, such as a choice only the page offers or a code the site sends.
---

# Caller input

## Validate it, and fail with the right error

A published tool is an API: every caller reads its input schema and acts on its errors. Refuse a
bad value before the tool touches the site, and fail loudly whenever the run cannot return what
the caller asked for. Never return results computed without a value the caller supplied, except
an input that tailors the answer, which a read returns labeled with the value the site applied.

Apply each caller input the way the site applies it, and only that. Don't add your own
constraints between inputs, filter them, or swap in a value the caller didn't give; a write
follows the site's preselected substitute only when the caller's own task asks for whatever the
site ends up with (writes skill). For example, a store and a delivery ZIP that the site sets
separately are both applied as given, even when they're far apart.

1. Express in the input schema everything it can hold, so the host refuses a bad value before
   the script runs: each field's type, an enum of the site's full set of options when the
   options are fixed, a minimum and maximum for numbers, counts and lengths, a format such as a
   date-only `CalendarDate` or a pattern for a code, and which fields are required.
2. Check every rule the schema cannot hold before any site action, and throw
   `new errors.InvalidInput(message, { field })` at once, starting "Caller input error:" and
   naming the field and the rule. Such rules include:
   - an end date on or after its start date, and a check-out after its check-in;
   - a date the task rules out, such as a departure before today in its airport's time zone.
     A date is past when it is before today in the site's time zone; UTC's date can be a day
     ahead or behind. On a site with places in several time zones, use the place's zone, such
     as a restaurant's or a departure airport's, when the tool knows it before any site action,
     and otherwise refuse only a date that is past in every time zone, such as one before
     yesterday in UTC;
   - a count below one, or above the site's own limits, such as a party size or quantity the
     site caps, found while building and stated in the message;
   - inputs that exclude each other, such as a store and a ZIP code where the site takes one;
   - at least one of a set the tool needs one of, such as a record's number or its name.

   When the refusal is obvious, start the message with "Caller input error:" so the caller gets
   it at once. It is obvious when the input alone breaks a rule of the task, as above, checked
   before any site action. It is also obvious when the page itself refuses the value in its own
   words, which the message quotes, or when the site's own lookup of a record's own key, such as
   an order, ticket or item number, or the site's own link to that record, shows the site's
   not-found or empty result. Never use that start for a breakage, which goes to repair: a URL
   the tool built itself, a page whose layout or controls the tool no longer finds, or a lookup,
   slider or list that hadn't loaded. Nor when a suggestion list or picker offered nothing, or a
   write finds a day disabled without the page saying why. Prefer not starting a refusal of an
   ambiguous value with it (below).
3. Throw the error that matches what happened:
   - `InvalidInput`: the caller's value is wrong or the site does not offer it. It breaks a rule
     above, or is not among the options the page lists, such as a store missing from its
     picker. Pass `field`, and `available`, every option the page offers
     as selectable, exactly as shown, whenever the page lists them. When the page refuses the
     value with an error of its own, prefer passing as `field` the input that error belongs to,
     matched by where the page puts it, such as the field or label it sits under, or the field
     whose `aria-describedby` points at it, even when its words don't name the field. An error
     that covers several inputs or none, such as a notice for the whole form, leaves `field`
     out. The caller corrects the input and runs again. A write follows the site's preselected
     substitute instead when the caller's own task asks for whatever the site ends up with
     (writes skill).
   - `InputNotApplied`: the value is valid and the site offers it, but the page did not apply
     it after the tool's bounded retries. It ignored, reset or replaced the value, such as a
     filter, sort or date (on a write, a location or store too), and the read-back shows its own
     default or another value (core skill, "Configure, then read"). Throw
     `new errors.InputNotApplied(message, { field, requested, applied, step, siteMessage })`:
     `field` the input's name, `requested` the caller's value, `applied` the value the page kept
     as read back (left out when it shows none), `step` the tool's step that failed, such as
     `set_location` or `apply_sort`, and `siteMessage` the page's own error when it showed one.
     The run then fails and returns nothing computed without the caller's value. A read, or a
     run that left the site untouched, may run again with the same request. On a write, check
     it before the first commit step: a write that may already have changed the site still ends
     as a possible change, never retried. Never let an answer to a question make a filter, sort,
     date or other value that narrows the results optional or lookup-only.
     `errors.LocationNotApplied` is an older name for the same error; write `InputNotApplied`.
     Not this error: a number on a stepped scale set to the nearest step inside the caller's
     bound and returned as applied, a filter group the page disables reported as not offered, a
     broader choice that covers the value, a search query the site corrected or rewrote,
     returned with `applied_query` and `query_corrected` (core and search skills), or a value a
     write typed that the site rewrote before any save, kept and reported as the writes skill
     says.
   - An input that tailors the answer, such as a location, store or vehicle, that the site still
     won't apply, or a location it says it does not serve, on a read: not an error (core skill,
     the input schema, "Inputs that tailor the answer").
   - An option the page lists but greys out, such as a booked date or a sold-out size: not an
     error on a read, `InvalidInput` with `available` on a write (core skill, "Configure, then
     read"); a write follows the site's preselected substitute only when the caller's own task
     asks for whatever the site ends up with (writes skill).
   - A read whose site says no to the whole request, such as a product it no longer sells,
     prefers returning that no as a declared refusal with `site_message` over throwing (writes
     skill).
   - A write that declines the task because the caller's own limit or the page's state rules it
     out, such as a total over the caller's price limit or a product number whose page names
     another item than the caller's: `InvalidInput`, thrown before the mark of the commit it
     guards (writes skill). Pass `field`, the input the caller would change, `kind`, the reason
     as a stable lowercase token such as `over_price_limit` or `item_mismatch`, and `available`
     where the page lists choices, and give in the message the values the caller needs, such as
     the total the page shows beside the limit. That is a refusal: the run reports why, and that
     it changed nothing unless an earlier marked step ran, and the caller can run again with
     corrected input. It differs from a failure, a tool that broke, and from a write that may
     have changed the site and could not confirm it (both below). A write returns a refusal as
     its output only when its output schema declares that refusal, and only where the writes
     skill says one completes the run, such as before its first mark: any other output a write
     returns without `verified()` reports a possible change.
   - When the site itself says no to a valid request, such as an item out of stock or a variant
     it does not offer, prefer the writes skill's refusal quoting the site.
   - A write whose steps may have changed the site and then failed or could not confirm the
     change: let it end as a possible change, which is never retried. Never throw
     `InvalidInput` or `InputNotApplied` to make it look untouched (writes skill).
   - A control the tool could not find, open or read, or a page that changed: `OperationFailure`,
     never `InvalidInput` or `InputNotApplied`.
   - Prefer a fast refusal for an item the site has no record of. A tool that takes an item's
     id, key or URL, such as a product, listing, stock or order number, treats the site's own
     not-found or no-results page for that value as `InvalidInput`, with `field` that input and
     the site's words quoted in the message, before any commit mark. It never throws another
     error for that page and never waits out a timeout for controls the page won't show. This
     holds for signed-in tools and writes too.

   Never pick another value for the caller, such as a near match, the page's default or the
   first option, except a value that matches several site entries equally, where the tool may
   take the first and return the one it used (core skill), or the stem match a read of a
   category or term takes with
   `stem: true`, returning the option it used (forms skill), and never report a refused or
   unapplied value in the output instead of throwing, such as a `sort_applied: false` flag or a
   "best-effort" or "lookup-only" description. The cases above that return results with what
   applied, and a declared refusal, are the only exceptions.

## Ask the caller during a run

Try first. Ask only for what the page or the caller uniquely knows at that point:

- a choice whose options exist only once the run reaches them: the open seats of the
  flight the caller just chose, the delivery slots for the cart the run just filled, or
  which of the account's saved travelers, addresses or payment methods to use;
- whether to take a paid add-on within the tool's purpose that the page shows on the way to a
  commit when the input leaves it open, asked before the commit mark; a paid upsell outside the
  tool's purpose is declined, never asked (writes skill);
- which of several site entries the caller's value matches equally, such as a restaurant with
  several locations or a city with several airports, with those entries as the options, each
  selecting exactly one, when the tool asks instead of taking the first in the site's order;
  each tool decides which (core skill). That is ambiguous, as is a near-miss name the site
  offers alternatives for: prefer not starting a refusal of either with "Caller input error:"
  (above). A day or option the page greys out, with or without a reason, is not ambiguous and
  never a question (core skill, "Configure, then read");
- a code the site sends to confirm a protected action after sign-in, such as a confirmation code
  by text or email, never a code that is part of signing in (auth skill);
- a fact only the caller has that the site now asks for.

Never ask for a value the request, the input or an earlier answer already supplied, a private
one included: use that value. Never undo an answer that declined something by doing it anyway
or by offering it as an input (core skill), except a costly choice a write still meets on its
path, which stays an input or a declared question (writes skill). In the tool, take it from its input, or a private one, such as
part of an identity number, through a declared `secret` question, never a plain-text field.
When question review finds a question redundant, remove the ask and use the supplied value; a
reworded question still asks for it again. A placeholder that stands in for a redacted value,
such as "[redacted value]", supplies nothing. A supplied value the site rejects, or two that
conflict, can still need a question, one that names the actual problem.

Work the request already covers proceeds without a question, such as finding the right field
or choosing among alternatives the request already allows. A supplied value the site does not
offer, whether the page does not list it or greys it out, is not such a question either, and
never one to ask about: it follows .agents/core/SKILL.md ("Configure, then read"), which never
substitutes another value; a write follows the site's preselected substitute only when the
caller's own task asks for whatever the site ends up with (writes skill). Asking the
owner to revise it or stop is the minter's own `request_input` question while it builds, as
`AGENTS.md` says.

Use a published input instead whenever the value is stable and the caller can supply it
up front, such as a flight number, a date or a quantity. Never ask for a password, a
username or any other login: the host asks for a login itself and signs in. Never ask
for something the page shows, for permission to proceed with the operation the caller
already asked for, or to solve a CAPTCHA.

## Declare, read, ask

1. Declare every question the run may ask in the contract,
   `defineOperation({ name, input, output, questions }, ...)`, by id, with its `type`
   and a short `prompt`. The publication review reads these declarations once, so the
   prompt names the choice or value, never a private value. Write `questions` as a plain
   literal inside the entrypoint's own `defineOperation` call: during the build the host
   reads it from that source, not from the running script, and a computed or imported
   declaration declares nothing, so every question is refused as `Undeclared`. Each question
   the example asks is also reviewed before the build's owner sees it. An id starts with a
   lowercase letter and holds only lowercase letters, digits and underscores, up to 64
   characters (`page_title`, not `pageTitle`); the host refuses an invalid id before the
   script runs, and each `ask` uses the declared id exactly.
   - `{ type: "choice", prompt, allowOther? }`: one option; `allowOther` lets the caller
     type their own answer, returned as `{ other }` (a build's `request_input` always
     allows it, `AGENTS.md`). Own text that repeats exactly one
     offered option's label (or its listed form entry, `id (label)`) returns that option.
   - `{ type: "multi_choice", prompt, minSelections?, maxSelections? }`: several options,
     at least one unless `minSelections` says otherwise, at most the options offered.
   - `{ type: "text", prompt, maxLength? }`: free text.
   - `{ type: "confirm", prompt, followUp? }`: yes or no, returned as `{ confirmed }`.
   - `{ type: "secret", secretKind, prompt, maxLength? }`: a code the site sent to
     confirm an action after sign-in (`one_time_code`; a code that is part of signing
     in is a `code` field of the `authenticate` step, never a question), an
     authenticator code (`totp`, which a saved login's TOTP fills without asking) or
     other private text (`private_text`). It stays out of traces,
     logs and the minting model. A secret you ask during the build with `request_input`
     comes back to you as a handle such as `{{secret.s1}}`, which the host fills in only
     when your explore, test or `act` source runs live, and only where it is the whole
     string passed to `fill`, `type` or `pressSequentially` or a field of a request to this
     site (core skill); the published script never holds a handle and asks for the value
     with `ask` instead. Prefer a `secret` question of kind `private_text` for an access
     code, such as a gate, door, alarm or lockbox code.
   - For a payment card the checkout requires, ask for every part its card form shows
     at once, in one request with one `secret` question for each part: `card_number`,
     `card_expiry`, `card_cvc` and `billing_postal_code`. Those handles go only into a
     card-fill step, never into source.
   - A published script asks for a card the same way: declare a `secret` question with
     a card `secretKind` for each part and ask them all in one `ask`, which returns a
     card handle for each, such as `{{card.c1}}`, never the card. Pass the handles to
     the context's `fillCard`, as in
     `await fillCard({ fields: [{ selector: "#cardNumber", handle: answer.card }] })`,
     with each field's own selector, even inside the payment processor's frame. The
     host types the card and clicks nothing, so submit the payment in a later call
     under the write's commit rules. Once you have the caller's card, and wherever source
     calls `fillCard`, no source reads a field's value or the page's markup, runs or
     plants code in the page, opens a DevTools session, takes an accessibility snapshot,
     screenshot or PDF of the page, records the page, or reads a request body, so delete
     such probes before you ask for the card.
2. For a choice, read the options in the execute call that reaches it and return them as
   plain JSON. Each option has a `value` the script acts on and a `label` the caller
   reads. Values are unique within a question. Offer only options the page will accept:
   skip taken seats, disabled slots and sold-out items. The value never leaves the run;
   the caller sees only the label.
3. Mark an option taken from the caller's own account (a saved traveler, address, card
   or account) with `accountSpecific: true` and a `maskedLabel` that keeps it
   recognizable without its numbers or email, such as `"Jane D. •••• 7890"`. The API
   and MCP show the masked label with a notice; only the owner's protected page shows
   the full label. A masked label that still shows five or more digits or an email
   address is replaced by the label's last four digits or a numbered placeholder.
4. Ask once for everything the step needs, between two execute calls:
   - `await ask("code")` returns that question's answer;
   - `await ask(["seat", "note"])` returns one answer per id;
   - `await ask({ seat: { options: seats }, code: {} })` passes a choice's options, and
     nothing for the other types.

   With an array or an object, `ask` returns one answer per question id, so read
   `answer.<id>`, as in `answer.seat`.
   For one question, `askOne("seat", { options })` returns that answer directly.
   One ask takes up to eight questions, with up to 50 options per choice. A choice
   returns the chosen `value`, a multi-choice an array of values. Write answers into
   the next call's code with `JSON.stringify`.

The run waits with its browser open and its active budget stopped, and the next call
starts on the same page. Continue from there. Do not reload, search again or repeat an
earlier step, and never resubmit anything the run already submitted. A second click on a
marked step is not a resubmission when `blockingRequiredFields` returned the fields you
asked for and you called `notCommitted` for that step before asking: fill the answers, check
the step again, then call `enteringCommit` again for that step, and click once, as the writes
skill says. The wait can be long, so in that next call confirm the page still shows the chosen
option before acting on it.

## When no answer comes

`ask` throws `ScriptInputFailure`:

- `NoResponse`: the caller did not answer within the request's window (at most ten
  minutes, less when the job's window ends sooner). The run fails as `no_response`. It
  is never retried or repaired, and its result says whether a step before the question
  may already have changed the site.
- `Unavailable`: the host could not put the question to the caller, or the answer did
  not fit the question.
- `Unauthorized`: the caller's access to the job was revoked while the run waited.
- `Undeclared` or `InvalidOptions`: the ask names an id that `questions` does not
  declare, gives a choice no options or duplicate values, gives options to another type,
  or offers fewer options than the selection bounds need.

Let these failures end the run. Never catch one to pick a default, the first option or
a guessed value. For a write, ask every question you can before its first commit step,
reading options in a step that saves nothing, so an unanswered question leaves the site
unchanged rather than holding a partial save. A question whose options the site shows only past
a saved step, such as delivery slots for a cart that step filled, may come after it. A hold or a cart the run made
before the question is reported as a possible change when no answer comes.

## During a mint

A read build's example run, or a write build's `act` step, asks the build's owner
through the same request, and the answer comes back to the running script. Ask the owner each
decision once per build: one a declared question will ask during the run needs no
`request_input` of your own first. The host reuses an earlier answer to a choice,
multi_choice, text or confirm question, never a secret, code or login, for a later ask with the
same id, type, prompt and options, so keep a declared question unchanged between runs unless its
review asks for a rewording. Guardian
reviews each question first. When it asks for a rewording, nobody is asked, the `ask`
fails and the execution's result carries `scriptQuestion` with Guardian's rationale:
change the declared question as it says and execute again. If the owner does not answer
in time, the result carries `scriptQuestion` `unanswered` and the build goes on: decide
how to continue without the answer, as when your own `request_input` returns
`no_answer`. A write step that sent something before its question is reported as a
possible change; verify the site's current state before any further write. In a write
repair, or once the build is signed in or holds a login, an unanswered question still
ends the build as `no_response`. Do not turn an
account-specific choice into a published input to work around a question; a value the
caller can type, such as a member number, is a free-form input instead.

`references/caller-choice.ts` books a seat on the caller's chosen flight: it asks for a
seat and a saved traveler once the flight's seat map is shown, then books once and calls
`verified()` after reading the confirmation back.
`references/caller-code.ts` asks for the code the site sends to confirm an address
change and enters it on the same page.
<!-- opengpt:section caller-input.protected-answers:start

## Standalone protected answers

Declare questions in the operation contract using the existing SDK schema and ask through `ask`. Ordinary answers are caller input, not extra authority. A `secret` answer is delivered privately for its declared purpose; during minting it returns an opaque handle. Use that handle only as a whole value at an authorized destination, never transformed, logged, returned, stored or read back. Website login credentials are requested only by the host during `authenticate`; TOTP/one-time codes are caller-supplied, with no stored seed automation.

opengpt:section caller-input.protected-answers:end -->

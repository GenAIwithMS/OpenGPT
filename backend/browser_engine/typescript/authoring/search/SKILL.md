---
name: search
description: Read before settling a search or listing tool's inputs: the site's own filters, sort and location, applied and read back, and honest empty results.
---

# Build a search from the site's own controls

A search or listing tool returns what the site shows for the caller's query and filters. Every
input changes what the site does on that run, and every value it returns comes from that run's
results. "The tool throws" below means the published tool's code throws at run time, so that run
fails or reports a bad input; it never means ending the build.

## Find the filters

Before you settle the input schema, open the results for a typical query and read every control
that narrows, orders or configures them: the filter panel, chips, the sort menu, range sliders
and boxes, toggles, and every group that is collapsed, scrolled out of view or behind an "All
filters", "More" or "Show all" button (core skill, the input schema). Make every
control that narrows, orders or configures the results an optional input wired to its control,
such as cabin class (economy or first) on a flight search, even one the request never names and
whether or not you ask about it, since callers of the tool can set it; ask about one only as
`AGENTS.md` ("Try hard, then ask") allows, and left unset it keeps the page's default. Leave out
only controls unrelated to the purpose, which change neither which results come back nor their
order, such as a layout or language switch. A safety default (core skill, "Safety defaults") is not
an input either, and the tool turns it off. Nor is a filter, sort or location the request, the caller or
the owner declined: it is never an input for any caller (core skill). This survey is build
work. The published tool does not repeat it: on each run it opens only the groups the caller's
inputs use (see "Apply and read back").

- Take each input's choices from the site. When it offers the same choices for every query, the
  enum lists all of them as the page shows them. When they depend on the query, such as sizes or
  brands, take a string and match it against the choices this search's page shows.
- Filters and sort are choices: set them as "Configure, then read" in the core skill says, and
  read the results last. When the page's list of choices does not hold a caller's value but a
  broader choice such as "Show all" covers it, choose the broader choice and return the rows the
  site gives, saying so in the description. Otherwise the tool throws `InvalidInput` with
  `field` and `available`, the choices the group it opened for that value offers on this
  search's page, only after reading them. A control the site has but the tool could not find,
  open or operate makes it throw `OperationFailure`.
- A price or other numeric range is a number, never a label to match: a slider's labels and
  steps often change with the result set. Set the nearest step inside the caller's bound (down
  for a maximum, up for a minimum), the range's end for a value outside it, read the applied
  bound back and return it beside the results (core skill, "Configure, then read").
- A filter group the page disables for this result set, such as a price filter when only one
  result shows, is part of the answer: check that a group is enabled before opening it, never
  wait on a disabled one, and return the results with that filter reported as not offered.
- Never set a filter or sort in code, even one the request names: each is an input, and a
  declined one (above) is neither set nor an input. When the site offers a sort, it is an
  optional input listing every order the site offers. A page size visitors cannot change is the
  site's; state it in the description.

## Apply and read back

On every run, set each input the site has a control for through that control, or through the URL
or data request the site itself uses for it when the control is unreliable (testing skill), never
by filtering the returned rows, then read it back from the site's committed state: the
applied-filter chips, the selected sort, an option the site shows selected, or the results header.
A URL naming the input does not show it applied. When a filter did not apply, the tool throws
`InputNotApplied` naming it (caller-input skill), so the run fails; it never returns
unfiltered results as filtered.<!-- opengpt:section search.http-read-back -->

When setting one control reloads the result list, order matters: set that control, commonly a
location or store, before the filters and sorts its reload would drop. Open only the groups the
caller's inputs use. For a control inside a drawer or collapsed group, open the group first and
wait for its panel to show and any loading overlay to clear; click the visible label or option,
never a hidden input; when choosing reloads or navigates the results, wait for that reload to
finish: the row identifiers or the results header changed and then settled (`waitForChange` on
them), never every card's value holding still, since values that load lazily may never settle.
Then read the choice back where the page shows it: an applied chip, the selected sort, the results
header, or the reopened panel when nothing else shows it. A follow-up choice that will reload the
results anyway can wait for that reload instead. Close a drawer or panel you opened with its own
close control or Escape, and check it closed. After the last step that changed the results, wait
for that change with `waitForChange`, then read the rows you return with `waitForRows`, which
passes at once on a settled page (core skill). Skip another `waitForChange` or settle when no step
changed the results since the last one.

## Location

When the results, prices or availability depend on a location or store, offer it as an optional
input, a ZIP or postal code or a store as the site takes them, even when the request names
neither: it tailors the answer. Apply it, read it back and always return it, as `applied_store`
or `applied_zip`, the site's default included when the caller gave none, as the core skill's
input schema says ("Inputs that tailor the answer"). When the caller gives a location but no
store, use what the site would show for that location, such as the nearest store, rather than
what the site guessed from the browser's own location, and return what was applied.

## Results

Wait for the search's answer with `waitForOutcome` (core skill). Prefer naming its error, its
no-results message and its results over waiting for the results alone, and name results by the
page's most stable sign, such as the result count or heading for the query, over one layout's
classes. Read every field of every result you return from that result's own record on every
run: the page's own structured data for it when that holds the same fields, otherwise its card
(core skill).
Lean toward more information (core skill, output fields): return the facts each card shows
without a click that a caller
could reasonably use to choose among results, with full displayed values, and a maker or provider
line in its own field. Return only the site's results for these inputs, with
related or recommended items, the filters the site offers and each card's whole text only as
`include` sections (core skill, optional sections). When only some cards show a fact, its field
is nullable and null exactly on the cards that don't. A list of records whose fields are
user-defined, such as a CRM's or a table app's, follows the records skill for its output
instead: a small default keyed by field name, with every other field through its inputs. Read
the results once the rows you return
have their key fields, filled in and holding still (`waitForRows`). When the site marks results
as suggestions rather than matches, such as "no exact matches, showing similar items", return
that. Keep the matches apart from related items, recommendations and sponsored carousels, and
mark a card that stands for a group of variants, such as "6 flavors" or "3 colors", as the core
skill's "Results, related records and groups" says. Check that the
page's echo of the query, such as a results heading, matches it as the core skill's Confirm step
compares, except a query the site says it corrected or
rewrote (below). A search
that applied every input and got the site's no-results message returns an empty list, never an
error. The site's own error page or error banner, or an error status or error body from the data
request the page depends on, is a failure: throw `OperationFailure` naming what the site showed,
never an empty list or a success built from it. When the page answers such a reply with its
no-results message, as some store finders do for a 404, or with a refusal of the caller's value
(caller-input skill), that answer stands.

Retail and grocery grids often interleave sponsored copies of their organic results and put
promoted carousels above or inside the grid (core skill, "Results, related records and
groups"). Return each item once, keyed by its own ID (pagination skill). Before the first example, list the grid's item
IDs for a typical query, and check that no ID repeats and that the first rows match the query.
Read the query the site applied from the page's embedded state, such as its search data, rather
than from a selector scoped to one container, which another layout of the results page breaks.
When the site corrected or rewrote the caller's query, such as fixing its spelling, its echo
shows the query it searched: return the site's results and say so, never silently, with that
query as `applied_query` and a `query_corrected` boolean. The same holds for the query an HTTP
version's answer echoes.

## Answer quickly

A search should answer in seconds. Every click and wait runs on every call, so a run does only
what its inputs need.

Try the fast path first. While exploring, check whether the page's own data request or embedded
data carries the result fields. When it does, the default design is: reach the results through
the page's controls, then read that data in the same session, reading the applied location back
from the page or that answer. Read rendered rows only when it doesn't. For a data request, prefer
catching the page's own answer in the same call as the step that sends it
(`Promise.all([page.waitForResponse(...), button.click()])`, core skill). Fetching it in the page
(`page.evaluate(() => fetch(...))`) is fine to speed things up or when that answer can't be
caught, once the page itself has reached the results, not as the only step.

- The main path visits only the controls an input sets: a filter, sort, quick switch or other
  optional control the caller left unset is never opened, clicked or waited on, so a run with
  every optional input unset touches none of them. Read its applied state from the page's data
  or results where they show it; otherwise return it null with the reason in the description. A
  search never opens a control to read it. Always return
  `applied_filters`: the groups the tool set, as the page reads them back.
- Return the site's offered filter groups, in a field such as `available_filters`, only with
  `include: ["filters"]` (core skill, optional sections). When the page already shows the groups without a click,
  the tool may return those, and says they are the visible ones.
- Skip a step whose result the page already shows, such as a location, store or sort that is
  already the caller's, and the change wait that would follow it (core skill).
- Fetch a per-result extra the cards lack, such as availability, in one batched request when the
  site offers one, never one request per result.
- Reach the results by the route the build proved (`AGENTS.md`, "Work through the page's own
  controls"), falling back to the search box once. `references/navigation.ts` shows both.
- How many results one call returns, and the way to the next page, follow the pagination skill.

## Pages

A search returns one page of results per call and a cursor to the next: read the pagination
skill before you settle the schema. The window is the first `limit` results in the site's
order, sponsored ones in place.

## Describe and test it

The description briefly states the design decisions, limits and interpretations a caller needs,
such as the site's default location, how many results one call returns and how the site pages. A
search sets every input you expose in at least one live run before publishing, as the testing
skill says, most of them together in one combined case, and also runs the path with every
optional input unset, which its example often already is; a signed-in one runs that combined case
and at most one more. A search signed out's cases also include one query the site answers with a
fallback or "no exact matches" view, whose expectation you write only after seeing what the site
shows for it. Give each input an
`examples` value the site offers for a typical query.

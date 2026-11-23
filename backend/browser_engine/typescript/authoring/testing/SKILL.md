---
name: testing
description: Design and run a few combined live test cases for a read. A read signed out runs a handful; a signed-in read runs four inputs at most. A write skips this skill and proves its tool with one run.
---

# Test a read with a few combined cases

This skill is for reads. A write does the original task: it proves its tool with its act session
(writes skill), designs no tests, runs no live test and builds no offline test suite<!-- opengpt:section testing.write-http-check -->. It still checks its
composed script's read-back and comparison offline over what the session read (writes skill).
As the one exception, a write whose build runs in test mode, because its caller confirmed the
site account is a test account, prefers one no-match case in `test/cases.json` when it takes an
item's id, key or URL: a made-up value in the site's own format that the site has no record of,
expecting `invalid_input`, with `purpose` naming the capture of the site's not-found page. A host
that runs it does so on the composed script with every commit mark settled, so it stops before
any save; other hosts ignore it. A
read proves its operation with its example, run again after each fix as the core skill says, then tests what the example did not
exercise with a few live cases, each designed to cover as much as it can. A read signed out runs a
handful (below). A signed-in read runs at most four distinct inputs beyond its example
(Signed-in reads, below). Report what
no run exercised as untested in `coverage`. The scope follows what the tool is now: a read that
becomes a write mid-build, a repair included, stops testing from then on; a read that signs in
mid-build keeps to the signed-in bound from then on, and only cases run signed in count for it;
and a repair that rebuilds a signed-in tool or a write as a read signed out tests it as one.

Use execute with purpose=test, target, relative entrypoint/test file, fixtureRefs,
caseFilter, maxWorkers and timeoutSeconds. Fixtures are host-authorized immutable
inputs. Offline cases may use isolated workers; a live test is one read-only flow. It starts
like the example, from a reset page (`AGENTS.md`, "Reads, writes and examples").
A read proves its operation with purpose=example and iterates from that start; running the
example or a live test again after a fix is normal, but keep rounds few: fix everything a run
shows before you run again (Run and fix the cases, below).

## The combined case

Optional inputs the example left unset are where tools ship broken: a filter the site ignores, a
value read from the wrong field, an input the code drops. One well-designed case finds all three.
Design it as soon as you know the page and its inputs, and run it once the example passes:

- Set every optional input and filter the example left unset, together, in one case. Take each
  value from what the site shows: an option in the page's own picker or filter panel, or a value
  in the example's own output rows. Choose each value so it excludes something: at least one row
  the example returned, or the site shows unfiltered, fails it, while some rows still pass every
  filter. A status that only some of those rows have, a date range that leaves out one row's
  date, a price ceiling below one row's price and above another's, a category the page lists
  beside others. A value every example row already satisfies proves nothing: a tool that ignores
  that filter passes anyway. Never a person's, account's or record's name, number, code or
  email, which Guardian refuses as a private identifier: list such a filter under `notTested`
  unless the caller's own input supplied its value.
- Expect `result`, and say in `purpose`, for each input, the row field that shows it applied and
  an example row it excludes. After it runs, read its full output (`live_tests` action `plan`,
  naming the case) and check that every returned row satisfies every input it set, such as each
  row's status the one asked for, each date inside the range and each price under the ceiling;
  that the rows it excludes are absent, so the rows differ from the example's; and that the tool
  read each input back as the site applied it. A row that breaks a filter, or a result no
  different from the example's, is a bug in the tool: fix the code, never the case.
- When the tool returns a list and the example did not run page two, set `next_page: true` on
  this case, so it runs page two through the cursor page one returned, under the same filters.
  Check that page two holds rows page one did not and that they still satisfy every filter. The
  host fails a page two whose rows were all on page one already.
- Add a second case only for inputs that cannot be satisfied together: options of one control
  that exclude each other, filters that together leave no rows, or an input that opens a page
  with a different structure (other fields or sections). Never one case per input.
- List anything the combined cases did not set under `notTested`, with why, and in `coverage`.

## Signed-in reads

Where the host runs no signed-in live tests, `live_tests` answers `unavailable` and the example
alone proves a signed-in read's tool. Otherwise a signed-in read runs at most four distinct
inputs in a build or repair, beyond its example, each chosen for high value and broad coverage:
its combined case first, the second case above where it needs one, and one no-match case,
preferably a made-up key for an input that takes a record's own id, key or URL, else a query or
filter the site has no results for, as a read signed out runs it (below). The host enforces
it: a batch or `testInput` that would add a fifth input is refused as `limit` and runs nothing.
Running an input that already ran again, after a fix or on `src/tool-http.mjs`, is free, so
merge inputs into those cases rather than adding a case. The host runs them on the build's
own signed-in browser, one at a time and warm, never on a new browser. Each case stays a read
under the signed-in session rules that already apply to the example: it saves no record, view or
setting, and a filter the site saves with a view or setting goes through the page's own row query
or is restored in the same step, as the workspace guide says. Design no example run cold, no
second no-results case and no edge cases.<!-- opengpt:section testing.signed-in-http --> Publication review reads
the host's record of the cases you ran signed in, judges a failing case as a bug, and treats
what you did not test as disclosure, not a gap. Then go on at "Run and fix the cases", below.

## A read signed out: a handful of cases

Where the host offers `live_tests`, the host runs a read signed out's cases for you in
parallel. Testing is your job, not the caller's: never wait to be told to try another record, retailer or value.

Design the tests yourself. You saw the site: its controls, the values it offers and the ways its
pages differ. Choose the cases that would show the tool works for callers other than this one,
not mechanical variations of the example's input, and make each case cover as much as it can.
Start as soon as you know the page and its inputs, and refine the cases once the example passes;
run no batch before then. Aim for a handful of cases, not dozens:
- the combined case above, with page two in it, and its second case where needed;
- the example's own input once more, which a host with several browsers runs cold, first on a
  new browser with an empty profile: the proof that the tool works for a caller the site
  remembers nothing about, with no location, store or filter left from your exploration;
- one query or filter with no results (`empty`, never a throw). Run it once and see what the
  site shows before you write its expectation: some sites answer it with a fallback grid or a
  "no exact matches" view rather than an empty list. When the tool takes a free-text input, one
  the caller types rather than picks, use a made-up value the site has no match for here, so
  this case also shows that value ends as the caller-input skill says: `empty` for a search
  query, `invalid_input` naming the field, or a labeled `result` for a location the site won't
  apply, never another throw. Skip it for an input that takes a person's or account's name,
  number or code. For one that takes a record's own key, such as an order or ticket number, use
  one made-up key in the site's own format, with a serial past any the site lists, and expect
  `invalid_input`. For a read with no results list whose answer is a count or total, the
  no-results case expects `result`, sets `noMatch: true` and returns the count or total as 0:
  prefer an input the site matches nothing for, and name in its `purpose` the capture where the
  site applied that input and showed zero. Without a no-results answer, move on: it needs no
  `notTested` entry and no question;
- for a free-text input, one case with a value the example used written another way, such as in
  other case or with other spacing, punctuation or accents;
- another case only where a different page structure or a real variant needs one, and each such
  case sets as many inputs as still return rows: another retailer, store or seller; another
  category; a record whose page is laid out differently (a single option, grouped options, a
  multi-item page, sold out); for other reads, another route, date range or region, or a
  document or order page of another kind; a location or other tailoring input the site won't
  apply (`result`, with the applied value beside the requested one and the site's message, never
  presented as the requested one's results); an option the page lists but greys out, such as a
  sold-out size, which a read returns as unavailable data. Find them on the site, in a listing
  or picker you opened; never invent them. Prefer trying other records as one batch of live
  cases rather than one probe at a time, so they're reviewed together.

A blank or over-long value of a free-text input needs no live case: the input schema refuses it
before the site is touched, so bound every free-text input there, non-empty and with a
`maxLength` no longer than the site's own field takes (core skill), and
publication reads that schema. So does a value
outside an enum input. A free-text value the tool matches against the site's own list, such as
a store name, that the site does not list at all (`invalid_input`, with the page's choices
listed) can be the made-up value of the no-results case. An input is covered by a
case that uses it, or changes it from its default: its other values, such as each order a sort
offers, need no case or `notTested` entry of their own unless one opens a page with a different
structure (other fields or sections), never one that only reorders or filters the same rows.
Whatever you saw this site could break on while exploring, such as a panel that loads late, a
pop-up, a layout that changes with the number of results or a value written differently on
another page, belongs in the cases above rather than in cases of its own.

Write them in `test/cases.json`:

```json
{
  "cases": [
    { "id": "every-filter", "purpose": "Sort, the in-stock switch and the Lamps category the example left unset, from the filter drawer's options: every row is in stock and in Lamps, prices ascend, and page two continues under the same filters.", "input": { "query": "desk lamp", "sort": "price_low", "in_stock": true, "category": "Lamps" }, "expect": "result", "next_page": true },
    { "id": "example-again", "purpose": "The example's input on a new browser, cold.", "input": { "query": "desk lamp" }, "expect": "result" },
    { "id": "second-store", "purpose": "Another store from the store picker; its results page has no pickup column.", "input": { "query": "desk lamp", "store": "Mill Street", "in_stock": true }, "expect": "result" },
    { "id": "nothing", "purpose": "A made-up query no product matches returns an empty list.", "input": { "query": "qzvx lamp" }, "expect": "empty" }
  ],
  "notTested": [
    { "what": "A location the site cannot apply", "reason": "The site ships one catalog everywhere and has no location control." }
  ]
}
```

`purpose` says in a sentence what the case establishes. `expect` is `result`, `empty`,
`invalid_input` or `error`: a loud refusal the tool throws on purpose, `InputNotApplied`; any
other throw is a bug and fails the case. Expect `empty`, `invalid_input` or `error` only for an
input the site really has no results for, does not offer or cannot apply; a value the input schema
refuses, such as a blank or over-long one, needs no case, since the schema bound is its test. An
input that tailors the answer and that the site won't apply expects `result`, labeled with the
applied value. Apart from a made-up value in the no-results
case, use real values the site offers, which you saw while
exploring: listed options, places, dates, counts, records and retailers the site lists. Never use
a person's, account's or record's name, number or code, and never the caller's own values beyond
the example's input. List under `notTested` anything the tool claims that you chose not to test,
with why. A choice the request, the caller or the owner declined is not part of the tool (core
skill), so it is never tested.

## Run and fix the cases

Run them with `live_tests` action `run` (`cases` null runs them all). One
Guardian review covers the batch; each case starts like the example, on a page reset to the
site origin that keeps its browser's site data, in parallel browsers where the host has them
(a signed-in read's on its own browser).
Each result says whether the case ran `cold`, first on a new browser with an empty profile, or
`warm`, on a browser that kept what earlier steps left. A case that passes warm and fails cold
relies on something the site remembered: set that value from the input. You get every result: its status, what it returned, and a failure's
error with the source line that threw. Name cases in action `plan` to read their full outputs,
and check what they mean, not just pass or fail: every item matches the filters, the order follows
the sort, the applied location is the one asked for or labeled as another, page 2 differs from
page 1. A failing case is a bug in the tool: fix the code at that line. Never drop the input,
narrow the schema except where the site itself bounds the value, or change a case's expectation
to match what it returned to make it pass; fix the code. The one exception is a case that
expected an answer the site itself does not give for that input. Confirm the site's own answer in
a capture of the site's own controls or a URL they produce, never a challenge, sign-in, blocked or
loading page: for `empty`, a page that reads back the input as the site applied it and shows the
site's no-results state; for `result`, such a page listing the site's own results for it, such as
near matches for a query nothing matches exactly; for `invalid_input` or `error`, the site's own
form refusing that input, with its own validation message or, where the captures hold the site's
responses, a 400, 413, 414 or 422 response to the request its form sent. A refusal of the request
your tool made proves nothing, since that request can be wrong, and neither does a 401, 403, 404,
405, 429 or 5xx. Then change the expectation to what the site shows, and name that capture in the
case's `purpose` and in `coverage`; review accepts the change only against it. Name a capture by
its exact path, a snapshot listed in `captures/index.json` or
`captures/results/<executionId>.json`, not by an execution ID alone: a later look can drop an
earlier snapshot from the index, while its file stays readable by path. Prefer the snapshot that
shows the site's own controls applying the input. Where the site
itself bounds a value, such as its own field's maximum length, put that bound in the input schema
rather than a case. Before you run again,
fix everything the batch revealed: read every failure and every output, and batch as many fixes
as you can into one edit rather than one fix per run. Then rerun the failing cases and every case
the fixes can touch, all of them together in one batch named in `cases`, in the same round on
each version you ship whose source the fixes changed; a version you stopped fixing and will not
ship needs none. Each batch waits on its slowest case and its own review, so aim for few
rounds; the cases that passed run again once after your last edit. A
run that returns partly filled results, or passes only when run again, is missing a wait for
content: fix the wait, not the retry, then run that input again a few times.

A filter or sort case that fails because the results lost the choice is often order or waiting,
not the control. When setting one control reloads the list, such as a location or store, set it
before the filters and sorts its reload would drop, and after each reload wait for it to finish,
the row identifiers or the results header changed and then settled, never for every card's value
to hold (search skill).

A case that keeps failing at the same control after two fixes is usually a custom widget, not a
missing wait: a styled checkbox or option whose click does not change its state, a drawer that
hydrates late, or a list that reloads and drops the choice. Stop reworking the click. Look at
what the site did when that control did apply, in a probe or the captures where the host keeps
them. When the results URL then carries the choice, apply it through that URL (`AGENTS.md`,
"Work through the page's own controls").<!-- opengpt:section testing.data-request-filter --> Either way, read the input back
from the site's committed state or the answer.

After the example passes, read its returned fields once at the answer and again about 10 s later
on the same page; a field that changed is filled late, so wait for it in source or describe it as
live, such as a countdown. A run that sits idle after its answer showed, or opens controls its
input did not use, works for more than it returns: trim it. Where a run's result reports timing
for each step, read it, and prefer to remove waits and round trips the answer does not need, such as a
wait on a page no step changed or a probe repeated on every poll, never one the answer needs.
A slow tool still publishes. Read every string in each result.
After each run with output the host reports output checks: values that hold code, styles, markup
or template leftovers, text read collapsed or cut short, a whole card's text, repeated entries or
records, and fields that never vary or are always empty. Check each against the page: fix a wrong
value at the read in source, never by cleaning the string afterwards; a correct value needs no
change (publication skill). Set each `include` value the tool offers in the combined case or
another live run. A tool that returns a list runs page two live with the cursor page one
returned (pagination skill).

Results count only for the version, the source and the case as they ran: an edit makes them stale.
After an edit, rerun only the cases it can affect, never the whole suite after each small change.
Finish in this order: make your last edit, run every case once more (`cases` null) on each
version you ship, run the example last, then call `finish_build`. Publication review reads the
host's record of your cases (`publication/tests.json`), not your account of them, and judges
them against what the tool claims: a failing case, or, for a read signed out, a claim no passing
case tests while time remained, holds publication back.
Publication review starts only when at least 70% of the cases you ran on the code you publish pass. Inconclusive results count neither way.
Deleting or changing a case after it failed does not hide the
failure: the record keeps its last result as retired, and so does a failure that passes when run again on the same code, as
flaky. A rerun on the same code that ends inconclusive, such as a challenge, leaves the failure as
the case's result. A retired failure stops counting only on what the host can check: a case that passes the
same input after you change the code, with a result the old case's own expectation accepts
(`excusedBy`; an `InvalidInput` refusal satisfies `error`), or an input schema bound on a value
the input supplied (`outsideSchema`), which publication checks against the site's own field; a
field the schema newly requires never counts. A case that now expects another answer for that
input (`changedExpectationBy`) clears it only with a capture of the site's own answer for that
exact input, as above, named in its `purpose`. Relabelling a case, or rebuilding it under new ids,
clears nothing and adds another retired failure each time. The record's `clearedBy` says what can
clear each failure that still counts. When `live_tests` answers `no_time`, run the example last and publish; the record says time
ran out. If publication review then denies for a failure only a new batch could clear, and no batch is left, prefer
`report_blocked` with reason `host_refused`, naming the refused live tests and the finding.

When the host offers no `live_tests`, a read runs its cases one input at a time instead: execute
purpose `test`, target `liveBrowser`, with `testInput`, the tool's input as JSON text; the host
may limit how many. A signed-in read's inputs there count toward the same four.<!-- opengpt:section testing.http-cases -->

The example uses the caller's input, or your `exampleInput` when that input is empty, and offline
tests always use the caller's input. If a test shows the schema must widen, widen it in source;
publication reads the schemas from current source, and only a changed flow needs a fresh example
(publication skill).<!-- opengpt:section testing.offline-fixtures -->

- pureFiles: parsers/calculation with ordinary files and meaningful assertions.<!-- opengpt:section testing.saved-targets -->
- liveBrowser: authorized fresh observation for real-site behavior. Optional read
  smoke checks do not grant purchases, cart additions, uploads, holds or autosave.

Choose cases that catch actual risk: applied filters, IDs, units, authoritative empty
versus absent/loading data, partial coverage, schema failures, variants and changed
terms. Avoid assertions that merely
copy implementation expressions.
Report actual passed/failed/skipped/unsupported counts and missing evidence; an
all-skipped suite proves nothing. Never fabricate absent response bodies or assets.

The platform supplies compilation and runners. If a requested runner/fixture mode
is unavailable, report unsupported and preserve the exact gap. Do not install an
alternate network-enabled runner or silently call production from an offline test.

<!-- opengpt:section testing.capture-evidence --><!-- opengpt:section testing.later-cases -->

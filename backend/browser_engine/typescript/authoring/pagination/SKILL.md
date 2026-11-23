---
name: pagination
description: Read before settling the schema of any tool that returns a list: page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop.
---

# Return a page and a way to the next

Any tool that returns a list the site can run past one page, such as search results, orders,
statements, messages or reviews, returns one page per call and a cursor for the next. A caller
that wants more calls again with the same inputs and that cursor. No browser stays open between
calls: each call is a fresh run that rebuilds its position from the cursor alone, signed in or
not.

## The contract

Spread `listInputFields` into the input schema's fields and `listOutputFields` into the output
schema's: `limit` (1 to 50, default 20) and `cursor`; `next_cursor`, `next_cursor_expires_at`,
`has_more`, `total_results`, `list_changed` and, when a list with more has no cursor,
`next_cursor_unavailable`. Never rename them or write your own. Return rows
in the site's order, each item once. A row's key is the item's own stable ID, such as a product
number, SKU or listing ID, never its link text or position. When the site lists the same item
twice, such as a sponsored copy of an organic result, return the organic row at its organic
position and drop the copy. A promoted row whose item the page lists only as promoted stays in
place, counts toward `limit` and carries `sponsored: true`; drop it only when the request asks
for organic results only, and say so in the description. `total_results` is the site's own exact count, null when it shows none or an
approximate one. The description says: "Returns up to `limit` results per call (default 20).
When `next_cursor` is not null, call again within ten minutes with the same inputs and `cursor`
set to it for the results that follow. When `list_changed` is true, results may repeat earlier
ones: de-duplicate by key," and names how the site pages and its page size.

## The cursor

The host signs every cursor and checks it before the next run starts: a cursor that is altered,
expired (ten minutes after the call that returned it), from another tool, for other inputs or for
another account never reaches your code. Call `startList(input, { mechanism })` before any
browser work; it gives you `limit` and the position the host checked, and refuses a cursor from
before the tool paged another way. Then let `readList` read the page and write the output fields.
Never write, sign or parse a cursor yourself, and never put page text, a secret or an account's
value into a position; row keys are hashed for you. A cursor's position is readable by whoever
holds it, so it holds only the site's own link, token or scope and the numbers to reach the rows.

## Read the page with the pager

`readList(list, reader)` does the paging across calls, and the runtime's pager does the site
actions: paste `paginationCode` after `waitCode`, and pass `readList` a
`pagedListReader({ mechanism, execute, setup, start, row, keyOf, remainingMs })`. `setup` declares
`const pager = listPager({ rows, key, fields, empty })`: the locator for every row, the row's key
and values as `waitForRows` takes them, and the site's own empty message. `start` opens the list as
the first call always does, such as running the search. `readList` returns `{ rows, output }`:
return `rows` as the list and spread `output` into the result. `references/pager.ts` is the
pattern.

The pager finds the list's page numbers, its Next (one control even when the site repeats it above
and below the list), a "Load more" control or a scroll, and steps it. It judges each step by what
changed: the rows' keys, new rows or the empty message, never a sleep. It reads the rows with
`waitForRows`, and takes the site's total from its summary only when the page agrees with it. A
later call starts the list again, then opens the site's own link to the cursor's page and checks
that it shows that page (pass `sameList` to check the query too), else goes there by the page
numbers, or replays the steps. Never edit a page number or offset into a URL yourself.

While building, return `await pager.detect()` after `start` to see the mechanism and controls it
finds, and name that mechanism in `startList` and `pagedListReader`, which hands it to the pager,
so a short list that shows no control still pages that way. Name a control in `listPager`
(`next`, `loadMore`, `summary`, `controls`, `current`, `end` and the rest) only when the pager
picks the wrong one, and replace one judgement with a hook (`step`, `hasNext`, `pageNumber`,
`readTotal`, `echo`) only on a site it misreads. A pager failure names its reason:
`pager_ambiguous` when two Next controls lead to different pages (name the list's own),
`pager_stalled` when a step changed nothing twice while the page shows more rows,
`pager_no_control`, `pager_step_timeout` or `pager_page_unreachable`. Within one call, `pager.find(match)` walks to the page that holds a wanted
record and `pager.collect({ limit, until })` gathers rows each once, for a tool that needs one
record or a bounded set rather than a page per call.

Name `api` when the page fetches rows from its own list endpoint with an offset, page or cursor
parameter, and write the reader's three functions yourself, as for a list the pager cannot step:
`open(position, count)` reaches where the call starts, `more(segment, count)` reads more of the
open segment without acting, and `next(segment, count)` moves to the next segment, each returning
`{ rows, more, hasNext }` plus `href`, `token`, `scope`, `totalResults` or `context` when the site
gives them. For `api`, `open` opens the results page, then calls the endpoint inside the page with
the position's `token`, or, for a position with only a `page`, fetches the responses up to that
page; keep the visible mechanism as the fallback when the endpoint refuses or changes.
`references/pagination.ts` writes these functions by hand.

`readList` asks for exactly the rows the window needs, so the call's `limit` and the site's page
size need not match. With `limit` 20 and 30 rows per site page, call one returns site page one's
rows 1 to 20; call two returns rows 21 to 30, then site page two's rows 1 to 10, exactly 20; call
three returns site page two's rows 11 to 30. A last page shorter than the window ends the list with
`next_cursor` null. Pass `remainingMs` so a call returns what it read before the run's time runs
out.

A "Load more" control that hides or disables while a step loads is not the end of the list, and a
list that stalls while its control is still offered has more: the pager and `readList` keep
`has_more` true with a position that continues. Never step a control whose click could submit or
change anything.

## Rows that need a detail page

When each row's fields come from the row's own detail page, prefer reading the list with
`readList` over the rows the list itself shows, keyed as usual, and opening the detail page only
for each row `readList` returns. Avoid opening detail pages inside `open`, `more` or `next`:
`readList` asks them for every row from the start of the segment up to the cursor's position, so a
later page would open every earlier row's detail page again.

## Changed lists

Lists change between calls. `readList` reads from the segment that holds the last row the
previous call returned, continues after that row wherever it now is, and drops the last 16 rows
returned, which the cursor remembers. Rows inserted above it push the window down: `readList`
reads more of the segment or up to two segments on. Rows removed above it can pull it back into
the previous segment: `readList` reads that segment by its page number when that fits within the
call's reads, counting one read per page, since `open` reaches a page by its number by following
Next from the first page. When neither shows that row or any remembered row, it starts over from
the list's first segment in the same call, repeating rows rather than skipping any. So `open`
must reach a position that has only a `page`, as the pager's reader does. `list_changed` is
true when anything changed at or above that row: it moved from where the cursor saw it, because
rows were inserted above it (rows the caller never gets) or rows it already got were removed; it
is gone; or a remembered row came back. After a start over, or a page continued from a segment's
first row with no remembered row in sight, later pages can repeat rows returned before the
remembered ones, so `list_changed` stays true on that page and every later page from its cursor:
a caller that needs no repeats de-duplicates by key once `list_changed` is true, as the
description says. On a site with very few rows per page and constant new rows on top, a list can
start over again and again. Rows that change below the last returned row are simply returned.
When the site applied a context the caller did not set, such as a location it picked, return it
as the segment's `context`, so a different one sets `list_changed`. Never promise a snapshot the
site does not keep.

No case needs to show a changed list: a build can't make the site's list change, and the publication review counts list_changed and the other paging fields core adds as core's, so prefer leaving it out of `notTested` and asking no question about it.

## Stop

`readList` returns as soon as it holds `limit` rows. Per call it reads at most 5 site pages or
API responses, or 10 steps, within `remainingMs()`; when a bound stops it, it returns what it
read with a position that continues; a call the run's time stopped before it read past its
position hands back that same position, which a call with more time continues, and a second such
call in a row ends the list with `no_progress`. A later call whose site shows no results and a
total of 0 after earlier calls returned rows is never the list's end either: `readList` hands back
that same position once, with a `reason` that says the search likely did not load; prefer returning
that `reason` as the result's own, and calling a list complete only when `has_more` is false.
`next_cursor` is null, with `has_more` true and
`next_cursor_unavailable` saying why, past the deepest position a tool can rebuild without the
site's link or token (10 site pages or 20 steps, `depth_cap`), when the site's link or token is
too long for a cursor (`position_too_long`), or when a later call returned no rows and its next
position is the one it started from, such as a list that still stalls where the previous call
stopped (`no_progress`), so a caller paging until `has_more` is false still ends. The description
names that depth. When the site refuses its own link or token and the position cannot be
rebuilt, throw `errors.InvalidInput` with `field: "cursor"` and `kind: "site_expired"`. Never
return a position the tool could not follow.

## Signed-in lists

The same rules apply under the account the host bound to this run. Every call signs in through
the host before your code runs, page two and later too, so `open` reaches the position on a
signed-in page; after it loads a page, call `ensureSignedIn()`, and open the page again when the
host signed in again. A cursor never carries a credential or session data: the saved profile
restores the sign-in, not a page, a server's cursor, drafts or form state, and a site link that
carries a session, a key or a signature, such as `;jsessionid=`, a `sid`, `api_key` or `token`
parameter or a signed URL, is left out of the cursor, so the next call reaches that page by its
number. A link whose path names the account, such as its ID, is an account's value too: give such
segments no `href`, so the position keeps only the page number, and reach the list from the
site's own navigation. Keep a list's scope, such as a year or tab, in the
segment's `scope` as the site's own value. Never recreate a hold, draft, upload, payment token or
write in order to page.

## A list that fits on one page

Every list tool takes the contract. When the site shows the whole list at once, use `offset`:
`limit` still caps each call, the position's `offset` continues it, and the description says the
site shows the whole list.

## Test it

On a read signed out, run page one, then page two live with the cursor page one returned: page
two continues the order and repeats no row. Where the site's page size is known, try a `limit`
that ends inside a site page and check that page two finishes that page and continues on the
next. Reach a last page where a case you already run ends on one, such as the combined case's
narrow filters, and check that `next_cursor` is null (testing skill). A signed-in read runs page
two within its combined case when its example did not, and reports what it did not reach as
untested. `references/pager.ts` is a compiling pattern on the pager; `references/pagination.ts`
writes the reader by hand for a Next link and a "Show more" list (`readRooms`). Their selectors
are site logic.
<!-- opengpt:section pagination.cursor-scope:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

opengpt:section pagination.cursor-scope:end -->

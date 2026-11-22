---
name: auth
description: Discover an evidenced login entry and sign in screen by screen with verified host autofill.
---

# Sign in on this site

On this site the host signs in inside the browser you are already using. You find each sign-in
screen's fields and its submit control, and the host fills them from the private login and clicks
the submit. You never see, type, request or read back a credential. Start with a `signInStep` for
the first screen. If a step fails, inspect the site and correct the steps in this browser.

A code the site sends as part of signing in, by text message, email or an authenticator app, is
part of the sign-in: map its screen as a `signInStep` with a `code` field and let `authenticate`
get the code, which the host fills or asks the caller for. Never ask for it separately with
`request_input`. A `request_input` secret question for a code is only for a later protected action
after sign-in, when the site asks for another code to confirm it; `authenticate` is never started
just for such a code.

On a one-time-code screen, prefer one read that finds the code fields, the submit and any
remember-this-device box with its checked state. Then send the code step at once. Codes expire in
minutes, so send that step before any other probing.

Sign in only when the task needs it, as `AGENTS.md` says; try a public task signed out first.
Signing in opens the task's own pages only: never browse orders, rewards, messages, saved payment
or settings the task does not concern.

# The login URL you record

The `loginUrl` you pass on `authenticate` is published with the tool, and every run opens it to
sign in. Follow the site's own sign-in link: record its exact `href`, read before you click it,
never a trimmed, rebuilt or guessed copy. When that link works only with one-time values in it,
record the page that shows the link as `loginUrl` and the link's click as a fieldless
`signInStep`. Never record:

- a URL carrying one-time values: `state`, `nonce`, `code_challenge`, `code`, `session_state`,
  `SAMLRequest`, or a signed token or opaque random value in its query or fragment;
- an identity provider's authorize endpoint (`/authorize`, `/oauth2/…/authorize`,
  `/as/authorization.oauth2`, `/protocol/openid-connect/auth`), even on the site's own domain.

Such a URL was made for one sign-in; a run that replays it starts from spent values.

A login link often redirects through an identity provider and lands on an authorize URL with
one-time parameters: record the link you clicked, not the page you landed on.

On a site that signs each account in to its own workspace host (sign in at `app.example.com`,
work at `acme.example.com`), record `loginUrl` on the shared sign-in host. Never type or hard-code
a workspace or tenant host or slug in a page address, selector or source: the host records a
workspace screen itself, and each run's sign-in goes to that account's own workspace. Its
`loginUrl` carries no return address: no other URL, host or path to go to after sign-in in its
query, fragment or path, since a host refuses such a link for a workspace site.

# Discover the entry before authenticating

1. Submit a bounded, anonymous, read-only `explore` with target `liveBrowser` on the authorized site
   (any https host on its registrable domain). Before sign-in this probe gets no private value.
2. Follow the site's actual unique member-login entry from its links, buttons and frames. Do not
   guess `/login`, hardcode a remembered SSO domain, or click `.first()` of a broad match such as
   `/sign in|log in/i`. Use a visible, container-scoped role locator, confirm it is unique, and tell
   member login from provider or employer login, registration and password reset by evidence.
   Read the chosen link's `href` before the click: it is usually the login route to record.
3. Check that the page is on the site before one click that only opens the login page. A sign-in on
   the site's own registrable domain, such as login.example.com for www.example.com, is the
   site's own and needs no permission; only an origin on a different site needs host
   configuration, which the host checks during `authenticate`.
4. Read the first sign-in screen, the first step whose form signs in with a username, email,
   phone-number, account-number, password, code, date-of-birth, ZIP or recovery-code field,
   including an identifier-only first step. Its fields for the first `signInStep` come from a
   read-only probe of that screen: wait for its controls, then return each visible field's label,
   type, placeholder, id and name, never its value, and the visible buttons, frames, the URL and
   the form actions. Never type, fill or select into its fields, press keys in them, or click its
   submit, Next, Continue or send-code control during exploration: that is signing in, which only
   `authenticate` does (the one exception, after the host's own submit click failed, is below).
   Other controls on the page, such as a site search or a cookie banner, are not the sign-in.
   Whenever a cookie or tracking consent banner shows on a sign-in screen, dismiss it as the core
   skill says, and name the same control as that screen's `dismiss` in every `signInStep` for it: the
   host clicks it before it types when it shows, and runs do the same on a fresh browser, where it
   shows again. Never name a submit or a field as `dismiss`, and prefer not to name a link to
   another page. The banner's own control counts even when it sits in the sign-in form or has no
   type, as on a page wrapped in one form: it sends nothing typed, since the host empties the
   step's fields and cancels that click's own submission.
   Reopening the login route in an `explore` to read it again is fine, after a failed sign-in too.
   `references/auth-entry.ts` shows a bounded second probe that reads a login form's controls.

When the entry offers mutually exclusive account or plan types, decide before clicking one: take
the branch only when the request or input names or clearly implies it, otherwise ask with
`request_input` right away. A preselected option says nothing about the caller.

Pick a sign-in method in this order: the one the request or caller names, the password, then a
code or approval; when several channels remain and nothing names one, ask the caller which, and
never prefer one yourself. Never list or pick a passkey, security key or biometric option, even
when the caller asks: the host cannot use one. When a passkey is the only way in, end with
`report_blocked` `site_lacks_capability`.

# One screen at a time

Before recording, reopen the published `loginUrl` and map the complete signed-out flow. Reopen that
route and record the required entry navigation from there, not just the username form reached
after manual choices. Record each observed panel opener, authorized account/plan choice or
Continue control as `signInStep: { fields: [], submit: "the-observed-selector" }`. Include only
navigation needed for sign-in; exploration before the login URL and Business account actions,
registration and password reset do not belong in the recipe.

A sign-in by phone number may lead, right after its code, to a create-account screen asking at
most a name and a terms box, because that phone has no account on the site. Prefer asking the
owner once with `request_input` whether to create it, naming the site and saying the phone has no
account, and ask for the name in the same request when the screen asks one. With a yes, fill only
that screen in an `explore`, with the name from the answer and any terms box it requires, submit it
once and keep it out of the recipe; then send the signed-in check, or sign in again by the
recorded steps when the site leaves you signed out. With a no, end with `report_blocked` reason
`owner_declined`. Only builds and repairs do this: a run whose phone has no account fails its
sign-in.

Record a field only after observing its unique visible enabled match in the intended frame and
form, and a submit after observing its unique visible match there, even one the page enables only
once the fields hold input. The host validates the live login; a signed-out replay is verified
only by a later registered run. A signed-in example starts on the browser's signed-in session,
so it proves the business flow after authentication, not that the recorded sign-in works
from the published `loginUrl`. Report sign-in replay as unverified unless a separate registered
run actually starts signed out at that URL and completes the recorded steps; never clear a live
session or repeat a write merely to test it. A saved DOM supports
locator matching and extraction; it cannot prove live controls are actionable, their event
handlers work or authentication succeeds.

A run can begin partway through that flow because its bound profile or remembered device omitted
an earlier stage. The host acts only on the observed recorded screen. It skips an earlier stage
only when a later recorded page or distinct credential fields prove progression, or the published
signed-in check verifies the session. A missing control, a timeout or a coincident Continue button
on the same page does not prove an account choice happened. Record an authorized choice and its
following Continue as separate steps. Prefer exercising a chooser step from both starts in the
build, right after a sign-in and from a saved session already past the chooser.

Call `execute` with purpose `authenticate`, target `liveBrowser` and a `signInStep` for the screen in
front of you. Pass the site's own sign-in link as you clicked it (above) as `loginUrl` on the first
one, never the page it redirected to; runs open that link to replay your screens.

Security questions can change between screens and visits. Inspect the current question and its
answer control each time, then record the observed field through the same `signInStep` mechanism.
Never assume a fixed challenge stage or put question text or an answer into a recipe.

Use `slot: "private_answer"` for each observed security-question answer field. When the actual
question has one visible match in that field's frame, supply its stable `questionSelector`, never
its text. The host rereads the question before privately filling the answer. No answer reaches
you, Guardian, generated code or the recipe. One-time and recovery codes keep their own slots.

Every selector a `signInStep` sends, in `fields`, `submit`, `methods`, `questionSelector`,
`dismiss`, `rejectedMarkers`, `matchSelector` and `signedIn`, is a Playwright selector string, not a locator call as probes and
the examples write. Prefer a stable `#id`, `[name=...]` or `data-testid=` selector. A role selector
writes its options as attributes:

- `role=button[name="Sign in"]` and `role=button[name="Sign in" s]` match that whole name, case
  included: the string form of `getByRole("button", { name: "Sign in", exact: true })`.
- `role=button[name="sign in" i]` matches the whole name ignoring case.
- `role=button[name=/sign in/i]` matches a pattern.

`exact` is an option of `getByRole` and `getByLabel`, never a selector attribute: `[exact]` or
`[exact=true]` fails as an unknown attribute, and `[name="Sign in" exact]` fails to parse.
`getByLabel` and `getByText` have no string form the host runs, since their `internal:` forms are
refused: name such a field by its role and name, its `id`, its `name` or another stable
attribute.

- `fields`: each field the screen asks for, as a Playwright selector with exactly one visible match.
  A selector never reaches into another frame (no `>>` chains or `internal:` engines): the host finds
  each field in its own frame.
  - An identifier field lists every kind it accepts in `accepts`, from `username`, `email`,
    `phone` and `account_number`: a "username or email" field is `["username", "email"]`, an
    email-only field `["email"]`, a mobile-number field `["phone"]`, an account, member or customer
    number field or a company or organization ID field `["account_number"]`. Read the label, type
    and placeholder. The host sends a kind the login holds (username first, then email, phone and
    account number) or asks the caller once for one it accepts. If it refuses the step as
    `identifier_conflict`, the answer was not this login's: send the step again to ask again.
  - `slot: "password"` for the password.
  - `slot: "code"` for a one-time or authenticator code. A saved authenticator seed answers it;
    otherwise the host asks the caller for the code. Never ask for a code yourself. A code split
    into one-character boxes is one `code` field per box, every box from the first to the last, in
    order, as a split date is one field per part (below), even when the page moves the focus to
    the next box or takes a pasted code in the first. Count the boxes on the screen before you
    send the step. A step field never carries `codeBox` or any box number: the host reads each
    box's place from the page, so send only `selector` and `slot` for each box. The host asks
    once, types one character into each and submits only once each box holds one. A step that
    names only some of the boxes, or names them out of order, comes back refused as
    `code_boxes_incomplete`, typing nothing: its `codeBoxes` says how many boxes the screen shows
    and which ones the step named; send the step again with all of them. When a code screen asks
    the person to do something, such as call a number or approve in an app, prefer naming the
    element with that instruction as the code field's `questionSelector`.
  - `slot: "date_of_birth"` for a date of birth, with `format`, how the field takes it, read from
    its placeholder, label, input mask or hint: `MM/DD/YYYY`, `DD/MM/YYYY`, `M/D/YYYY`,
    `D/M/YYYY`, `MM-DD-YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`, `YYYY/MM/DD`, `MMDDYYYY`,
    `DDMMYYYY` or `YYYYMMDD`. A native date input (`type="date"`) is `YYYY-MM-DD`. A date split into
    a month, a day and a year is one field per part, each with its part's format: `MM` or `M` for a
    month by number, `MMM` or `MMMM` for a month by its short or full name, `DD` or `D` for the day,
    `YYYY` or `YY` for the year. A part may be a text box, a select or a custom dropdown: name the
    select, or the dropdown's own control (its combobox or the button that opens its list), never
    an option. The host fills the saved date into whatever control it finds, choosing the option
    whose label or value matches, and records the format and the control's shape with the tool,
    never the date. Every date layout, dropdowns included, is a screen you map.
  - `slot: "zip"` for a ZIP or postal code the site checks to prove the account.
  - `slot: "recovery_code"` for a backup or recovery code field. The host fills a saved one only
    while recovery codes are the method in force, else asks the caller. Never ask for one yourself.
  - `slot: "private_answer"` for a security question's answer field, with `questionSelector` when
    the question has one visible match in that field's frame. The host fills the saved login's
    answer to the question the page shows, else asks the caller with that question. Never ask for
    an answer yourself.
- `submit`: the observed control that submits those fields or advances this sign-in screen
  ("Next", "Continue", "Sign in"), even one the page enables only once the fields hold input. It
  may be a native button, a submit/button/image input, an HTML anchor or a custom ARIA action: use
  its evidenced role, label or stable selector and purpose. The host clicks it, waiting a few
  seconds for the page to enable it, and never clicks it while it is disabled. A screen that advances by itself (the identifier fills and the password field
  appears by itself) names none; unrelated links or buttons on that page do not need a submit.
  A two-factor method choice ("Text me a code", "Use my authenticator app") fills no field: list
  every method the screen offers in `methods` (`sms`, `call`, `email`, `totp`, `push` or
  `recovery_code` for "use a backup code", each with
  the selector of the control that picks it) and name the one to pick now as `submit`, by the
  method order above. The tool's runs pick again from that list. A method's selector
  publishes with the tool, so it never names the masked phone number or address the option shows
  (such as `***-1234`): use the method's own words or a stable attribute.
- `submitKey: "Enter"`, in place of `submit`: a code or password screen whose form has no submit
  control and submits on Enter. The host presses Enter in the step's last field.
- Every selector and submit you send publishes with the tool, as does each screen's page address.
  None may name this account's username, email or phone: not a "Continue as …" button's text, a
  data attribute holding it, or a placeholder for it. Name a control by its role, label or a stable
  attribute. The host refuses a step that names it (`selector_names_contact`), and a screen whose
  address names it (`page_names_contact`) is refused; use an account-independent route.

A screen may record `rejectedMarkers`, each with a field slot and an observed, value-free
rejection selector. The slots are `username`, `email`, `phone`, `account_number`, `password`,
`code`, `date_of_birth`, `zip` and `recovery_code`. Record every rejection visible during ordinary
sign-in; never invent a marker or submit bad credentials to discover one. The host reads only
visibility and retains every rejected value so it cannot send that value again.
`private_answer` has no recorded rejection marker or automatic correction: when the site rejects
an answer, inspect the question screen and stop rather than resending the same answer. A host
refusal with cause `question_changed` is not the site's rejection: nothing was typed, so read the
screen again and send its step, and the owner is asked the question it shows now.
A `typing_refused` host refusal names why the host's insertion failed in its cause. Only
`insertion_rejected` means the field kept the focus but the text did not land. Under every other
cause nothing was inserted: the focus left the field, the field or page was replaced, or the host
could not find the one field it focused. Follow the notice's next step for that cause.
Do not mark sign-in complete while a recorded answer or verification field is still visible,
including one inside a provider frame. Account search, support and security-settings forms are
not sign-in evidence. Inspect and record each new authentication screen before checking completion.
The host checks the challenge fields recorded since the last check that showed the site signed in.
One counts only while the same control shows and takes typing, on the site or a configured sign-in
origin: the label, accessible name and placeholder it had when you recorded it name it again, with
the same name and id where it had them. Another control your selector also matches, such as a
gift-card or promo code box, does not count. It does not classify unrecorded forms by their names or
page route. A successful host check does not replace inspecting the current screen and verifying
authenticated access.

On a combined password-and-code screen that returns empty, an explicit code rejection permits a
fresh code with the unchanged password only while its two-send allowance remains. When the
password remains in its field, retry only the fresh code. In a recorded replay, missing or
ambiguous evidence about which field was rejected requests maintenance without resending the
password. Report a rejection visible in the current mint even if no selector has been recorded
yet; a visible recorded marker takes precedence over that report.

Guardian checks each step against the screen: that every field takes the kinds it lists, that the
submit is the right sign-in action, including a fieldless continuation or verification-method
choice, and that a step without one advances by itself. The host checks that each control is unique
and visible and that its frame, form actions and link destination are on the site or a configured
sign-in origin. A sign-in form whose own action is a script that does nothing (`javascript:`,
`javascript:void(0)`, `javascript:;`) is the page's own submit, so the host judges it by where its
fields sit. A step that types nothing before anything was typed, such as a sign-in provider
chooser whose link or button runs the page's own script, is judged by where its control sits
whatever the script runs; the next screen is judged again before anything is typed there. A
refused step typed and sent nothing and spends no sign-in: fix it from the evidence.

Sign-in pages are often slow, and the next screen can take a while to show. Wait for its field with
a bounded readiness wait (such as `locator.waitFor` with a timeout of about 30 seconds) before you
map or fill it, and read the page again.<!-- opengpt:section auth.slow-screens -->

After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json`
(`nextScreen`), where the host saved the next screen's controls: role, name or label, input type,
and whether each is required, visible and enabled, never a value. Read it with `read_source` first
to see what the screen asks for. A step that did not resolve shows the last saved controls inline
(`lastScreen`), at most 30, and the file holds the rest.
Then read what the file lacks, such as a selector or form destination, with a read-only `explore`. Never read, change or return a field
the host filled, not even to check it. If the host reports that its click of the submit failed after
the fields filled, you may click that one submit yourself in an `explore`, and nothing else; the host
counts a value as sent only once it sees the form go out carrying it, whoever clicked. If it reports `submit: refused`, never click it.
If it reports `submit: blocked`, another element, such as a cookie banner (`blockedBy`), caught the
click and nothing was sent: never click the submit yourself. Send the same `signInStep` again with
the banner's own control, chosen as the core skill says, as `dismiss`; the host clicks it, then the
submit, and types nothing again unless the dismiss emptied a field.
If the site says a field was wrong, send `signInStep: { rejected: { slot: "password" } }`
with the actual rejected slot at once. The host asks for corrections; never ask for substitute
credentials yourself or send a rejected value again. A primary identifier or password rejection
asks for both username and password. A rejected secondary identifier, date of birth or ZIP asks
only for that field; a recovery code uses the host's fresh-code ledger or question. The host allows
at most two correction questions per rejected field per sign-in. Only submitted, visibly rejected
fields consume their counters; `username` and the saved login's matching primary identifier share one
counter. Worker takeover preserves these counters and rejected-value history.

If, once the login was sent, the site says the account itself is locked, suspended, disabled or
closed, no field is wrong and no correction helps: send
`signInStep: { rejected: { account: "locked", selector: "<the visible message>" } }`, or
`account: "suspended"` for a suspended, disabled or closed account, naming the visible element
whose text says so; the host checks it shows. The build then ends as `account_locked`; never send
`rejected.slot` for it, retry the sign-in or ask for another login.

When the owner declines a login request (`login_declined`, or `login_request` with `declined`), they
have no account or want only what the site shows signed out. Never ask for a login or
authenticate again in that build. Build the part of the request the site shows signed out; when
that part is missing or much less than asked, ask with `request_input` before you build, naming
what the site shows without signing in, whether to continue with it or stop. When they stop, or
nothing useful is public, end with `report_blocked` reason `owner_declined`.

When a sign-in failed and nothing in your authority resolves it, or the owner chose the public
part, and the request can still be met, at least in part, signed out: where the host offers
`abandon_sign_in`, call it, or record the owner's confirmed choice with `mint_update` change
`login` `signed_out`. Either way the build goes on signed out, and you never authenticate again.
The host refuses `abandon_sign_in` for a write build, a task that needs the account, or a sign-in
that already verified.

A rejected code permits at most two fresh-code corrections within the remaining sign-in time.
This does not extend the unchanged password's limit of two sends, including sends before worker
takeover. If a further known code correction would need a third unchanged-password send, the host
ends with `credentials_rejected` for `code`. Only an actually fresh accepted password begins a new
password-send allowance within this sign-in; correcting the primary identifier while retaining
the password does not. Correction counters and rejected-value history persist.

A fill is not a write: when the next screen shows a step did not go through (the same screen with
no rejection message, or a page error), send that `signInStep` again after inspecting why it failed.
The host counts a send once its click ran, its answer was lost or a form carried the value, and
refuses a third unchanged-password send.

Flows vary. A login may be passwordless (identifier, then a code or a link), ask for a code after the
password, offer several code methods, or ask you to approve on another device. Record every screen
the sign-in shows, a code screen included. The tool's runs replay the screens you recorded and go
on when one does not show. Of the screens you did not record, they look only for a one-time code
screen, so a run that meets any other screen you did not record requests sign-in repair.
Some sites answer the password with a screen that asks for it again together with a one-time
code, the password field empty beside the code field: map that screen as one `signInStep` with
both fields. The host fills the password there once more, records that the screen asks for it
again, and each run enters it with the code on that screen alone. A screen that asks for the
password again without a code is no such screen: treat it as a possible rejection.
When an observed screen asks the caller to follow an email link or approve on another device,
submit `signInStep: { approval: "email_link" }` or `{ approval: "device" }`, with the same popup
relation if that screen is in the popup. When an approval screen shows a number the owner must
pick on their device, name the element that shows it as `matchSelector`; the host shows that
number in the owner's confirmation. The host asks the caller through a protected confirmation
after the identifier was submitted. Never ask an ordinary question for this approval or request
the link, code or device contents. After confirmation, explore the account page and submit its
signed-in indicator; confirmation alone does not verify the session.

Never accept optional setup the site offers during or right after sign-in, such as creating a
passkey, adding a phone number or turning on two-factor. Record its decline control ("Not now",
"Skip") as its own `signInStep` with no fields and that control as `submit`, before the signed-in
check, so runs pass it too; a run where it does not show skips it once the check verifies the
session.

# Signed in

Prefer an observed protected business/account page or authenticated workflow control that the
signed-out flow cannot reach, corroborated by the live business example. Generic Sign out or
account chrome alone does not establish access to the caller's workflow. The signed-in marker you
send is a separate check, of presence only (`auth.sign-in-check`): for it, a site-wide account menu
or sign-out control is the right choice once `check_signed_in_marker` shows the signed-out page
lacks it. <!-- opengpt:section auth.signed-in-page:start
Call `authenticate` with `signInStep: { signedIn: { selector } }`. When the landing page
shows no such marker, add `openPath`, the observed path of an account page that does, and the host
opens it and checks there; never guess a protected route.
opengpt:section auth.signed-in-page:end --> The host checks that the submitted
sign-in's recorded controls/form no longer show a password entry awaiting sign-in; unrelated
password controls on the account page do not fail this check. It also checks that this sign-in
submitted the login's identifier with its password, code or protected approval, then marks it
verified; a Personal login locks to this site then. The marker is part of the published tool.
Business work waits for a verified sign-in.

# Popup sign-in

When the site's entry opens a separate authentication popup, map its controls without reading
values. Name `popup: { opener: "primary", origin: "https://the-observed-origin" }` on each step
in that popup. The host verifies the actual opener relation and exactly one matching popup;
zero or multiple matches type nothing. Record the origin from the observed popup, including its
port when present, never a browser target ID or tab index. An opener button that opens the popup
is its own step with no fields and its observed `submit`.

Keep the site's original page as the primary page. After the popup closes, inspect the opener
and submit its own signed-in indicator. Popup closure alone proves nothing. If a popup is missing
or ambiguous, inspect the tabs and correct the flow before sending another step.

# When a step cannot sign in

Inspect the current page read-only, wait for the observed screen, and correct the step from its
controls and submit destination. Browser recovery may help when the evidence points at the
browser. A failed host check leaves this browser available for another evidenced step; report
that sign-in could not be verified when the site or the remaining allowance prevents recovery.
Never send a visibly rejected value again. There is no provider-login fallback.

When the host refuses to type into a field (`AutofillRefused`), its answer names the field, the
check that refused it and why. Fix that cause before sending the step again: the same refusal of
the same field on the same screen three times in a row ends sign-in in this build.

<!-- opengpt:section auth.after-recovery -->

# Every sign-in ends with its check

Every sign-in you record ends with a deterministic sign-in check, sent as `signInStep.signedIn`: a
marker every signed-in account shows and a signed-out page never does. Never put an account's
name, email or number in it: the check publishes with the tool and runs for every login, and the
host refuses one that names this account.

The host checks the marker in many places across the site, not only where this sign-in lands:
after every reset, at the start of every operation, after a page load in the middle of a run, and
on whatever page a failure lands on. Choose a site-wide element only a signed-in user sees, such as
the global header's account menu or sign-out control, never something only the page after sign-in
shows.

- Prefer stable attributes and names (`aria-label`, a role, visible text, a test id) over
  generated class names such as `css-1q2w3e`.
- Send the marker as a selector string, as every sign-in step's selector is (above), such as
  `role=link[name="Sign out"]`, never with `exact`. The signed-out check reads CSS (with
  `:has-text()`, `:text-is()` and `:visible`), `text=`, `data-testid=` and `role=` with `name`,
  and `level` for a heading; it cannot read other attributes. A selector that crosses frames
  (`>>`, `internal:`) is refused.
- Never send a `urlPath` alone on a single-page app, or for a page the site also serves signed
  out; never the login page's path.
- Test it with `check_signed_in_marker` and choose another until every check passes:
  <!-- opengpt:section auth.marker-checks:start
`signedOutSnapshot` absent (the host saved the page it saw before the sign-in sent anything, and
  your explores from before signing in count too), `signedInNow`, `freshLoad` (the host opens
  `openPath`, else `urlPath`, else the site's front page in a new tab) and `secondPage`. Your own
  tab stays as it was.
opengpt:section auth.marker-checks:end --> When it reports the signed-out page unchecked, as for a browser that
  started from a saved profile, compare the marker yourself against what a signed-out visitor
  sees.
- The host repeats these checks when you send `signedIn`. It refuses a marker a signed-out page
  shows (`marker_matches_signed_out_page`) or a sign-in page's path alone
  (`marker_is_login_path`); the sign-in stays open and nothing is sent again, so send `signedIn`
  with another marker. The marker must show on the signed-in page now. A fresh load never refuses
  it: the result reports `freshLoad`, and when it is false a notice says why. When the new tab
  showed the sign-in form, the site keeps its session only in page memory or session storage, and
  the host signs in automatically at each operation start; the marker must still be site-wide.

The published tool records the check with its screens.

## A sign-in refusal found by operation code

An operation may find a field-specific refusal after the host's sign-in setup. Use an error marker observed during normal authorized sign-in; never submit deliberately bad credentials to invent a marker. Call `await rejectedSignIn({ field: "password", selector: observedPasswordErrorSelector })` on the authorized page. The helper reads only boolean locator visibility: a visible marker throws `errors.CredentialsRejected(field)`, an absent marker returns, and unavailable or malformed inspection throws `OperationFailure` with its cause. When operation code already observed the specific refusal, it may instead throw `new errors.CredentialsRejected(field)` directly. Pass only the finite field kind, never a credential value or error text.

The caller receives `credentials_rejected` and `rejected_field`; this requests no repair. Preserve every named commit mark. A write whose commit may have been sent still returns `outcome_unknown` with `possible_commit`; read back its outcome before any retry. A refusal before any declared commit step was entered stays rejected without a possible commit.

## Staying signed in during an operation

Some sites keep their session only in the page, so a full page load signs them out. The runtime
calls `ensureSignedIn()` once before your operation code runs, so every signed-in operation starts
signed in. After that, call `const { signedInAgain } = await ensureSignedIn()` after each full page
load in the middle of the script: a `page.goto`, a reload, or a click or submit that loads a new
document. In-page navigation in a single-page app needs no call. The host checks the signed-in
marker on the current page without moving it and signs in again only when the page is signed out.
When `signedInAgain` is true, the sign-in left the page somewhere else: open the page you were on
again before you go on. The host signs in on the same browser while your script waits in
`ensureSignedIn`, and the operation's deadline pauses meanwhile. Any other browser call the script
makes during that time, even from a timer or a promise it never awaited, is held until the host is
done, then sent in order.

Never call it between a write's commit and its read-back: read the outcome back first. Let its
failure propagate. An `OperationFailure` with `sessionLoss: "session_not_kept"` means the host
could not sign in again, and the run reports that the site did not keep its session. Never catch it
to go on signed out, and never sign in from the script yourself.

# A direct sign-in request

A direct sign-in request signs in with one host-filled HTTP request instead of an autofill form submission. Runs are faster with it, so the host prefers it once a mint proves it.

<!-- opengpt:section auth.direct-request:start

## Standalone live authentication

Observe the current login screen with a reviewed read-only probe: its URL, frames, visible field labels/types/names/autocomplete, form destination and submit. Never read control values or enter credentials in source. Pass `signInStep` to execute purpose `authenticate`, target `liveBrowser`, with the evidenced reusable `loginUrl`.

Fields use the same slots and format declarations. `username` lists every accepted identifier kind; password/code/recovery-code/date-of-birth/ZIP/private-answer match that observed field's purpose. The host obtains the needed value through the caller's input callback or the terminal, checks the original field/document/origin/focus binding and inserts privately. The terminal hides a password, code or other secret as it is typed, and shows a username, email, phone number or account number. A private answer is prompted from the current `questionSelector` text when it has one visible match in the answer field's frame. When a recorded question could not be read, the prompt says so; with no `questionSelector`, it uses the field label. The answer is discarded after this fill. Supply the observed question selector when the question is adjacent to a generic answer label. No saved credential, seed or SMS automation is used. The host records the screens of a verified sign-in, without values, and publishes them with the tool; each run of the tool replays them, asking for the login and any code or answer only when the site needs it. No value enters your model context or files.

Inspect each subsequent screen and send its observed step. After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json`, where the host saved the next screen's controls: role, name or label, input type, and whether each is required, visible and enabled, never a value. Read it first to see what the screen asks for, then probe read-only only for what it lacks, such as a selector or form destination. A failed step's result shows the last saved controls inline, at most 30, and the file holds the rest. An account choice needs caller input before selection, and a sign-in method follows the order above. Wait for and verify an observed signed-in marker; disappearance of the login form is insufficient. Rejection requires caller correction and never authorizes replay of a private submission. Popup/frame sign-in uses the observed host target and configured sign-in origins, with the same destination guard.

opengpt:section auth.direct-request:end -->

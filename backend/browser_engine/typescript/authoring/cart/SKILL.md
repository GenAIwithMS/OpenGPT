---
name: cart
description: Read before building any tool that reads, adds to, changes or checks out a cart: when to sign in or check out as a guest, read the cart before and after, quantity, account values and site limits.
---

# Carts and checkout

Read this for any tool that reads, adds to, changes or checks out a cart. For a write, the
writes skill's session, commit and publication rules still apply; this adds what a cart needs.

## Sign in, or check out as a guest

A cart a later call must find, such as a standalone add-to-cart, view-cart, change-cart or
checkout tool's, runs on the caller's account, because a signed-out cart lives in one browser
session. Sign in before reading or changing it (for a write, before the first `act` step; the
auth skill), even when the site lets a guest add to a cart, and judge the account's cart only
from the account.

A tool that fills the cart and places the order in the same run may use the site's guest
checkout when the site offers one and the build holds no login. Prefer it to creating an
account. Decide before you sign in, since a build that sent a login keeps it. Take the guest's
contact details as inputs and the card as the caller-input skill says.

## Take the product as the site's tools do

Take the product as the identifier and option values the site's own pages use, such as a
product number and a size, so a caller can pass a search or details tool's output straight in.
When `reference/site-tools.json` lists such a tool, use its identifier, field names and option
values (the core skill). Quantity, each option the product offers and, when the site lets a
visitor set one, the location or store are inputs. Set the options as "Configure, then read" in
the core skill says before adding the product: a value the product does not offer throws
`InvalidInput` with `field` and `available`.

## Quantity

The request decides whether quantity adds that many to the cart or sets the line to that
number; ask when it does not settle which. Build only that one, and state it in the tool's
description and the quantity field's description, such as "Units to add; an existing line grows
by this many".

## Read the cart before and after

Read the cart's lines before the write, in the session and in the composed script; never
assume the cart starts empty. Afterwards, confirm from the cart itself that the line reached
the expected quantity (the earlier quantity plus the input, or the input) and that every other
line is unchanged, then return the lines as read and call `verified()`. A checkout reads the
lines it is about to buy before its commit and returns them with the confirmation.

## Values the account lacks

A value the flow needs that the account lacks, such as a delivery address, is a question for
the caller: ask with `request_input` while building, and in the tool take it as an input or a
declared question (the caller-input skill). Never invent it, and never save it to the account
unasked. A save option the page pre-selects is a question, as `AGENTS.md` says; in the
tool, an unset save option means off, not the page's default.

Choosing the delivery address and payment method is part of a checkout's job, even when the
account has saved ones the page pre-selects: take each from the input, such as which saved
address or a new one, or ask before the commit mark which to use (the writes skill). Never use
the page's selection silently. A paid add-on within the tool's purpose, such as a protection
plan for the item bought, is an input or a question too. A paid membership, subscription or
trial the checkout offers is outside its purpose: decline it without asking, never accept it
without an input the caller set, and handle its pop-up as conditional (the forms skill), since
it shows only to some accounts.

## Minimums and refusals

When the site refuses the order as asked, such as an order under its minimum or an empty cart
at checkout, the tool throws `new errors.InvalidInput(message, { field })` with the site's
reason, `field` the input the caller would change, before its commit mark whenever the page shows
the limit first. A checkout that takes a limit of the caller's, such as
a maximum total, reads the final total and compares it before the order's commit mark, and
refuses with `InvalidInput`, `field` that input and `kind: "over_price_limit"`, giving the total
and the limit (the caller-input skill). Never add items, raise a quantity or change the
delivery method to meet a limit. While building, ask the caller to revise or stop, as
`AGENTS.md` says. When they stop, or their answer cannot be met either, end with
`report_blocked` and explain the site's limit: a build that only reached the limit never
completed the write, so it never publishes.

## Description

The description states the decisions a caller needs to use the tool right (the publication
skill): that it acts on the signed-in account's cart or checks out as a guest, whether
quantity adds or sets, what it returns, and what it leaves out, such as placing the order.

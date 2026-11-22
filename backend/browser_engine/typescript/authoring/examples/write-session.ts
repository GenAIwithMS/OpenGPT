import { Schema } from "effect";
import {
  defineOperation,
  formControlsCode,
  sameText,
  timeoutDefaults,
  waitCode,
} from "../../src/browser/index.js";
import type { KernelOperationContext } from "../../src/browser/index.js";

// Observed contract: /checkout fills item, quantity and a gift-wrap add-on the page offers
// unchecked, some items add a required field of their own, such as an engraving choice, once
// filled in, Continue opens a review step showing the item and the order total, some accounts
// get a membership offer over the review, and Place order shows "Order ORD-…" on its
// confirmation page. For an item that goes by courier, Place order instead keeps the review and
// shows a delivery phone field, flagged empty, and places nothing; an account with no card on
// file gets card fields there instead. Adapt every selector and condition from your own
// session's evidence.
// Every on-path option is an input: the add-on is the caller's choice, never kept or cleared
// unasked. An account-specific value (a passenger, saved card or address) would be a free-form
// input, never an enum member, example or default.
export const OrderInput = Schema.Struct({
  item: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({ description: "Item to order, as the site names it" }),
  quantity: Schema.Int.pipe(Schema.between(1, 99)).annotations({
    description: "How many to order, 1 to 99",
  }),
  gift_wrap: Schema.Boolean.annotations({ description: "Whether to add gift wrap" }),
  // Only when the request sets a limit; without one the tool places the order at any total.
  max_total_minor: Schema.optional(
    Schema.Int.pipe(Schema.positive()).annotations({
      description: "Highest order total to accept, in minor units of the site's currency",
    }),
  ),
});
type OrderInput = typeof OrderInput.Type;
const Placed = Schema.Struct({
  order_number: Schema.NonEmptyTrimmedString.annotations({
    description: "Order number from the confirmation",
  }),
});
const RequiredField = Schema.Struct({
  label: Schema.String,
  shape: Schema.String,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
  ),
  unsupported: Schema.optional(Schema.Boolean),
});
const Filled = Schema.Union(
  Schema.Struct({ fields: Schema.Array(RequiredField) }),
  Schema.Struct({ failure: Schema.Literal("checkout_changed") }),
);
const Continued = Schema.Union(
  Schema.Struct({ review_shown: Schema.Literal(true) }),
  Schema.Struct({ failure: Schema.Literal("checkout_changed") }),
);
const Review = Schema.Union(
  Schema.Struct({ item: Schema.String, total_minor: Schema.Int }),
  Schema.Struct({ failure: Schema.Literal("review_missing") }),
);
const Confirmed = Schema.Union(
  Schema.Struct({ order_number: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ blocked: Schema.Array(RequiredField) }),
  Schema.Struct({ unaskable: Schema.Array(Schema.String) }),
  Schema.Struct({ failure: Schema.Literal("review_missing", "total_changed", "not_confirmed") }),
);
const Answer = Schema.Struct({ label: Schema.String, answer: Schema.String });
type Answer = typeof Answer.Type;
type Field = typeof RequiredField.Type;
// One site-field question per field a step shows at once, so the caller answers them in one round.
const fieldIds = ["extra_field", "extra_field_2", "extra_field_3"] as const;
type FieldId = (typeof fieldIds)[number];
const fieldQuestions: { readonly [Id in FieldId]: { readonly type: "site_field" } } = {
  extra_field: { type: "site_field" },
  extra_field_2: { type: "site_field" },
  extra_field_3: { type: "site_field" },
};
type Context = Omit<KernelOperationContext<OrderInput>, "ask" | "askOne">;
type FillContext = KernelOperationContext<OrderInput, typeof fieldQuestions>;

// The act steps and the composed script share these calls, so the published script repeats
// exactly what the session did.

/**
 * Asks the caller for the fields the page requires and no input covers, in one round: a site-field
 * question for each, in the page's order, by its label and options. Each answer comes back under
 * its field's question. A step that shows more fields than there are questions asks the rest next.
 */
const askFields = async (ask: FillContext["ask"], fields: readonly Field[]) => {
  const answers: Answer[] = [];
  for (let start = 0; start < fields.length; start += fieldIds.length) {
    const round = fieldIds.flatMap((id, index) => {
      const field = fields[start + index];
      return field === undefined ? [] : [{ id, field }];
    });
    // `ask` answers exactly the questions it is given: one for each field of this round.
    const answered = await ask(
      Object.fromEntries(
        round.map(({ id, field: { label, options } }) => [
          id,
          options === undefined ? { label } : { label, options },
        ]),
      ) as { readonly [Id in FieldId]: { readonly label: string } },
    );
    for (const { id, field } of round) answers.push({ label: field.label, answer: answered[id] });
  }
  return answers;
};

/**
 * Asks for the fields the form requires and no input covers, and fills each answer into its field.
 * It saves nothing. An answer can make the form show or enable another required field, such as a
 * karat once gold is chosen, so the form is read again after each round and such a field is asked
 * in the next. It returns false when the form shows a field no site-field question can ask, or
 * shows again a field it asked already.
 */
const askAndFill = async (context: FillContext, form: string, shown: readonly Field[]) => {
  const { kernel, sessionId, errors, ask } = context;
  const asked = new Set<string>();
  for (let fields = shown; fields.length > 0; ) {
    if (fields.some(({ label, unsupported }) => unsupported === true || asked.has(label)))
      return false;
    for (const { label } of fields) asked.add(label);
    const answers = await askFields(ask, fields);
    const filled = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${formControlsCode}
        const form = page.getByRole("form", { name: ${JSON.stringify(form)}, exact: true });
        const before = await visibleFieldLabels(form, { enabledOnly: true });
        for (const { label, answer } of ${JSON.stringify(answers)}) await fillRequiredField(form, label, answer);
        // Only a labelled field the answers showed or enabled is new.
        return await unfilledRequiredFields(form, { before });
      `,
    });
    if (!filled.success)
      throw new errors.OperationFailure(String(filled.error), { stderr: filled.stderr });
    fields = Schema.decodeUnknownSync(Schema.Array(RequiredField))(filled.result);
  }
  return true;
};

// The membership offer shows only to some accounts, so it is conditional: decline it when it
// shows and go on when it does not. It is outside this tool's purpose, so declining needs no
// input, and the tool never accepts it. Both calls before the commit mark check for it, so an
// offer that opens late is declined too.
const declineOffer = `
  const offer = page.getByRole("dialog", { name: "Membership offer", exact: true });
  if (await offer.isVisible()) {
    await offer.getByRole("button", { name: "No thanks", exact: true }).click({ timeout: 5000 });
    await offer.waitFor({ state: "hidden", timeout: 5000 });
  }
`;

/** From the site origin page: open the checkout, fill it from the input and stop at the review step. */
const fillCheckout = async (context: FillContext) => {
  const { kernel, sessionId, siteOrigin, input, errors } = context;
  if (siteOrigin === undefined)
    throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      ${formControlsCode}
      const checkout = ${JSON.stringify(new URL("/checkout", siteOrigin).href)};
      const input = ${JSON.stringify(input)};
      await page.goto(checkout, { waitUntil: "domcontentloaded", timeout: ${timeoutDefaults.navigation} });
      const form = page.getByRole("form", { name: "Checkout", exact: true });
      if ((await form.count()) !== 1) return { failure: "checkout_changed" };
      await form.getByLabel("Item", { exact: true }).fill(input.item, { timeout: 5000 });
      await form.getByLabel("Quantity", { exact: true }).fill(String(input.quantity), { timeout: 5000 });
      await form.getByLabel("Gift wrap", { exact: true }).setChecked(input.gift_wrap, { timeout: 5000 });
      return { fields: await unfilledRequiredFields(form) };
    `,
  });
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const filled = Schema.decodeUnknownSync(Filled)(answer.result);
  if ("failure" in filled)
    throw new errors.OperationFailure(filled.failure, { dispatch: "not_sent" });
  // A required field the item added, which no input covers, is asked with the site-field
  // question before anything saves. Another kind of field is a checkout this tool does not know.
  if (!(await askAndFill(context, "Checkout", filled.fields)))
    throw new errors.OperationFailure("checkout_changed", { dispatch: "not_sent" });
  const continued = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const form = page.getByRole("form", { name: "Checkout", exact: true });
      if ((await form.count()) !== 1) return { failure: "checkout_changed" };
      await form.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 5000 });
      const place = page.getByRole("button", { name: "Place order", exact: true });
      await place.or(page.getByRole("dialog", { name: "Membership offer", exact: true })).first().waitFor({ timeout: 10000 });
      ${declineOffer}
      await place.waitFor({ timeout: 10000 });
      return { review_shown: true };
    `,
  });
  if (!continued.success)
    throw new errors.OperationFailure(String(continued.error), { stderr: continued.stderr });
  const reviewed = Schema.decodeUnknownSync(Continued)(continued.result);
  // Filling sends nothing the site keeps: a changed form fails before any commit. That holds
  // only because this site's Continue was seen to open a review step without saving. A
  // Continue, Next or payment button whose next screen you have not seen may save or place
  // the order, so mark it with enteringCommit before the call, as placeAndConfirm does.
  if ("failure" in reviewed)
    throw new errors.OperationFailure(reviewed.failure, { dispatch: "not_sent" });
};

// The review's total in minor units, read the same way before the commit mark and inside it.
// This site shows a two-decimal total with a "." separator, such as "$37.50"; parse the format
// your site shows.
const readTotal = `
  const totalText = await page.getByLabel("Order total", { exact: true }).innerText({ timeout: 5000 });
  const total_minor = Math.round(Number(totalText.replace(/[^0-9.]/g, "")) * 100);
`;

/**
 * Every check that can refuse runs here, before each marked click: the review shows the item
 * asked for, and its total is within the caller's limit. Nothing here changes the site.
 */
export const checkReview = async ({ kernel, sessionId, input, errors }: Context) => {
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 30,
    code: `
      ${declineOffer}
      if ((await page.getByRole("button", { name: "Place order", exact: true }).count()) !== 1)
        return { failure: "review_missing" };
      ${readTotal}
      const item = await page.getByLabel("Item", { exact: true }).innerText({ timeout: 5000 });
      return { item, total_minor };
    `,
  });
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const review = Schema.decodeUnknownSync(Review)(answer.result);
  if ("failure" in review)
    throw new errors.OperationFailure(review.failure, { dispatch: "not_sent" });
  // The tool filled the item itself, so another one on the review is a page that changed: a
  // failure, never the caller's input.
  if (!sameText(review.item, input.item))
    throw new errors.OperationFailure("review_item_mismatch", { dispatch: "not_sent" });
  // Over the caller's own limit is a refusal: InvalidInput naming the input, a stable kind and
  // both values, thrown before the mark so the run reports that it changed nothing.
  if (input.max_total_minor !== undefined && review.total_minor > input.max_total_minor)
    throw new errors.InvalidInput(
      `The order total is ${review.total_minor}, over max_total_minor ${input.max_total_minor}`,
      { field: "max_total_minor", kind: "over_price_limit" },
    );
  return review.total_minor;
};

/**
 * The marked call: it only guards against a total that moved since checkReview, clicks once and
 * reads what the click did. A confirmation already on the page cannot stand in for this one.
 */
const clickPlace = async ({ kernel, sessionId, errors }: Context, checkedTotal: number) => {
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      ${waitCode}
      ${formControlsCode}
      const review = page.getByRole("form", { name: "Review", exact: true });
      const place = review.getByRole("button", { name: "Place order", exact: true });
      if ((await place.count()) !== 1) return { failure: "review_missing" };
      ${readTotal}
      if (total_minor !== ${JSON.stringify(checkedTotal)}) return { failure: "total_changed" };
      // The fields the review shows just before the click: one of them flagged after it proves nothing.
      const before = await visibleFieldLabels(review);
      // The confirmation, or the review again with a field it flagged. Anything else fails the wait.
      const confirmation = page.getByRole("status", { name: "Order confirmation", exact: true });
      const answer = await waitForOutcomeResult(
        { placed: confirmation, flagged: { invalid: review } },
        { action: () => place.click({ noWaitAfter: true, timeout: 5000 }), deadline: Date.now() + 30000 },
      );
      if (answer.outcome === "flagged") {
        // Only a review whose every flag is a required field the click showed, left empty, proves
        // the click saved nothing. Any other flag may be the site's answer to a saved order.
        // With unaskable, it also says when one of those fields is a secret no question may ask.
        const blocked = await blockingRequiredFields(review, before, { unaskable: true });
        if (blocked === null) return { failure: "not_confirmed" };
        return blocked.unaskable === true ? { unaskable: blocked.labels } : { blocked: blocked.fields };
      }
      const number = /^Order (ORD-[0-9]+)/.exec(await confirmation.innerText())?.[1];
      return number === undefined ? { failure: "not_confirmed" } : { order_number: number };
    `,
  });
  // A failure after the click leaves the write uncertain. Nothing here resubmits it.
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  return Schema.decodeUnknownSync(Confirmed)(answer.result);
};

/**
 * The one commit, then the confirmation the site shows for it. It clicks a second time only when
 * the page proved the first click saved nothing, once the fields that stopped it are filled.
 */
export const placeAndConfirm = async (context: FillContext, checkedTotal: number) => {
  const { errors, verified, enteringCommit, notCommitted } = context;
  // The call below can send the order, so its commit step is marked first.
  enteringCommit("place-order");
  let result = await clickPlace(context, checkedTotal);
  if ("unaskable" in result) {
    // The click saved nothing, the same proof as below, but no site-field question may ask a
    // field it showed, such as a card number. Record that it saved nothing, then refuse, naming
    // each such field by its label. Never click again.
    notCommitted("place-order");
    throw new errors.InvalidInput(
      `The site requires ${result.unaskable.join(", ")} to place the order, which this tool can't fill`,
    );
  }
  if ("blocked" in result) {
    // The review stayed, and its only flags are fields it showed on the click, left empty: that
    // click saved nothing, so record that before asking. A caller who never answers then leaves
    // the order not sent. Ask for the fields and fill them, and check the review again, since an
    // answer such as a delivery speed may change the total. Then enter the step again and click
    // once more.
    notCommitted("place-order");
    if (!(await askAndFill(context, "Review", result.blocked)))
      throw new errors.OperationFailure("not_confirmed", { dispatch: "not_sent" });
    const recheckedTotal = await checkReview(context);
    enteringCommit("place-order");
    result = await clickPlace(context, recheckedTotal);
  }
  // A review that still stops the order after its answers is the site's refusal, never resubmitted.
  // The step went back once already, so it stays possibly sent.
  if ("blocked" in result || "unaskable" in result)
    throw new errors.OperationFailure("not_confirmed", { dispatch: "sent" });
  if ("failure" in result)
    throw new errors.OperationFailure(result.failure, {
      dispatch: result.failure === "not_confirmed" ? "sent" : "not_sent",
    });
  // The site's own confirmation for this submission, read back: the write landed.
  verified();
  return result;
};

/** Act step 1: fills the checkout on the site origin page and stops before the commit. */
export const fillStep = defineOperation(
  {
    name: "fill_checkout",
    input: OrderInput,
    questions: fieldQuestions,
    output: Schema.Struct({
      review_shown: Schema.Boolean.annotations({ description: "True once the review step shows" }),
    }),
  },
  async (context) => {
    await fillCheckout(context);
    return { review_shown: true };
  },
);

/** Act step 2: continues on the page step 1 left, checks it, commits once and confirms. */
export const placeStep = defineOperation(
  {
    name: "place_order",
    input: OrderInput,
    output: Placed,
    questions: fieldQuestions,
  },
  async (context) => placeAndConfirm(context, await checkReview(context)),
);

/** The composed script, published without another run: the whole flow from the site origin page. */
export default defineOperation(
  {
    name: "place_order",
    input: OrderInput,
    output: Placed,
    questions: fieldQuestions,
    write: { confirmation: "readback", commits: ["place-order"] },
  },
  async (context) => {
    await fillCheckout(context);
    return placeAndConfirm(context, await checkReview(context));
  },
);

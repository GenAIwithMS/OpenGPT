/**
 * Card answers and the payment processors' frames they may be typed into.
 *
 * A checkout often keeps its card fields in a frame its payment processor serves, so the card
 * never touches the site's own page. The host types a card answer only into a field on the site
 * itself or into a field whose own frame is on one of `paymentFrameOrigins`, on a page whose top
 * document is on the site. Each entry is an exact origin a processor documents for its card
 * fields; nothing else counts, not another subdomain and not another scheme or port.
 */

/** The parts of a payment card a checkout asks for, each a secret question's kind. */
export type CardSlot = "card_number" | "card_expiry" | "card_cvc" | "billing_postal_code";

export const cardSlots: readonly CardSlot[] = [
  "card_number",
  "card_expiry",
  "card_cvc",
  "billing_postal_code",
];

/** Whether a field's slot or a question's kind is a part of a payment card. */
export const isCardSlot = (slot: string | undefined): slot is CardSlot =>
  slot !== undefined && (cardSlots as readonly string[]).includes(slot);

/**
 * The exact frame origins of the major payment processors' card fields. Adding one needs the
 * processor's own documentation of that origin for its card fields.
 */
export const paymentFrameOrigins: readonly string[] = [
  // Stripe: Stripe.js Elements and the Payment Element (docs.stripe.com/security/guide, frame-src).
  "https://js.stripe.com",
  // Square: the Web Payments SDK card element (developer.squareup.com, Web Payments CSP).
  "https://web.squarecdn.com",
  // Braintree: Hosted Fields, from its production assets URL (braintree-web, ASSETS_URLS).
  "https://assets.braintreegateway.com",
  // Adyen: Secured Fields, one shopper host per live region (adyen-web, API_ENVIRONMENTS).
  "https://checkoutshopper-live.adyen.com",
  "https://checkoutshopper-live-us.adyen.com",
  "https://checkoutshopper-live-au.adyen.com",
  "https://checkoutshopper-live-apse.adyen.com",
  "https://checkoutshopper-live-in.adyen.com",
];

/** Whether a URL's own origin is exactly one of `origins`; a URL with credentials never is. */
export const onPaymentFrameOrigin = (
  url: string,
  origins: readonly string[] = paymentFrameOrigins,
) => {
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    parsed.username === "" &&
    parsed.password === "" &&
    origins.includes(parsed.origin)
  );
};

/**
 * The forms a page may show a card answer in besides as typed, for the secrets screen to mask
 * too: a card number's digits alone, in groups of four, and in the 4-6 groups American Express
 * (4-6-5) and Diners Club (4-6-4) numbers use, each spaced or dashed; and an expiry as `MM/YY` and
 * `MM / YY`, with a four-digit year when given one. A host that masks by pattern also masks the
 * number's `cardDigitRun`.
 */
export const cardValueForms = (slot: CardSlot, value: string): readonly string[] => {
  const digits = value.replace(/\D/gu, "");
  const forms = [value];
  if (slot === "card_number" && digits.length >= 12 && digits.length <= 19) {
    const fours = digits.match(/.{1,4}/gu)?.join(" ") ?? digits;
    forms.push(digits, fours, fours.replaceAll(" ", "-"));
    if (digits.length === 14 || digits.length === 15) {
      const sixes = `${digits.slice(0, 4)} ${digits.slice(4, 10)} ${digits.slice(10)}`;
      forms.push(sixes, sixes.replaceAll(" ", "-"));
    }
  }
  if (slot === "card_expiry" && (digits.length === 4 || digits.length === 6)) {
    const month = digits.slice(0, 2);
    for (const year of new Set([digits.slice(2), digits.slice(-2)]))
      forms.push(`${month}/${year}`, `${month} / ${year}`);
  }
  return [...new Set(forms)];
};

/**
 * A card number's digits in any grouping, as a global pattern: each digit, then at most one space,
 * non-breaking space, dash or dot before the next, with no digit adjoining the run. Undefined for
 * a value that is not a card number's length.
 */
export const cardDigitRun = (value: string) => {
  const digits = value.replace(/\D/gu, "");
  return digits.length < 12 || digits.length > 19
    ? undefined
    : new RegExp(`(?<![0-9])${[...digits].join("[ \\u00a0.-]?")}(?![0-9])`, "gu");
};

/** A card part this short or shorter, such as a security code, is masked only as a whole token. */
export const shortCardPart = 5;

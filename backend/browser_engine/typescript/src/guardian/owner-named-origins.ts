import { sameSite } from "../runtime/same-site.js";
import type { PendingExecution } from "./review.js";

/**
 * Each https origin off the allowed sites that the owner's own words name: where the owner says
 * the requested work lives, such as their own tenant or instance of a product on another
 * registrable domain than its marketing or login site. Guardian reviews work there like work on
 * the site (`trusted_authority.ownerNamedOrigins`).
 *
 * The owner's words count: `requestedIntent` (the intent as the owner submitted it) and every
 * answer in `answeredQuestions`, its text, the option labels the owner picked, their own option
 * and their note. An option the minting model wrote, once the owner picks it or types it back, is
 * the owner's confirmation of what it says, so a link in it names where their work lives. A
 * question prompt or option the owner did not pick never names one, and neither does website
 * content. Each entry is a
 * `URL.origin` (`https://host` or `https://host:port`, punycode for an IDN), once, in the order
 * first named; empty when none. Pure and derived from screened text, so every caller computes the
 * same list from the same pending review.
 */
export const ownerNamedOrigins = (
  pending: Pick<PendingExecution, "requestedIntent" | "answeredQuestions" | "allowedOrigins">,
): readonly string[] => {
  const { requestedIntent = "", answeredQuestions = [], allowedOrigins } = pending;
  const answered = answeredQuestions.flatMap(({ answer, other, note }): readonly string[] => [
    ...(typeof answer === "string"
      ? [answer]
      : Array.isArray(answer)
        ? answer
        : "confirmed" in answer && answer.confirmed && answer.text !== undefined
          ? [answer.text]
          : []),
    ...(other === undefined ? [] : [other]),
    ...(note === undefined ? [] : [note]),
  ]);
  const named = new Set<string>();
  for (const text of [requestedIntent, ...answered])
    for (const [match] of text.matchAll(/https:\/\/[^\s"'`<>()[\]{}]+/giu)) {
      // Sentence punctuation after a URL is not part of it.
      const url = URL.parse(match.replace(/[.,;:!?]+$/u, ""));
      if (url !== null && !allowedOrigins.some((origin) => sameSite(origin, url)))
        named.add(url.origin);
    }
  return [...named];
};

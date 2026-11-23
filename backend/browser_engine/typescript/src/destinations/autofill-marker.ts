import { Effect, Schema } from "effect";
import { approvalNumberPattern, type AutofillPopup } from "./autofill-contracts.js";
import { autofillPageCode } from "./autofill-page-code.js";
import type { AutofillPage } from "./autofill-step.js";
import { sameSite } from "../runtime/same-site.js";

/** A recorded element on a screen's page, which is read only on the screen's allowed frames. */
interface ScreenElement {
  readonly selector: string;
  readonly screenPage: string;
  readonly popup?: AutofillPopup | undefined;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
}

/**
 * The screen page's origin when the selector is a plain one and the origin is the site's or a
 * configured sign-in origin; undefined otherwise, which reads nothing.
 */
const allowedScreenOrigin = (input: ScreenElement) => {
  if (input.selector.includes(">>") || input.selector.includes("internal:")) return undefined;
  const expected = URL.parse(input.screenPage)?.origin;
  const allowed =
    expected !== undefined &&
    (input.authenticationOrigins.includes(expected) ||
      sameSite(input.siteOrigin, new URL(expected)));
  return allowed ? expected : undefined;
};

/**
 * Reads the number a device approval's screen shows in its `matchSelector` element: the first
 * visible match's trimmed text on the screen's allowed frames, returned only when it is 1 to 3
 * digits, so no other page text leaves the page.
 */
export const autofillApprovalNumber = (input: ScreenElement) => {
  const expected = allowedScreenOrigin(input);
  if (expected === undefined) return Effect.succeed(undefined);
  return input.page
    .execute(
      `${autofillPageCode(input.page.targetId, input.popup)}
const expected = ${JSON.stringify(expected)};
if (new URL(primary.url()).origin !== expected) return null;
const origins = ${JSON.stringify([expected, ...input.authenticationOrigins])};
const number = new RegExp(${JSON.stringify(approvalNumberPattern.source)}, "u");
for (const frame of primary.frames()) {
  let origin;
  try { origin = new URL(frame.url()).origin; } catch { continue; }
  if (!origins.includes(origin)) continue;
  const element = frame.locator(${JSON.stringify(input.selector)});
  const count = Math.min(await element.count(), 100);
  for (let index = 0; index < count; index++) {
    if (!(await element.nth(index).isVisible())) continue;
    const text = (await element.nth(index).innerText({ timeout: 1000 })).trim();
    return number.test(text) ? text : null;
  }
}
return null;`,
      15,
    )
    .pipe(Effect.map((result) => (typeof result === "string" ? result : undefined)));
};

/** Reads only whether a recorded rejection marker is visible on its screen's allowed frames. */
export const autofillMarkerVisible = (input: ScreenElement) => {
  const expected = allowedScreenOrigin(input);
  if (expected === undefined) return Effect.succeed(false);
  // A known absent recorded popup has no visible marker; opener verification still decides success.
  return input.page
    .execute(
      `${autofillPageCode(input.page.targetId, input.popup)}
const expected = ${JSON.stringify(expected)};
if (new URL(primary.url()).origin !== expected) return false;
const origins = ${JSON.stringify([expected, ...input.authenticationOrigins])};
for (const frame of primary.frames()) {
  let origin;
  try { origin = new URL(frame.url()).origin; } catch { continue; }
  if (!origins.includes(origin)) continue;
  const marker = frame.locator(${JSON.stringify(input.selector)});
  const count = Math.min(await marker.count(), 100);
  for (let index = 0; index < count; index++)
    if (await marker.nth(index).isVisible()) return true;
}
return false;`,
      15,
    )
    .pipe(
      Effect.flatMap((result) =>
        input.popup === undefined
          ? Schema.decodeUnknown(Schema.Boolean)(result)
          : Schema.decodeUnknown(
              Schema.Union(
                Schema.Boolean,
                Schema.Struct({
                  error: Schema.Literal("popup_missing"),
                  target: Schema.Literal("popup"),
                }),
              ),
            )(result).pipe(Effect.map((visible) => visible === true)),
      ),
    );
};

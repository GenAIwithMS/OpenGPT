import { Effect } from "effect";
import { primaryPageCode } from "../runtime/host-execute.js";
import type { AutofillPage } from "./autofill-step.js";

/** Opens `url` on the primary tab, as a run's replay starts from its login URL. */
export const openAutofillLogin = (input: {
  readonly page: AutofillPage;
  readonly url: string;
  /** How long the page may take to load; 30 s by default. */
  readonly timeoutMs?: number;
}) =>
  input.page
    .execute(
      `${primaryPageCode(input.page.targetId)}
await primary.goto(${JSON.stringify(input.url)}, { waitUntil: "domcontentloaded", timeout: ${input.timeoutMs ?? 30_000} });
return primary.url();`,
      Math.ceil((input.timeoutMs ?? 30_000) / 1000) + 5,
    )
    .pipe(Effect.asVoid);

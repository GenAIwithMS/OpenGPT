import type { BrowserContext, Page } from "playwright";
import type { ExpectedConfirm } from "../../src/browser/dialogs/contracts.js";
import { expectedConfirmDigest } from "../../src/browser/dialogs/expected.js";

/**
 * The contract every host's handling of a run's native dialogs keeps, on one fixture page. The
 * confirm a write's build accepted at a step is accepted again at that step without asking, once.
 * Every other popup, in the page, in an iframe, in a popup window or in a read-only run, asks the
 * caller or is dismissed. None of them is accepted, and none is left open. The one exception is
 * the recorded message at the recorded step raised from another site's frame in the page: a host
 * that reads a dialog's origin from the top page, the default `dialogOrigin`, accepts it as the
 * page's own (see `ConfirmPopupContractOptions`).
 *
 * A host runs each case on a fresh page of a context `serveConfirmPopups` serves, with a fresh run:
 * it opens `confirmPopupsOrigin`, clicks the case's `selector` (inside the case's `frame`, when it
 * has one) under its own run handling as the action named `step`, with `recordedConfirmPopups` as
 * the tool's record, the case's `readOnly`, and a caller whose question windows end unanswered. It
 * then reads `confirmPopupOutcomes` and counts the questions the caller got.
 * `confirmPopupContractFailures` judges the observations of every case at once.
 */
export const confirmPopupsOrigin = "https://confirm-popups.test";
/** Another site, whose frame the fixture page embeds. */
export const confirmPopupsFrameOrigin = "https://confirm-popups-frame.test";

export type ConfirmPopupCaseName =
  | "recorded"
  | "repeated"
  | "unrecorded"
  | "other_step"
  | "iframe"
  | "cross_origin_frame"
  | "popup"
  | "read_only";

export interface ConfirmPopupCase {
  readonly name: ConfirmPopupCaseName;
  /** The step the run reports the click under, as a script names it to `decideDialog`. */
  readonly step: string;
  /** The button that raises the case's confirm. */
  readonly selector: string;
  /** The iframe the button sits in, when it is not in the page itself. */
  readonly frame?: string;
  /** Where the confirm shows. */
  readonly shownIn: "page" | "iframe" | "cross_origin_frame" | "popup";
  readonly message: string;
  /** How many times the click raises the confirm. */
  readonly raises: 1 | 2;
  /** The case runs as a read tool's run. */
  readonly readOnly?: true;
}

const placeOrder = "Place this order?";

export const confirmPopupCases: readonly ConfirmPopupCase[] = [
  {
    name: "recorded",
    step: "place-order",
    selector: "#recorded",
    shownIn: "page",
    message: placeOrder,
    raises: 1,
  },
  {
    name: "repeated",
    step: "place-order",
    selector: "#repeated",
    shownIn: "page",
    message: placeOrder,
    raises: 2,
  },
  {
    name: "unrecorded",
    step: "remove-item",
    selector: "#unrecorded",
    shownIn: "page",
    message: "Remove this item?",
    raises: 1,
  },
  {
    name: "other_step",
    step: "place-order-again",
    selector: "#other_step",
    shownIn: "page",
    message: placeOrder,
    raises: 1,
  },
  {
    name: "iframe",
    step: "frame-confirm",
    selector: "#iframe",
    shownIn: "iframe",
    message: "Confirm inside the frame?",
    raises: 1,
  },
  {
    name: "cross_origin_frame",
    step: "place-order",
    selector: "#raise",
    frame: "#cross_origin_frame",
    shownIn: "cross_origin_frame",
    message: placeOrder,
    raises: 1,
  },
  {
    name: "popup",
    step: "popup-confirm",
    selector: "#popup",
    shownIn: "popup",
    message: "Confirm in the new window?",
    raises: 1,
  },
  {
    name: "read_only",
    step: "place-order",
    selector: "#read_only",
    shownIn: "page",
    message: placeOrder,
    raises: 1,
    readOnly: true,
  },
];

/** The tool's record: the one confirm its build accepted, at its step, on the fixture's origin. */
export const recordedConfirmPopups: readonly ExpectedConfirm[] = [
  expectedConfirmDigest({ message: placeOrder, origin: confirmPopupsOrigin, step: "place-order" }),
];

const messageOf = (name: ConfirmPopupCaseName) =>
  JSON.stringify(confirmPopupCases.find((entry) => entry.name === name)?.message ?? "");

/** The case's confirm, raised once per `raises`, as the answers in order. */
const answers = (name: ConfirmPopupCaseName, raises = 1) =>
  `Array.from({ length: ${raises} }, () => (confirm(${messageOf(name)}) ? "accepted" : "dismissed"))` +
  `.join(" ")`;

/** Writes a confirm's answers into the fixture page's outcome for the case. */
const settle = (target: string, name: ConfirmPopupCaseName, raises = 1) =>
  `${target}.querySelector("#outcome-${name}").textContent = ${answers(name, raises)};`;

const pageCases = ["recorded", "repeated", "unrecorded", "other_step", "read_only"] as const;

const pages: Readonly<Record<string, string>> = {
  [`${confirmPopupsOrigin}/`]: `<!doctype html><title>Confirm popups</title>
<button id="recorded">Place order</button><output id="outcome-recorded">pending</output>
<button id="repeated">Place order twice</button><output id="outcome-repeated">pending</output>
<button id="unrecorded">Remove item</button><output id="outcome-unrecorded">pending</output>
<button id="other_step">Place order again</button><output id="outcome-other_step">pending</output>
<button id="iframe">Confirm in frame</button><output id="outcome-iframe">pending</output>
<output id="outcome-cross_origin_frame">pending</output>
<button id="popup">Open window</button><output id="outcome-popup">pending</output>
<button id="read_only">Place order, read only</button><output id="outcome-read_only">pending</output>
<iframe id="frame" src="/frame" title="Frame"></iframe>
<iframe id="cross_origin_frame" src="${confirmPopupsFrameOrigin}/frame" title="Other site"></iframe>
<script>
${pageCases
  .map((name) => {
    const raises = name === "repeated" ? 2 : 1;
    return `document.querySelector("#${name}").onclick = () => { ${settle("document", name, raises)} };`;
  })
  .join("\n")}
document.querySelector("#iframe").onclick = () =>
  document.querySelector("#frame").contentWindow.raise();
document.querySelector("#popup").onclick = () => { window.open("/popup", "confirm_popup"); };
addEventListener("message", (event) => {
  if (event.origin !== ${JSON.stringify(confirmPopupsFrameOrigin)}) return;
  document.querySelector("#outcome-cross_origin_frame").textContent = String(event.data);
});
</script>`,
  [`${confirmPopupsOrigin}/frame`]: `<!doctype html><title>Frame</title><p>Framed</p>
<script>window.raise = () => { ${settle("parent.document", "iframe")} };</script>`,
  [`${confirmPopupsOrigin}/popup`]: `<!doctype html><title>Window</title><p>New window</p>
<script>setTimeout(() => { ${settle("opener.document", "popup")} }, 50);</script>`,
  [`${confirmPopupsFrameOrigin}/frame`]: `<!doctype html><title>Other site</title>
<button id="raise">Place order here</button>
<script>
document.querySelector("#raise").onclick = () =>
  parent.postMessage(${answers("cross_origin_frame")}, ${JSON.stringify(confirmPopupsOrigin)});
</script>`,
};

/**
 * Serves the fixture's pages at `confirmPopupsOrigin` and `confirmPopupsFrameOrigin` in `context`,
 * with no server or certificate.
 */
export const serveConfirmPopups = async (context: BrowserContext) => {
  for (const origin of [confirmPopupsOrigin, confirmPopupsFrameOrigin])
    await context.route(`${origin}/**`, (route) => {
      const url = new URL(route.request().url());
      const body = pages[`${url.origin}${url.pathname}`];
      return body === undefined
        ? route.fulfill({ status: 404, body: "" })
        : route.fulfill({ status: 200, contentType: "text/html", body });
    });
};

export type ConfirmPopupOutcome = "accepted" | "dismissed" | "pending";

/**
 * What each of the case's confirms returned on the fixture page, in order, once they answered or
 * `waitMs` passed: a popup window writes its answer back after it opens. A case that never
 * answered reads `["pending"]`.
 */
export const confirmPopupOutcomes = async (
  page: Page,
  name: ConfirmPopupCaseName,
  waitMs = 3_000,
): Promise<readonly ConfirmPopupOutcome[]> => {
  const outcome = page.locator(`#outcome-${name}`);
  await outcome
    .filter({ hasNotText: "pending" })
    .waitFor({ timeout: waitMs })
    .catch(() => undefined);
  const words = ((await outcome.textContent()) ?? "").trim().split(/\s+/u);
  return words.every((word) => word === "accepted" || word === "dismissed")
    ? (words as ConfirmPopupOutcome[])
    : ["pending"];
};

export interface ConfirmPopupObservation {
  readonly outcomes: readonly ConfirmPopupOutcome[];
  /** How many questions the host put to the caller about the case's popups. */
  readonly asked: number;
}

export interface ConfirmPopupContractOptions {
  /**
   * Where the host reads a dialog's origin. `"page"` (the default) is the top page's address, which
   * is what a script reports with `page.url()`. Such a host takes the recorded message at the
   * recorded step from a cross-origin frame of the page as the page's own and accepts it. A host
   * that reads the origin of the frame that showed the dialog passes `"frame"`, and dismisses it.
   */
  readonly dialogOrigin?: "page" | "frame";
}

const judged = (outcomes: readonly ConfirmPopupOutcome[]) => outcomes.join(" ");

/**
 * Where a host's observations break the contract, as one line per broken case; empty when the
 * host keeps it. Every case must be observed. The recorded confirm is accepted without asking, and
 * only once: its second showing in the same run asks and, unanswered, is dismissed. An unrecorded
 * confirm in the page asks the caller and, unanswered, is dismissed. The iframe's, the popup
 * window's and the read-only run's are dismissed, asked or not. The cross-origin frame's follows
 * `dialogOrigin`.
 */
export const confirmPopupContractFailures = (
  observed: ReadonlyMap<ConfirmPopupCaseName, ConfirmPopupObservation>,
  options: ConfirmPopupContractOptions = {},
): readonly string[] =>
  confirmPopupCases.flatMap(({ name, shownIn, readOnly }) => {
    const observation = observed.get(name);
    if (observation === undefined) return [`${name}: the case was not run`];
    const outcome = judged(observation.outcomes);
    const { asked } = observation;
    const seen = `(${outcome}, asked ${asked})`;
    const accepted =
      name === "recorded" || (name === "cross_origin_frame" && options.dialogOrigin !== "frame");
    if (accepted)
      return outcome === "accepted" && asked === 0
        ? []
        : [`${name}: the recorded confirm must be accepted without asking ${seen}`];
    if (name === "repeated")
      return outcome === "accepted dismissed" && asked === 1
        ? []
        : [`${name}: the recorded confirm is accepted once, then must ask and end dismissed ${seen}`];
    if (outcome !== "dismissed")
      return [`${name}: a confirm the record does not cover must end dismissed, never ${outcome}`];
    return shownIn === "page" && readOnly !== true && asked === 0
      ? [`${name}: an unrecorded confirm in the page must ask the caller first`]
      : [];
  });

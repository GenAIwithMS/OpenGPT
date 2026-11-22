import { Effect, Schema } from "effect";
import type { AutofillStepReport } from "../destinations/autofill-step.js";
import {
  afterSubmitPath,
  inlineControls,
  PageControls,
  presentControls,
  type PageControls as Saved,
} from "../destinations/page-controls.js";
import type { LocalWorkspace } from "../execution/local-workspace.js";

/**
 * Whether a step did not resolve: refused, uncertain, or filled without its submit going out, by
 * the host's click or the page's own send.
 */
const failed = (report: AutofillStepReport) =>
  report.outcome !== "filled" ||
  (report.submit !== "clicked" && report.submit !== "none" && report.submit !== "page");

/** The report without its host-only `navigated`, which no minter reads. */
const shownReport = (report: AutofillStepReport): AutofillStepReport => {
  if (report.outcome !== "filled") return report;
  const { navigated: _navigated, ...shown } = report;
  return shown;
};

/**
 * Each sign-in step's result as the minter reads it, without the report's host-only `navigated`,
 * where the page went after the click, whose origins the page chose after typing. After a clicked
 * submit the host saves the page's controls, screened like other workspace data, to
 * `captures/after-submit/<step>.json` (read-only) and names the file in one line. A step that
 * fails carries the last saved controls inline as well, capped.
 */
export const makeAfterSubmit = (options: {
  readonly workspace: Pick<LocalWorkspace, "install">;
  readonly screen: (value: unknown) => Effect.Effect<unknown, Error>;
}) => {
  let step = 0;
  let last: { readonly path: string; readonly saved: Saved } | undefined;
  return (whole: AutofillStepReport) =>
    Effect.gen(function* () {
      step += 1;
      const report = shownReport(whole);
      if (report.outcome === "filled" && report.controls !== undefined) {
        const { controls, ...shown } = report;
        const path = afterSubmitPath(step);
        // Screened whole first: shortening a name before would leave part of a typed value.
        const saved = presentControls(
          yield* options.screen(controls).pipe(Effect.flatMap(Schema.decodeUnknown(PageControls))),
        );
        yield* options.workspace.install(path, `${JSON.stringify(saved, null, 2)}\n`);
        last = { path, saved };
        return { ...shown, nextScreen: `The next screen's controls are in ${path}.` };
      }
      return failed(report) && last !== undefined
        ? { ...report, lastScreen: inlineControls(last.path, last.saved) }
        : report;
    });
};

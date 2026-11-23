import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ExpectedConfirm } from "../browser/dialogs/contracts.js";
import {
  askDialogCaller,
  keepAcceptedConfirm,
  makeRunDialogDecision,
  type ObservedConfirm,
} from "../browser/dialogs/expected.js";
import { DialogFailure } from "../runtime/dialogs.js";
import type { IncidentStore } from "../runtime/incidents.js";
import type { DialogDecider, DialogReport } from "../runtime/kernel-operation.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { OwnerCancelled } from "./terminal.js";

/** A script's report as the shared confirm matcher reads it: its step is the action that raised it. */
const eventOf = (report: DialogReport) => ({ type: report.type, candidateActionId: report.step });
const factsOf = (report: DialogReport) => ({ message: report.message, pageUrl: report.url });

/** The question's window ended with no answer. The owner's cancel at the terminal is a choice. */
const unanswered = (cause: unknown) =>
  cause instanceof InputRequestFailure &&
  cause.code === "NoResponse" &&
  !(cause instanceof OwnerCancelled);

/**
 * Native dialogs stay open while the caller decides in their input surface. A question whose
 * window ends unanswered fails as `expired`. Any other failure to ask or answer is `unavailable`.
 */
export const makeDialogDecider =
  (ask: InputAsker, project: (text: string) => string): DialogDecider =>
  (report) =>
    Effect.gen(function* () {
      const answers = yield* ask({
        id: randomUUID(),
        source: "system",
        notice: project(`${report.type} from ${report.url}\n${report.message}`),
        questions: [
          {
            id: "choice",
            type: "choice",
            prompt: "How should OpenGPT respond to this dialog?",
            options: [
              { id: "accept", label: "Accept" },
              { id: "dismiss", label: "Dismiss" },
            ],
          },
        ],
      });
      const choice = answers.choice;
      if (choice?.type !== "choice" || choice.value !== "accept")
        return { choice: "dismiss" as const };
      if (report.type !== "prompt") return { choice: "accept" as const };
      const response = yield* ask({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "text",
            type: "secret",
            secretKind: "private_text",
            maxLength: 16_384,
            prompt: "Enter the text to submit to this dialog.",
          },
        ],
      });
      const text = response.text;
      if (text?.type !== "secret")
        return yield* Effect.fail(new DialogFailure({ reason: "invalid_request" }));
      return { choice: "accept" as const, promptText: text.value };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DialogFailure
          ? cause
          : new DialogFailure({ reason: unanswered(cause) ? "expired" : "unavailable" }),
      ),
    );

/**
 * A build's decider that also keeps, in `accepted`, each confirm the owner accepted that a run
 * could expect, so an act step's accepted confirms can be published with the tool. `input` is the
 * input the step ran with, whose values a confirm's message may name.
 */
export const keepingAcceptedConfirms =
  (decide: DialogDecider, accepted: ObservedConfirm[], input?: unknown): DialogDecider =>
  (report) =>
    decide(report).pipe(
      Effect.tap((decision) =>
        Effect.sync(() =>
          keepAcceptedConfirm(accepted, {
            event: eventOf(report),
            facts: factsOf(report),
            decision,
            input,
          }),
        ),
      ),
    );

/**
 * `ask`, watched for a question its caller left unanswered, the owner's cancel aside. A run hands
 * it to `makeRunDialogDecider`, which dismisses that dialog and goes on. This host keeps no log of
 * what the page sent, so `unanswered()` tells the run's report that a failure after it can't show
 * the write changed nothing.
 */
export const watchingUnanswered = (ask: InputAsker) => {
  let seen = false;
  const watched: InputAsker = (request, bounds) =>
    ask(request, bounds).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          if (unanswered(cause)) seen = true;
        }),
      ),
    );
  return { ask: watched, unanswered: () => seen };
};

/**
 * A run's native dialogs. A write's confirm that its build accepted, with the same message on the
 * same page origin at the same step, is accepted without asking, once per record. A message that
 * named a value of the build's input, or the page's record identifier, matches with the run's
 * `input` values, or the run's page, in their place. Any other
 * confirm in a write's run asks the caller one yes or no question (`askDialogCaller`), showing
 * the message as `project` leaves it. Every other dialog, a read run's confirms included, gets the
 * safe default without a question. A confirm whose question's window ends unanswered is
 * dismissed, never accepted, and the run goes on. The owner's cancel at the terminal, or a
 * question that cannot be asked or answered, fails the step as before.
 */
export const makeRunDialogDecider = (input: {
  readonly ask: InputAsker;
  readonly project: (text: string) => string;
  /** A read tool accepts nothing from the record. */
  readonly readOnly: boolean;
  readonly expectedConfirms?: readonly ExpectedConfirm[] | undefined;
  /** The run's input. */
  readonly input?: unknown;
  readonly incidents: IncidentStore;
}): DialogDecider => {
  // The owner's cancel is a choice to stop, never a question left unanswered.
  const ask: InputAsker = (request, bounds) =>
    input
      .ask(request, bounds)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof OwnerCancelled
            ? new InputRequestFailure({ code: "Unavailable", cause })
            : cause,
        ),
      );
  const decide = makeRunDialogDecision({
    readOnly: input.readOnly,
    expectedConfirms: input.expectedConfirms,
    input: input.input,
    askCaller: (report: Parameters<DialogDecider>[0] & { readonly candidateActionId: string }) =>
      askDialogCaller(ask, { type: report.type, message: input.project(report.message) }).pipe(
        Effect.catchIf(
          (failure) => failure.reason === "expired",
          () =>
            input.incidents
              .record({
                source: "host",
                kind: "dialog",
                reason: "dialog_decision_expired",
                hostBug: false,
                severity: "info",
                subCause: `${report.type}_dismiss`,
              })
              .pipe(Effect.as({ choice: "dismiss" as const })),
        ),
      ),
    incidents: input.incidents,
  });
  return (report) => decide({ ...report, ...eventOf(report) }, factsOf(report));
};

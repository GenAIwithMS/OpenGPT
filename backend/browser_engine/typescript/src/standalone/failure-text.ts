import {
  runOutcomeCodes,
  type FailureRenderer,
  type RunOutcome,
  type RunOutcomeCode,
} from "../runtime/run-outcome.js";

/*
 * The local failure renderer: one MCP and CLI sentence per run outcome code. A step that may
 * have committed always says to read the site back before any retry. The local host keeps no
 * idempotency key and repairs nothing, so no sentence offers either.
 */

const readBackAdvice = "read the site back before any retry";

const readBackSentence = `${readBackAdvice.charAt(0).toUpperCase()}${readBackAdvice.slice(1)}.`;

/**
 * What the outcome means for the website, then `step`: the next step when nothing changed or
 * after a read-back, or `confirmed` when the website confirmed the action. A write the website
 * confirmed is never told to run again, since that would repeat it; with a possible commit it
 * also reads the site back. A write that may have applied needs the read-back even when its code
 * carries no possible commit.
 */
const then = (outcome: RunOutcome, step: string, confirmed = "") => {
  if (outcome.writeStatus === "applied")
    return `The website confirmed the action, so running the tool again would repeat it.${outcome.possibleCommit ? ` ${readBackSentence}` : ""}${confirmed === "" ? "" : ` ${confirmed}`}`;
  if (outcome.possibleCommit || outcome.writeStatus === "may_have_applied")
    return `A step may already have changed the website, so ${readBackAdvice}. Then ${step.charAt(0).toLowerCase()}${step.slice(1)}`;
  return `Nothing changed on the website. ${step}`;
};
const detail = (outcome: RunOutcome, key: string) => {
  const value = outcome.details[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const sentences: {
  readonly [Code in RunOutcomeCode]: (outcome: RunOutcome) => {
    readonly message: string;
    readonly remediation: string;
  };
} = {
  no_response: (outcome) => ({
    message: "The run asked a question that was not answered in time, so it stopped.",
    remediation: then(outcome, "Run it again and answer its question."),
  }),
  credentials_rejected: (outcome) => {
    const field = detail(outcome, "field");
    return {
      message: `The website rejected the ${field === undefined ? "login" : field.replaceAll("_", " ")}.`,
      remediation: then(outcome, "Correct the login and run the tool again."),
    };
  },
  input_rejected: (outcome) => {
    const reason = detail(outcome, "reason");
    const available = outcome.details["available"];
    const choices = Array.isArray(available)
      ? available.filter((choice): choice is string => typeof choice === "string")
      : [];
    const field = detail(outcome, "field");
    return {
      message: `The tool or the website refused a value in the input.${reason === undefined ? "" : ` ${reason}`}${choices.length === 0 ? "" : ` Available${field === undefined ? "" : ` for ${field}`}: ${choices.join(", ")}.`}`,
      remediation: then(
        outcome,
        choices.length === 0
          ? "Correct the input and run it again."
          : "Choose one of the available values and run it again.",
      ),
    };
  },
  input_not_applied: (outcome) => {
    const [field, requested, applied, siteMessage] = [
      detail(outcome, "field"),
      detail(outcome, "requested"),
      detail(outcome, "applied"),
      detail(outcome, "site_message"),
    ];
    const value =
      requested === undefined
        ? "a value in the input"
        : `${field === undefined ? "the value" : field} ${requested}`;
    return {
      message: `The website did not apply ${value}${applied === undefined ? "" : `; the page kept ${applied}`}, so the run returned no results computed without it.${siteMessage === undefined ? "" : ` The website said: ${siteMessage}`}`,
      remediation: then(
        outcome,
        "Run it again only when the website's message points to a passing problem; otherwise change that value in the input.",
      ),
    };
  },
  login_identity_conflict: (outcome) => ({
    message: "The website signed in to a different account than the one this run expects.",
    remediation: then(outcome, "Sign in with the expected account and run the tool again."),
  }),
  website_sign_in_unavailable: (outcome) => ({
    message:
      "The website did not keep the run signed in, and signing in again was unavailable, so the run stopped.",
    remediation: then(outcome, "Run it again in a few minutes."),
  }),
  worker_lost: (outcome) => ({
    message: "The run's process ended before it finished.",
    remediation: then(outcome, "Run it again."),
  }),
  outcome_unknown: () => ({
    message:
      "The run did not confirm whether its website action took effect, so it may have changed the website.",
    remediation: `${readBackAdvice.charAt(0).toUpperCase()}${readBackAdvice.slice(1)} to see whether the action happened, and run the tool again only if it did not.`,
  }),
  invalid_output: (outcome) => ({
    message: "The run's result did not match the tool's output schema.",
    remediation: then(
      outcome,
      "Build the tool again before relying on its result.",
      "Build the tool again before relying on its result.",
    ),
  }),
  execution_failed: (outcome) => ({
    message: "The run did not produce a validated result.",
    remediation: then(outcome, "Check the local browser and the tool, then run it again."),
  }),
};

export const localFailureRenderer: FailureRenderer = {
  codes: runOutcomeCodes,
  readBackAdvice,
  render: (outcome) => ({ ...sentences[outcome.code](outcome), retry: outcome.retry }),
};

/** The local sentence for an outcome: what happened, or the host's own `lead`, then what to do. */
export const localFailureText = (outcome: RunOutcome, lead?: string) => {
  const { message, remediation } = localFailureRenderer.render(outcome);
  return `${lead ?? message} ${remediation}`;
};

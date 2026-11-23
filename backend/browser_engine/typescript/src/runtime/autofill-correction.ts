import { Effect } from "effect";
import { CredentialRejectedField, type WebsiteCredentials } from "./authentication.js";
import type { AutofillRetryState } from "./autofill-replay-steps.js";
import { logicalRejectedField } from "./autofill-rejection.js";

/** The paired form consumes only observed logical primary/password budgets and rejects old values. */
export const askCredentialCorrection = <A extends { readonly credentials: WebsiteCredentials }, E>(input: {
  readonly fields: readonly CredentialRejectedField[];
  readonly credentials: WebsiteCredentials;
  readonly rejectedValues: { readonly username: Set<string>; readonly password: Set<string> };
  readonly correctionRequests: Partial<Record<CredentialRejectedField, number>>;
  /** Asks once, saying how many tries are left with this one. */
  readonly ask: (triesLeft: number) => Effect.Effect<A | undefined, E>;
  readonly reject: (field: CredentialRejectedField) => E;
}): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const logicalFields = [
      ...new Set(
        input.fields
          .map((slot) => logicalRejectedField(slot, input.credentials.primaryIdentifierKind))
          .filter(
            (slot): slot is "username" | "password" => slot === "username" || slot === "password",
          ),
      ),
    ];
    while (logicalFields.every((field) => (input.correctionRequests[field] ?? 0) < 2)) {
      const triesLeft = Math.min(
        ...logicalFields.map((field) => 2 - (input.correctionRequests[field] ?? 0)),
      );
      for (const field of logicalFields)
        input.correctionRequests[field] = (input.correctionRequests[field] ?? 0) + 1;
      const answer = yield* input.ask(triesLeft);
      if (answer === undefined)
        return yield* Effect.fail(input.reject(input.fields[0] ?? "password"));
      const { username, password } = answer.credentials;
      if (
        !input.rejectedValues.username.has(username) &&
        (password === undefined || !input.rejectedValues.password.has(password))
      )
        return answer;
    }
    const exhausted = input.fields.find(
      (field) =>
        (input.correctionRequests[
          logicalRejectedField(field, input.credentials.primaryIdentifierKind)
        ] ?? 0) >= 2,
    );
    return yield* Effect.fail(input.reject(exhausted ?? input.fields[0] ?? "password"));
  });

/** A verified sign-in ends this sign-in's history while preserving references held by the host. */
export const resetAutofillRetryState = (state: AutofillRetryState) => {
  for (const field of CredentialRejectedField.literals) delete state.correctionRequests[field];
  for (const values of Object.values(state.rejectedValues)) values?.clear();
  for (const field of CredentialRejectedField.literals) delete state.lastFilled[field];
  state.codeRequests.current = 0;
  state.codeAttempts.current = 0;
};

/** Host-owned retry state lasts across browser rebuilds in this attempt. */
export const makeAutofillRetryState = (): AutofillRetryState & {
  rejectedValues: AutofillRetryState["rejectedValues"] & {
    username: Set<string>;
    password: Set<string>;
  };
} => ({
  rejectedValues: { username: new Set(), password: new Set() },
  lastFilled: {},
  correctionRequests: {},
  codeRequests: { current: 0 },
  codeAttempts: { current: 0 },
});
/** A primary correction replaces its explicitly typed primary value while preserving held extras. */
export const correctedReplayCredentials = (
  held: WebsiteCredentials | undefined,
  corrected: WebsiteCredentials,
): WebsiteCredentials => {
  const kind = held?.primaryIdentifierKind;
  const key = {
    email: "email",
    phone: "phone",
    account_number: "accountNumber",
    username: "username",
  } as const;
  return {
    ...held,
    ...corrected,
    ...(kind === undefined ? {} : { primaryIdentifierKind: kind, [key[kind]]: corrected.username }),
  };
};

import { Effect } from "effect";

/**
 * A native dialog a run's host settled by itself: a confirm accepted from the tool's record, a
 * confirm the host's own judgment accepted, a dialog its safe default decided, or one dismissed
 * because its decision never came. It carries
 * finite codes only, never page text.
 */
export interface DialogIncident {
  readonly source: "host";
  readonly kind: "dialog";
  readonly reason:
    | "dialog_expected_confirm_accepted"
    | "dialog_judged_confirm_accepted"
    | "dialog_default_decision"
    | "dialog_decision_expired";
  readonly hostBug: false;
  readonly severity: "info";
  /** The dialog type and the choice taken, such as `confirm_accept`. */
  readonly subCause: string;
}

/**
 * Where a host records what it settled by itself during a run, so the run's report can say so.
 * Recording never fails and never holds up the run. A host that keeps no such record passes
 * `noIncidents`.
 */
export interface IncidentStore {
  readonly record: (incident: DialogIncident) => Effect.Effect<void>;
}

/** The local host keeps no incident record: nothing is stored and no outcome mentions one. */
export const noIncidents: IncidentStore = { record: () => Effect.void };

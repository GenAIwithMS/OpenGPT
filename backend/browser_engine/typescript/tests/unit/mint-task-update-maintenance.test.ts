import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type MintDependencies,
  type TaskUpdateApplication,
  type TaskUpdateCandidate,
} from "../../src/mint/contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const site = "https://notes.example.test";
const repair = {
  mode: "maintenance",
  intent: "Read the saved notes with each note's color",
  businessInput: { day: "2026-11-01" },
  observations: [],
  siteOrigin: site,
};
const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);

const colorQuestion = {
  questions: [
    {
      id: "color",
      type: "choice" as const,
      prompt: "The notes page no longer shows a note's color. May the tool stop returning it?",
      options: [
        { id: "drop", label: "Yes, return notes without a color" },
        { id: "keep", label: "No, keep the color" },
      ],
    },
  ],
};
/** Loosening one output field of the registered contract, as a repair proposes it. */
const dropColor = {
  summary: "Return each note without its color, which the notes page no longer shows.",
  changes: [
    {
      setting: "output",
      field: "notes[].color",
      change: "remove",
      text: "The notes page no longer shows a color for any note.",
      reason: "Every note on the notes page, its detail view included, shows no color any more.",
    },
  ],
  confirmedBy: ["color"],
  recommend: "update",
};

/** A Guardian that allows every update, and a host that applies it, recording both. */
const updateHost = () => {
  const reviews: TaskUpdateCandidate[] = [];
  const applied: TaskUpdateApplication[] = [];
  const dependencies: Partial<MintDependencies> = {
    reviewTaskUpdate: (candidate) =>
      Effect.sync(() => {
        reviews.push(candidate);
        return { outcome: "allow" as const, rationale: "Confirmed.", reviewId: "review" };
      }),
    applyTaskUpdate: (application) =>
      Effect.sync(() => {
        applied.push(application);
        return { outcome: "applied" as const };
      }),
    askInput: () => Effect.succeed({ color: { type: "choice", value: "drop" } }),
  };
  return { reviews, applied, dependencies };
};

/** Runs a repair that asks the owner, then proposes `update`, and returns the update's result. */
const propose = async (
  update: object,
  dependencies: Partial<MintDependencies>,
  request: object = repair,
) => {
  const results: Record<string, unknown>[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(colorQuestion);
        results.push(JSON.parse(yield* turn.actions.updateTask!(update)));
      }),
    dependencies,
  );
  await f.run(request);
  return results[0];
};

it("applies an output change to a repaired tool's contract once its owner confirms it", async () => {
  const host = updateHost();
  const result = await propose(dropColor, {
    ...host.dependencies,
    taskUpdateConfirmer: () => Effect.succeed("owner"),
  });
  expect(result).toMatchObject({ status: "updated", task: { revision: 1 } });
  // Guardian reviewed it knowing the owner answered, then the host applied the same change.
  expect(host.reviews[0]?.update).toMatchObject({
    changes: [{ setting: "output", field: "notes[].color", change: "remove" }],
    maintenance: { confirmer: "owner" },
  });
  expect(host.applied[0]?.update.changes).toEqual(dropColor.changes);
});

it.each([
  { case: "nobody who owns the tool", confirmer: () => Effect.succeed("none" as const) },
  {
    case: "a confirmer that fails",
    confirmer: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  },
  { case: "a host without a confirmer", confirmer: undefined },
])("keeps the registered contract with $case, before any review", async ({ confirmer }) => {
  const host = updateHost();
  const result = await propose(dropColor, {
    ...host.dependencies,
    ...(confirmer === undefined ? {} : { taskUpdateConfirmer: confirmer }),
  });
  expect(result).toMatchObject({ status: "update_refused", reason: "owner_unavailable" });
  expect(host.reviews).toEqual([]);
  expect(host.applied).toEqual([]);
});

it("asks for the owner's confirmation before reviewing a contract change that cites none", async () => {
  const host = updateHost();
  const result = await propose(
    { ...dropColor, confirmedBy: [] },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({
    status: "clarification_required",
    source: "host",
    reason: "confirmation_required",
  });
  expect(host.reviews).toEqual([]);
});

// Fails when the host asks for an answer the owner's own request already gives: the owner
// asked for the change, so a question confirming it is redundant and nothing could apply it.
it("sends an output change the owner requested to Guardian without asking them again", async () => {
  const host = updateHost();
  const colorFormats = {
    summary: "Return each note's color as a name or as a hex code, as the owner asked.",
    changes: [
      {
        setting: "output",
        field: "notes[].color",
        change: "widen",
        text: "A note's color may be a name or a hex code.",
      },
    ],
    confirmedBy: [],
    recommend: "update",
  };
  const result = await propose(
    colorFormats,
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner_request") },
    {
      ...repair,
      intent: "Change the notes tool as its owner asks: return each color as a name or a hex code.",
    },
  );
  expect(result).toMatchObject({ status: "updated", task: { revision: 1 } });
  // Guardian judges the request as the confirmation, knowing the owner asked for the change.
  expect(host.reviews[0]?.update).toMatchObject({
    changes: [{ field: "notes[].color", change: "widen" }],
    confirmation: [],
    maintenance: { confirmer: "owner_request" },
  });
  expect(host.applied[0]?.update.changes).toEqual(colorFormats.changes);
});

it.each([
  { setting: "input", change: { setting: "input", values: { day: "2026-11-02" } } },
  { setting: "effect", change: { setting: "effect", effect: "write" } },
  { setting: "site", change: { setting: "site", origin: "https://notes.example.org" } },
  { setting: "login", change: { setting: "login", change: "sign_in" } },
])("refuses changing the $setting in maintenance before any review", async ({ change }) => {
  const host = updateHost();
  const result = await propose(
    { ...dropColor, changes: [dropColor.changes[0], change] },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "maintenance_setting" });
  expect(host.reviews).toEqual([]);
});

it("refuses a recommended new build in maintenance before any review", async () => {
  const host = updateHost();
  const result = await propose(
    {
      ...dropColor,
      recommend: "new_mint",
      suggestedRequest: "Read the saved notes without their colors.",
    },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "maintenance_setting" });
  expect(host.reviews).toEqual([]);
});

it("refuses an output change outside maintenance, where the build sets its own schema", async () => {
  const host = updateHost();
  const result = await propose(
    dropColor,
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
    { ...repair, mode: "mint" },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "output_outside_maintenance" });
  expect(host.reviews).toEqual([]);
});

// A repair may add an output field or tighten one without anyone's confirmation: callers keep
// everything they already receive. Guardian still reviews the change before the host applies it.
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "notes", description: "Read the saved notes with each note's color" },
  coverage: "One example ran.",
};

/** Runs a repair that proposes `update` without asking anyone, then publishes its example. */
const repairAndPublish = async (update: object, dependencies: Partial<MintDependencies>) => {
  const results: Record<string, unknown>[] = [];
  let asked = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        results.push(JSON.parse(yield* turn.actions.updateTask!(update)));
        yield* turn.actions.finish(publication);
      }),
    {
      ...dependencies,
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return {};
        }),
    },
  );
  const outcome = await f.run();
  return { result: results[0], outcome, asked };
};

it.each([
  {
    case: "adds an optional field",
    change: {
      setting: "output",
      field: "notes[].label",
      change: "add",
      text: "Each note's label as the notes page shows it, or null when the note has none.",
    },
  },
  {
    case: "tightens a nullable field to required",
    change: {
      setting: "output",
      field: "notes[].color",
      change: "tighten",
      text: "Each note's color is always returned; the notes page shows one on every note.",
    },
  },
])("publishes a repair that $case with no confirmation", async ({ change }) => {
  const host = updateHost();
  const { result, outcome, asked } = await repairAndPublish(
    { summary: change.text, changes: [change], confirmedBy: [], recommend: "update" },
    // Nobody can confirm: an addition or a tightening needs no one.
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("none") },
  );
  expect(result).toMatchObject({ status: "updated", task: { revision: 1 } });
  expect(asked).toBe(0);
  expect(host.reviews[0]?.update).toMatchObject({
    changes: [change],
    maintenance: { confirmer: "none" },
  });
  expect(host.applied[0]?.update.changes).toEqual([change]);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});

it("refuses removing an output field without a reason, before any review", async () => {
  const host = updateHost();
  const { reason: _, ...unexplained } = dropColor.changes[0]!;
  const result = await propose({ ...dropColor, changes: [unexplained] }, {
    ...host.dependencies,
    taskUpdateConfirmer: () => Effect.succeed("owner"),
  });
  expect(result).toMatchObject({ status: "update_refused", reason: "output_removal_reason" });
  expect(host.reviews).toEqual([]);
  expect(host.applied).toEqual([]);
});

it("sends a removal with its reason to Guardian, which may refuse it", async () => {
  const reason = dropColor.changes[0]!.reason;
  const reviews: TaskUpdateCandidate[] = [];
  const applied: TaskUpdateApplication[] = [];
  const result = await propose(dropColor, {
    reviewTaskUpdate: (candidate) =>
      Effect.sync(() => {
        reviews.push(candidate);
        return {
          outcome: "reword" as const,
          rationale: "The captures still show a color on each note.",
          reviewId: "review",
        };
      }),
    applyTaskUpdate: (application) =>
      Effect.sync(() => {
        applied.push(application);
        return { outcome: "applied" as const };
      }),
    askInput: () => Effect.succeed({ color: { type: "choice", value: "drop" } }),
    taskUpdateConfirmer: () => Effect.succeed("owner"),
  });
  expect(reviews[0]?.update).toMatchObject({
    changes: [{ setting: "output", field: "notes[].color", change: "remove", reason }],
    maintenance: { confirmer: "owner" },
  });
  expect(result).toMatchObject({ status: "reword" });
  expect(applied).toEqual([]);
});

it("tells Guardian who can confirm an addition, though it needs no confirmation", async () => {
  const host = updateHost();
  const { result } = await repairAndPublish(
    {
      summary: "Add each note's label.",
      changes: [
        {
          setting: "output",
          field: "notes[].label",
          change: "add",
          text: "Each note's label as the notes page shows it.",
        },
      ],
      confirmedBy: [],
      recommend: "update",
    },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner_request") },
  );
  expect(result).toMatchObject({ status: "updated" });
  expect(host.reviews[0]?.update).toMatchObject({ maintenance: { confirmer: "owner_request" } });
});

it.each(["Owner", "", undefined, null, 7])(
  "refuses a contract change as owner_unavailable when the confirmer returns %j",
  async (value) => {
    const host = updateHost();
    const result = await propose(dropColor, {
      ...host.dependencies,
      taskUpdateConfirmer: () => Effect.succeed(value as never),
    });
    expect(result).toMatchObject({ status: "update_refused", reason: "owner_unavailable" });
    expect(host.reviews).toEqual([]);
    expect(host.applied).toEqual([]);
  },
);

it("asks the host who can confirm once per update", async () => {
  const host = updateHost();
  let asked = 0;
  const result = await propose(dropColor, {
    ...host.dependencies,
    taskUpdateConfirmer: () =>
      Effect.sync(() => {
        asked += 1;
        return asked === 1 ? ("owner" as const) : ("none" as const);
      }),
  });
  expect(result).toMatchObject({ status: "updated" });
  expect(asked).toBe(1);
  expect(host.reviews[0]?.update).toMatchObject({ maintenance: { confirmer: "owner" } });
});

// A change nobody can confirm may still leave out a part of its request it can't meet, and the
// field it added for that part goes with it: the registered contract never had the field. Fails
// while the host refuses removing that field as `owner_unavailable`, which leaves the build an
// added field it must keep returning, or ending blocked.
it("lets a repair nobody can confirm remove the output field it added, and nothing registered", async () => {
  const host = updateHost();
  const label = {
    setting: "output",
    field: "notes[].label",
    change: "add",
    text: "Each note's label as the notes page shows it, or null when the note has none.",
  };
  const results: Record<string, unknown>[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        for (const update of [
          { summary: label.text, changes: [label], confirmedBy: [], recommend: "update" },
          {
            summary: "Leave out the label this build added; the rest of the request is published.",
            changes: [
              {
                setting: "output",
                field: "notes[].label",
                change: "remove",
                text: "Notes come back without the label this build added.",
                reason: "Added only for the part of the request this build leaves out.",
              },
            ],
            confirmedBy: [],
            recommend: "update",
          },
          { ...dropColor, confirmedBy: [] },
        ])
          results.push(JSON.parse(yield* turn.actions.updateTask!(update)));
      }),
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("none") },
  );
  await f.run();
  expect(results).toMatchObject([
    { status: "updated", task: { revision: 1 } },
    { status: "updated", task: { revision: 2 } },
    { status: "update_refused", reason: "owner_unavailable" },
  ]);
  // Guardian reviewed the removal knowing nobody can confirm, and the host applied it.
  expect(host.reviews[1]?.update).toMatchObject({
    changes: [{ field: "notes[].label", change: "remove" }],
    maintenance: { confirmer: "none" },
  });
  expect(host.applied).toHaveLength(2);
  // The refusal of a registered field points at leaving that part of the request out.
  expect(String(results[2]?.["instruction"])).toContain("publish the rest");
});

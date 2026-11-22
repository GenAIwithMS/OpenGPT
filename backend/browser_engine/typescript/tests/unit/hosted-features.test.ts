import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import {
  hostedFeatures,
  hostedFeaturesPreamble,
  hostedProtectionsLine,
  renderHostedFeaturesPreamble,
  renderHostedProtectionsLine,
} from "../../src/hosted-features.js";
import { loadStandaloneAuthoring, loadWorkspaceGuide } from "../../src/mint/skills.js";

const sample = [
  { id: "anti-bot", name: "Anti-bot and proxies" },
  { id: "saved-dom-tests", name: "savedDOM tests" },
] as const;

describe("hosted features the local host lacks", () => {
  it("lists each entry once, by a descriptive id a change can delete it by", () => {
    expect(hostedFeatures.length).toBeGreaterThan(0);
    expect(new Set(hostedFeatures.map(({ name }) => name)).size).toBe(hostedFeatures.length);
    expect(new Set(hostedFeatures.map(({ id }) => id)).size).toBe(hostedFeatures.length);
    for (const { id, name } of hostedFeatures) {
      expect(name).toMatch(/^\S.*\S$/u);
      expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
    }
  });

  it("renders the minter preamble as one lead sentence and one line per entry", () => {
    expect(renderHostedFeaturesPreamble(sample)).toBe(
      "These features are not available here. Please ignore these features.\n- Anti-bot and proxies\n- savedDOM tests",
    );
    expect(hostedFeaturesPreamble).toBe(renderHostedFeaturesPreamble(hostedFeatures));
  });

  it("renders the Guardian line from the same entries", () => {
    expect(renderHostedProtectionsLine(sample)).toBe(
      "These hosted protections aren't present here: anti-bot and proxies; savedDOM tests. Don't count on them.",
    );
    expect(hostedProtectionsLine).toBe(renderHostedProtectionsLine(hostedFeatures));
  });

  it("names the request list by the field the shared text uses", async () => {
    const list = hostedFeatures.filter(({ name }) => name.includes("`stateChangingRequests`"));
    expect(list).toEqual([
      {
        id: "state-changing-requests",
        name: "Per-step list of requests that could change the site (`stateChangingRequests`)",
      },
    ]);
    expect(hostedFeaturesPreamble).toContain(`\n- ${list[0]?.name}`);
    // The shared text the entry covers: the core skill's section and the write session's rule.
    const local = await Effect.runPromise(loadStandaloneAuthoring("typescript/authoring"));
    const skill = (name: string) =>
      new TextDecoder().decode(
        local.skills.find((entry) => entry.name === name)?.content as Uint8Array,
      );
    expect(skill("core")).toContain("## State-changing requests");
    expect(skill("core")).toContain("A live execute result may carry `stateChangingRequests`");
    expect(skill("writes")).toContain("Read `stateChangingRequests` on every step.");
  });

  it("renders nothing once every feature is local", () => {
    expect(renderHostedFeaturesPreamble([])).toBe("");
    expect(renderHostedProtectionsLine([])).toBe("");
  });

  it("puts the preamble on top of the local minter's AGENTS.md and nowhere else", async () => {
    const local = await Effect.runPromise(loadStandaloneAuthoring("typescript/authoring"));
    expect(local.instructions.startsWith(`${hostedFeaturesPreamble}\n\n`)).toBe(true);
    expect(local.files.get("AGENTS.md")).toBe(local.instructions);
    for (const [path, text] of local.files)
      if (path !== "AGENTS.md") expect(text).not.toContain(hostedFeaturesPreamble);
    for (const skill of local.skills)
      expect(new TextDecoder().decode(skill.content as Uint8Array)).not.toContain(
        "These features are not available here",
      );
    // A host that loads the guide itself, with or without its own render, gets no preamble.
    const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
    expect(local.instructions).toBe(`${hostedFeaturesPreamble}\n\n${guide.instructions}`);
    expect(guide.instructions).not.toContain("These features are not available here");
  });

  it("ends the local Guardian's execution policy with the Guardian line", () => {
    expect(nativeExecutionEnvironment.absentProtections).toBe(hostedProtectionsLine);
    expect(
      guardianExecutionPolicy(nativeExecutionEnvironment).endsWith(`\n${hostedProtectionsLine}`),
    ).toBe(true);
  });
});

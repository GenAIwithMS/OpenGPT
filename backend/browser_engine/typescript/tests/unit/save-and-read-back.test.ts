import { expect, it } from "vitest";
import { saveAndReadBack } from "../../src/browser/index.js";

const wanted = { square_footage: 1875, owner: "Jane Exemple", street: "123 Main St" } as const;
type Field = keyof typeof wanted;
type Shown = Partial<Record<Field, string | null>>;

/**
 * A page saved over several pages, as a site keeps it: `keep(save)` is what the site holds after
 * its `save`-th save. Each save and read is counted, in order.
 */
const site = <Held = Shown>(keep: (save: number) => Held) => {
  const calls: string[] = [];
  let saves = 0;
  return {
    calls,
    save: async () => {
      saves += 1;
      calls.push("save");
    },
    read: async () => {
      calls.push("read");
      return keep(saves);
    },
  };
};

const kept: Shown = { square_footage: "1,875", owner: "Exemple, Jane", street: "Main St 123" };

it("saves once when the site kept every value, written in its own format or word order", async () => {
  const page = site(() => kept);
  await expect(saveAndReadBack({ save: page.save, read: page.read, wanted })).resolves.toEqual([]);
  expect(page.calls).toEqual(["save", "read"]);
});

it("saves again once when the first save kept another value, and returns nothing once it holds", async () => {
  const page = site((save) => (save === 1 ? { ...kept, square_footage: "1,460" } : kept));
  await expect(saveAndReadBack({ save: page.save, read: page.read, wanted })).resolves.toEqual([]);
  expect(page.calls).toEqual(["save", "read", "save", "read"]);
});

it("stops after the second save and returns each value the site still holds differently", async () => {
  const page = site(() => ({ ...kept, square_footage: "1,460", street: "125 Main St" }));
  await expect(saveAndReadBack({ save: page.save, read: page.read, wanted })).resolves.toEqual([
    { field: "square_footage", wanted: "1875", shown: "1,460" },
    { field: "street", wanted: "123 Main St", shown: "125 Main St" },
  ]);
  expect(page.calls).toEqual(["save", "read", "save", "read"]);
});

it("saves once when a picked option reads back as the label the tool picked, which is what it wants", async () => {
  // The caller sent CA and true, and the tool picked California and Yes from the site's lists.
  const shown = { state: "California", accepts_terms: "Yes" };
  const page = site(() => shown);
  await expect(saveAndReadBack({ save: page.save, read: page.read, wanted: shown })).resolves.toEqual([]);
  expect(page.calls).toEqual(["save", "read"]);
  // Wanting the caller's own CA and true would save twice and report a write that went through.
  const short = site(() => shown);
  await expect(
    saveAndReadBack({ save: short.save, read: short.read, wanted: { state: "CA", accepts_terms: "true" } }),
  ).resolves.toEqual([
    { field: "state", wanted: "CA", shown: "California" },
    { field: "accepts_terms", wanted: "true", shown: "Yes" },
  ]);
  expect(short.calls).toEqual(["save", "read", "save", "read"]);
});

it("counts a value the read-back no longer shows as different", async () => {
  const page = site(() => ({ ...kept, owner: null }));
  const { owner: _owner, ...withoutOwner } = kept;
  const missing = site(() => withoutOwner);
  await expect(saveAndReadBack({ save: page.save, read: page.read, wanted })).resolves.toEqual([
    { field: "owner", wanted: "Jane Exemple" },
  ]);
  await expect(saveAndReadBack({ save: missing.save, read: missing.read, wanted })).resolves.toEqual([
    { field: "owner", wanted: "Jane Exemple" },
  ]);
});

it("reads nothing after a save that fails, and never saves again", async () => {
  const calls: string[] = [];
  const failing = saveAndReadBack({
    save: async () => {
      calls.push("save");
      throw new Error("save failed");
    },
    read: async () => {
      calls.push("read");
      return kept;
    },
    wanted,
  });
  await expect(failing).rejects.toThrow("save failed");
  expect(calls).toEqual(["save"]);
});

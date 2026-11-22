import { describe, expect, it } from "vitest";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";

const steps = [
  {
    page: "https://example.test/login",
    fields: [{ selector: "#user", accepts: ["username", "email"] }],
    submit: "#next",
    submittedBy: "host",
  },
  {
    page: "https://example.test/login/password",
    fields: [{ selector: "#password", slot: "password" }],
    submit: "#sign-in",
  },
] as const;
const signedIn = { selector: "#account-menu" };

/** A version 1 recipe whose last step types a code split across `count` one-character boxes. */
const boxedCodeRecipe = (count: number) => ({
  version: 1,
  steps: [
    ...steps,
    {
      page: "https://example.test/login/code",
      fields: Array.from({ length: count }, (_, at) => ({ selector: `#otp-${at + 1}`, slot: "code" })),
      submit: "#verify",
      submittedBy: "host",
    },
  ],
  signedIn,
});

describe("decodeSignInRecipe", () => {
  it.each([
    ["version 1", { version: 1, steps, signedIn }],
    [
      "version 2 with a popup and an approval",
      {
        version: 2,
        steps: [
          { ...steps[0], popup: { opener: "primary", origin: "https://auth.example.test" } },
          { page: "https://example.test/login", fields: [], approval: "email_link" },
        ],
        signedIn,
      },
    ],
    [
      "version 1 with a private answer's question selector",
      {
        version: 1,
        steps: [
          ...steps,
          {
            page: "https://example.test/challenge",
            fields: [
              { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
            ],
          },
        ],
        signedIn,
      },
    ],
    [
      "version 2 with a question selector on a secret field that is no private answer",
      {
        version: 2,
        steps: [
          {
            page: "https://example.test/login",
            fields: [{ selector: "#password", slot: "password", questionSelector: "#q" }],
            popup: { opener: "primary", origin: "https://auth.example.test" },
          },
        ],
        signedIn,
      },
    ],
    [
      "version 3, which this host wrote before it wrote question selectors in version 1 and 2",
      {
        version: 3,
        steps: [
          ...steps,
          {
            page: "https://example.test/challenge",
            fields: [
              { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
            ],
          },
        ],
        signedIn,
      },
    ],
    [
      "version 4 with a workspace step",
      {
        version: 4,
        workspace: { parent: "example.com" },
        steps: [
          { ...steps[0], page: "https://app.example.com/login" },
          { origin: "workspace", ...steps[1], page: "/login/password" },
        ],
        signedIn: { selector: "#account-menu", openPath: "/settings" },
      },
    ],
    [
      "version 5 with a screen that asks for the password again beside a code",
      {
        version: 5,
        steps: [
          ...steps,
          {
            page: "https://example.test/login/password",
            fields: [
              { selector: "#password", slot: "password" },
              { selector: "#code", slot: "code" },
            ],
            refills: ["password"],
            submit: "#sign-in",
          },
        ],
        signedIn,
      },
    ],
    [
      "version 5 with a code step its key submits",
      {
        version: 5,
        steps: [
          ...steps,
          {
            page: "https://example.test/login/code",
            fields: [{ selector: "#code", slot: "code" }],
            submitKey: "Enter",
            submittedBy: "host",
          },
        ],
        signedIn,
      },
    ],
    [
      "version 6 with a screen a covering notice's control dismissed, beside a code step its key submits",
      {
        version: 6,
        steps: [
          { ...steps[0], dismiss: "#consent-accept" },
          steps[1],
          {
            page: "https://example.test/login/code",
            fields: [{ selector: "#code", slot: "code" }],
            submitKey: "Enter",
          },
        ],
        signedIn,
      },
    ],
    ["version 1 with a code split across 7 one-character boxes", boxedCodeRecipe(7)],
    ["version 1 with a code split across 8 one-character boxes", boxedCodeRecipe(8)],
  ])("reads %s", (_name, recipe) => {
    expect(decodeSignInRecipe(JSON.stringify(recipe))).toEqual(recipe);
  });

  it("refuses a step with more fields besides its code boxes than a screen holds", () => {
    const fields = Array.from({ length: 7 }, (_, at) => ({ selector: `#f-${at}`, slot: "zip" }));
    const recipe = { version: 1, steps: [{ page: "https://example.test/login", fields }], signedIn };
    expect(decodeSignInRecipe(JSON.stringify(recipe))).toBe("invalid");
  });

  it("refuses a version it does not know, so a run never drops what that version adds", () => {
    expect(decodeSignInRecipe(JSON.stringify({ version: 9, steps, signedIn }))).toBe(
      "unknown_version",
    );
  });

  it.each([
    ["text that is no JSON", "{"],
    ["a recipe without steps", JSON.stringify({ version: 1, steps: [], signedIn })],
    ["a version that is no number", JSON.stringify({ version: "1", steps, signedIn })],
    ["a version 3 recipe without steps", JSON.stringify({ version: 3, steps: [], signedIn })],
    [
      "a version 3 question selector on a field that is no private answer",
      JSON.stringify({
        version: 3,
        steps: [
          {
            page: "https://example.test/login",
            fields: [{ selector: "#password", slot: "password", questionSelector: "#q" }],
          },
        ],
        signedIn,
      }),
    ],
    [
      "a version 4 workspace step whose page names a host",
      JSON.stringify({
        version: 4,
        workspace: { parent: "example.com" },
        steps: [{ origin: "workspace", page: "https://acme.example.com/login", fields: [] }],
        signedIn,
      }),
    ],
    [
      "a version 4 workspace step whose page is protocol-relative",
      JSON.stringify({
        version: 4,
        workspace: { parent: "example.com" },
        steps: [{ origin: "workspace", page: "//acme.example.com/login", fields: [] }],
        signedIn,
      }),
    ],
    ...[
      ["a backslash", "/\\evil.example.com/login"],
      ["a query", "/login?tenant=acme"],
      ["a fragment", "/login#password"],
      ["a dot segment", "/org/../login"],
      ["an empty segment that opens with //", "//login"],
    ].map(([name, page]) => [
      `a version 4 workspace step whose page has ${String(name)}`,
      JSON.stringify({
        version: 4,
        workspace: { parent: "example.com" },
        steps: [{ origin: "workspace", page, fields: [] }],
        signedIn,
      }),
    ]),
    [
      "a version 4 workspace step without the recipe's workspace",
      JSON.stringify({
        version: 4,
        steps: [{ origin: "workspace", page: "/login", fields: [] }],
        signedIn,
      }),
    ],
    [
      "a version 4 exact step whose page is a path",
      JSON.stringify({ version: 4, workspace: { parent: "example.com" }, steps: [{ page: "/login", fields: [] }], signedIn }),
    ],
    [
      "a version 4 parent that is not a lower-case host name",
      JSON.stringify({ version: 4, workspace: { parent: "Example.com" }, steps, signedIn }),
    ],
    ...[
      ["a submit", { submit: "#verify" }],
      ["no field", { fields: [] }],
    ].map(([name, change]) => [
      `a version 5 key-submitted step with ${String(name)}`,
      JSON.stringify({
        version: 5,
        steps: [
          {
            page: "https://example.test/login/code",
            fields: [{ selector: "#code", slot: "code" }],
            submitKey: "Enter",
            ...Object(change),
          },
        ],
        signedIn,
      }),
    ]),
    [
      "a version 5 recipe with a key this host does not know",
      JSON.stringify({ version: 5, signInOrigins: ["https://id.example.net"], steps, signedIn }),
    ],
    [
      "a version 4 recipe with a key this host does not know",
      JSON.stringify({ version: 4, signInOrigins: ["https://id.example.net"], steps, signedIn }),
    ],
    [
      "a version 4 step that refills the password",
      JSON.stringify({
        version: 4,
        steps: [
          ...steps,
          {
            page: "https://example.test/login/password",
            fields: [
              { selector: "#password", slot: "password" },
              { selector: "#code", slot: "code" },
            ],
            refills: ["password"],
          },
        ],
        signedIn,
      }),
    ],
    [
      "a version 5 step that refills the password with no second factor",
      JSON.stringify({
        version: 5,
        steps: [...steps, { ...steps[1], refills: ["password"] }],
        signedIn,
      }),
    ],
    [
      "a version 5 step that refills a field it does not take",
      JSON.stringify({
        version: 5,
        steps: [
          ...steps,
          {
            page: "https://example.test/login/code",
            fields: [{ selector: "#code", slot: "code" }],
            refills: ["password"],
          },
        ],
        signedIn,
      }),
    ],
    [
      "a version 5 step that refills a code",
      JSON.stringify({
        version: 5,
        steps: [
          ...steps,
          {
            page: "https://example.test/login/code",
            fields: [
              { selector: "#password", slot: "password" },
              { selector: "#code", slot: "code" },
            ],
            refills: ["code"],
          },
        ],
        signedIn,
      }),
    ],
    // A version 5 step key a host does not know is refused, not dropped: so a version 5 host
    // that predates `refills` refuses a recipe that refills, rather than replaying it without.
    [
      "a version 5 step with a key this host does not know",
      JSON.stringify({ version: 5, steps: [{ ...steps[0], submitAfter: 1 }], signedIn }),
    ],
    // `dismiss` is version 6's: an older version that carries it is refused, never replayed
    // without dismissing the notice.
    [
      "a version 5 step that dismisses a notice",
      JSON.stringify({ version: 5, steps: [{ ...steps[1], dismiss: "#accept" }], signedIn }),
    ],
    [
      "a version 6 step whose dismiss is its own submit",
      JSON.stringify({ version: 6, steps: [{ ...steps[1], dismiss: "#sign-in" }], signedIn }),
    ],
    [
      "a version 6 step whose dismiss is one of its fields",
      JSON.stringify({ version: 6, steps: [{ ...steps[1], dismiss: "#password" }], signedIn }),
    ],
    [
      "a version 6 step with a key this host does not know",
      JSON.stringify({ version: 6, steps: [{ ...steps[0], submitAfter: 1 }], signedIn }),
    ],
  ])("refuses %s as invalid", (_name, text) => {
    expect(decodeSignInRecipe(text)).toBe("invalid");
  });
});

describe("signInRecipe", () => {
  const recorded = {
    page: "https://example.test/login",
    fields: [
      {
        selector: "#user",
        slot: "email" as const,
        accepts: ["username", "email"] as const,
        available: { vault: ["username" as const], given: ["email" as const] },
      },
      { selector: "#password", slot: "password" as const },
    ],
    submit: "#sign-in",
    submittedBy: "host" as const,
  };

  it("names an identifier field by the kinds it accepts, never the kind or value this login sent", () => {
    expect(signInRecipe([recorded], signedIn)).toEqual({
      version: 1,
      steps: [
        {
          page: "https://example.test/login",
          fields: [
            { selector: "#user", accepts: ["username", "email"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          submittedBy: "host",
        },
      ],
      signedIn,
    });
  });

  it("writes the lowest version that holds every step", () => {
    const approval = {
      page: "https://example.test/login",
      fields: [],
      approval: "device" as const,
    };
    const answer = {
      page: "https://example.test/challenge",
      fields: [
        {
          selector: "#answer",
          slot: "private_answer" as const,
          questionSelector: "#question",
        },
      ],
    };
    expect(signInRecipe([recorded], signedIn).version).toBe(1);
    expect(signInRecipe([recorded, approval], signedIn).version).toBe(2);
    // A question selector rides in version 1 or 2, as other hosts write it; no version 3 is written.
    expect(signInRecipe([recorded, answer], signedIn).version).toBe(1);
    expect(signInRecipe([recorded, approval, answer], signedIn).version).toBe(2);
    // A private answer without a question selector needs nothing a version 1 worker lacks.
    expect(
      signInRecipe(
        [
          recorded,
          { ...answer, fields: [{ selector: "#answer", slot: "private_answer" as const }] },
        ],
        signedIn,
      ).version,
    ).toBe(1);
  });

  it("writes version 4 only for a workspace step or a workspace relation", () => {
    const shared = { ...recorded, page: "https://app.example.com/login" };
    const workspace = {
      origin: "workspace" as const,
      page: "/login/password",
      fields: [{ selector: "#password", slot: "password" as const }],
      submit: "#sign-in",
    };
    const relation = { workspace: { parent: "example.com" } };
    expect(signInRecipe([shared], signedIn, {}).version).toBe(1);
    expect(signInRecipe([shared], signedIn, relation).version).toBe(4);
    const recipe = signInRecipe([shared, workspace], signedIn, relation);
    const text = signInRecipeText(recipe);
    expect(decodeSignInRecipe(text)).toEqual(recipe);
    // The relation names the site's registrable domain and a path, never a workspace host.
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "version",
      "workspace",
      "steps",
      "signedIn",
    ]);
    expect(Object.keys((JSON.parse(text) as { steps: object[] }).steps[1] ?? {})[0]).toBe("origin");
  });

  it("writes version 5 only for a step its key submits, keeping a workspace relation", () => {
    const code = {
      page: "https://example.test/login/code",
      fields: [{ selector: "#code", slot: "code" as const }],
      submitKey: "Enter" as const,
    };
    expect(signInRecipe([recorded], signedIn).version).toBe(1);
    const recipe = signInRecipe([recorded, code], signedIn, { workspace: { parent: "example.test" } });
    expect(recipe).toMatchObject({ version: 5, workspace: { parent: "example.test" } });
    expect(recipe.steps[1]).toEqual({ ...code });
    const text = signInRecipeText(recipe);
    expect(decodeSignInRecipe(text)).toEqual(recipe);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "version",
      "workspace",
      "steps",
      "signedIn",
    ]);
  });

  it("writes version 6 only for a step that dismissed a covering notice, keeping a workspace relation, and reads it back", () => {
    const covered = { ...recorded, dismiss: "#consent-accept" };
    expect(signInRecipe([recorded], signedIn).version).toBe(1);
    const recipe = signInRecipe([covered], signedIn, { workspace: { parent: "example.test" } });
    expect(recipe).toMatchObject({ version: 6, workspace: { parent: "example.test" } });
    expect(recipe.steps[0]).toMatchObject({ dismiss: "#consent-accept" });
    const text = signInRecipeText(recipe);
    expect(decodeSignInRecipe(text)).toEqual(recipe);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "version",
      "workspace",
      "steps",
      "signedIn",
    ]);
  });

  it("holds no value, question text, label or after-submit control", () => {
    const recipe = signInRecipe(
      [
        {
          ...recorded,
          // What a host knows of a screen in memory, which never ships.
          fields: [
            {
              selector: "#user",
              slot: "email" as const,
              accepts: ["username", "email"] as const,
              questionSelector: "#not-a-private-answer",
              format: undefined,
            },
            {
              selector: "#answer",
              slot: "private_answer" as const,
              questionSelector: "#question",
              ...{ questionText: "First pet?", label: "Answer", value: "synthetic-answer" },
            },
          ],
          ...{ controls: [{ role: "button", name: "Continue as ada@example.test" }] },
        },
      ],
      signedIn,
    );
    const text = JSON.stringify(recipe);
    for (const held of ["First pet?", "Answer", "synthetic-answer", "controls", "ada@example.test"])
      expect(text).not.toContain(held);
    expect(text).not.toContain("#not-a-private-answer");
    expect(decodeSignInRecipe(text)).toEqual(recipe);
  });
});

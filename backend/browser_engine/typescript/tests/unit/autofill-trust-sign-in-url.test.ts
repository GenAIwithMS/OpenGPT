import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  inspectAutofillStep,
  untrustedTarget,
  type AutofillInspection,
  type AutofillStep,
  type FillSlot,
} from "../../src/destinations/autofill-step.js";
import { paymentFrameOrigins } from "../../src/destinations/payment-frames.js";
import { configureSiteIdentity } from "../../src/runtime/same-site.js";
import { trustableSignInUrl } from "../../src/runtime/sign-in-origins.js";

// A host may trust more sign-in addresses for a sign-in step with its own predicate
// (`trustSignInUrl`): a sign-in field then goes into a control on an address the predicate trusts.
// Core asks it only about an address it would let a host trust (`trustableSignInUrl`), never about
// a card-fill step's. Unset, only the site and its configured sign-in origins count, as before, and
// a refusal still names an unjudged origin `other` once anything was typed.

const site = "https://www.shop.example";
const signInHost = "https://login.example.net";
const otherHost = "https://auth.example.org";

const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};

/** A control as the page reports it before typing: in a frame on `frameUrl`. */
const target = (frameUrl: string, actions: readonly string[] = []) => ({
  ownerUrl: frameUrl,
  documentOrigin: URL.parse(frameUrl)?.origin ?? frameUrl,
  actions: [...actions],
  methods: actions.map(() => "post"),
  editable: true,
  control: "text" as const,
});

const described = (name: string) => ({
  tag: "INPUT",
  role: null,
  formMethod: "post",
  type: name === "password" ? "password" : "text",
  name,
  id: name,
  autocomplete: null,
  inputmode: null,
  label: name,
  placeholder: null,
  ariaLabel: null,
  text: null,
});

/** A primary tab whose inspection finds `step`'s fields, and its submit, in a frame on `frameUrl`. */
const pageWith = (
  step: AutofillStep<FillSlot>,
  frameUrl: string,
  actions: readonly string[] = [],
) => ({
  targetId: "primary",
  execute: () =>
    Effect.succeed({
      fields: step.fields.map((field) => ({
        target: target(frameUrl, actions),
        described: described(field.slot),
      })),
      submit:
        step.submit === undefined
          ? null
          : {
              target: { ...target(frameUrl, actions), control: "other" as const },
              described: described("submit"),
            },
      buttons: ["Sign in"],
      url: `${site}/sign-in`,
    }),
});

/** A host predicate that trusts `trusts` and keeps every address it was asked about. */
const predicate = (trusts: (url: URL) => boolean = () => true) => {
  const asked: string[] = [];
  return {
    asked,
    trustSignInUrl: (url: URL) => {
      asked.push(url.href);
      return trusts(url);
    },
  };
};

const inspect = (
  frameUrl: string,
  options: {
    readonly step?: AutofillStep<FillSlot>;
    readonly actions?: readonly string[];
    readonly trustSignInUrl?: (url: URL) => boolean;
    readonly authenticationOrigins?: readonly string[];
    readonly judgedBeforeTyping?: readonly string[];
  } = {},
) => {
  const step = options.step ?? signInStep;
  return Effect.runPromise(
    inspectAutofillStep({
      step,
      page: pageWith(step, frameUrl, options.actions),
      siteOrigin: site,
      authenticationOrigins: options.authenticationOrigins ?? [],
      ...(options.trustSignInUrl === undefined ? {} : { trustSignInUrl: options.trustSignInUrl }),
      ...(options.judgedBeforeTyping === undefined
        ? {}
        : { judgedBeforeTyping: options.judgedBeforeTyping }),
    }),
  );
};

const refusedCheck = (report: object) =>
  "failureDetail" in report &&
  typeof report.failureDetail === "object" &&
  report.failureDetail !== null &&
  "context" in report.failureDetail
    ? report.failureDetail.context
    : undefined;

describe("a host's own trust of sign-in addresses", () => {
  it("refuses a sign-in form on another site's host unless the host's predicate trusts it", async () => {
    const unset = await inspect(`${signInHost}/u/login`);
    expect(unset).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(refusedCheck(unset)).toMatchObject({ check: "destination", part: "frame" });
    const host = predicate();
    const set = await inspect(`${signInHost}/u/login`, {
      actions: [`${otherHost}/session`],
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(set).not.toHaveProperty("outcome");
    // The inspection keeps the predicate, for the fill to ask again.
    expect(set).toMatchObject({ authenticationOrigins: [] });
    expect("trustSignInUrl" in set && set.trustSignInUrl).toBe(host.trustSignInUrl);
    // Asked about each address off the site: the frame, its document and the form's action.
    expect(new Set(host.asked)).toEqual(
      new Set([`${signInHost}/u/login`, `${signInHost}/`, `${otherHost}/session`]),
    );
  });

  it("refuses what the host's predicate does not trust", async () => {
    const host = predicate((url) => url.origin === signInHost);
    const report = await inspect(`${signInHost}/u/login`, {
      actions: [`${otherHost}/session`],
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "form_action" });
  });

  it("never asks the predicate about the site or a configured sign-in origin", async () => {
    const host = predicate();
    const report = await inspect(`${signInHost}/u/login`, {
      actions: [`${site}/session`],
      authenticationOrigins: [signInHost],
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(report).not.toHaveProperty("outcome");
    expect(host.asked).toEqual([]);
  });

  it("returns the same inspection as before when the host leaves it unset", async () => {
    const before = await inspect(`${site}/sign-in`);
    expect(before).not.toHaveProperty("outcome");
    expect(Object.keys(before)).not.toContain("trustSignInUrl");
    const set = await inspect(`${site}/sign-in`, { trustSignInUrl: predicate().trustSignInUrl });
    expect(Object.keys(set).filter((key) => key !== "trustSignInUrl")).toEqual(Object.keys(before));
  });

  it.each([
    ["plain http", "http://login.example.net/u/login"],
    ["an IPv4 address", "https://203.0.113.7/u/login"],
    ["an IPv6 address", "https://[2001:db8::1]/u/login"],
    ["localhost", "https://localhost/u/login"],
    ["a bare public suffix", "https://github.io/u/login"],
    ["an address carrying a user name and password", "https://user:secret@login.example.net/u"],
    ["an address carrying a password alone", "https://:secret@login.example.net/u/login"],
    ["an address carrying a user name alone", "https://user@login.example.net/u/login"],
    // Names only a private network resolves, whose top-level label no public suffix list holds.
    ["a .localhost host", "https://foo.localhost/u/login"],
    ["a .internal host", "https://metadata.google.internal/u/login"],
    ["a .local host", "https://x.local/u/login"],
    ["a .test host", "https://a.test/u/login"],
    ["an .invalid host", "https://a.invalid/u/login"],
    // Names the public suffix list holds as ICANN, yet no public website signs in under.
    ["a .home.arpa host", "https://printer.home.arpa/u/login"],
    ["an .in-addr.arpa host", "https://7.113.0.203.in-addr.arpa/u/login"],
    ["an .onion host", "https://exampleexampleexample.onion/u/login"],
    // Trailing dots, which the public suffix list's lookup ignores, hide no top-level label.
    ["a .home.arpa host with a trailing dot", "https://printer.home.arpa./u/login"],
    ["an .onion host with two trailing dots", "https://exampleexampleexample.onion../u/login"],
    ["an .onion host with percent-encoded dots", "https://exampleexampleexample.onion%2E%2E/u/login"],
  ])(
    "still refuses a sign-in form on %s, never asking the host's predicate",
    async (_, frameUrl) => {
      const host = predicate();
      expect(await inspect(frameUrl, { trustSignInUrl: host.trustSignInUrl })).toMatchObject({
        outcome: "refused",
        reason: "credential_target_refused",
      });
      expect(host.asked).toEqual([]);
    },
  );

  it.each([
    ["https://login.example.net/u/login", true],
    ["https://login.example.co.uk/u/login", true],
    ["https://tenant.github.io/u/login", true],
    ["https://login.example.net:8443/u/login", true],
    ["https://:secret@login.example.net/u/login", false],
    ["https://user@login.example.net/u/login", false],
    ["https://metadata.google.internal/", false],
    ["https://printer.home.arpa/", false],
    ["https://exampleexampleexample.onion/", false],
    ["https://exampleexampleexample.onion../", false],
    ["https://printer.home.arpa./", false],
  ])("lets a host trust %s: %s", (value, trustable) => {
    expect(trustableSignInUrl(new URL(value))).toBe(trustable);
  });

  it("still refuses a form that posts to plain http whatever the host trusts", async () => {
    const report = await inspect(`${signInHost}/u/login`, {
      actions: ["http://plain.example.net/session"],
      trustSignInUrl: predicate().trustSignInUrl,
    });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "form_action" });
  });

  it("names an unjudged origin other once anything was typed, whatever the host trusts", async () => {
    const report = await inspect(`${signInHost}/u/login`, {
      actions: ["http://plain.example.net/session"],
      trustSignInUrl: predicate().trustSignInUrl,
      judgedBeforeTyping: [],
    });
    expect(refusedCheck(report)).toMatchObject({
      check: "destination",
      part: "form_action",
      frameOrigin: "other",
      documentOrigin: "other",
      actionOrigins: "other",
    });
  });

  it("refuses, as untrusted, what a predicate that throws was asked about", async () => {
    const report = await inspect(`${signInHost}/u/login`, {
      trustSignInUrl: () => {
        throw new Error("synthetic predicate failure");
      },
    });
    expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "frame" });
  });

  it("refuses a sign-in popup on another site's host when the predicate asked about it throws", async () => {
    const report = await inspect(`${site}/sign-in`, {
      step: { ...signInStep, popup: { opener: "primary", origin: signInHost } },
      trustSignInUrl: () => {
        throw new Error("synthetic predicate failure");
      },
    });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "popup" });
  });

  it.each([
    ["plain http", "http://login.example.net"],
    ["an IP address", "https://203.0.113.7"],
  ])("refuses a sign-in popup at %s whatever the host trusts", async (_, origin) => {
    const host = predicate();
    const report = await inspect(`${site}/sign-in`, {
      step: { ...signInStep, popup: { opener: "primary", origin } },
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "popup" });
    expect(host.asked).toEqual([]);
  });

  it("trusts a sign-in popup on another site's host only when the host's predicate does", async () => {
    const popupStep: AutofillStep = {
      ...signInStep,
      popup: { opener: "primary", origin: signInHost },
    };
    const unset = await inspect(`${signInHost}/u/login`, { step: popupStep });
    expect(refusedCheck(unset)).toMatchObject({ check: "destination", part: "popup" });
    const refusing = await inspect(`${signInHost}/u/login`, {
      step: popupStep,
      trustSignInUrl: () => false,
    });
    expect(refusedCheck(refusing)).toMatchObject({ check: "destination", part: "popup" });
    const set = await inspect(`${signInHost}/u/login`, {
      step: popupStep,
      trustSignInUrl: predicate().trustSignInUrl,
    });
    expect(set).not.toHaveProperty("outcome");
  });
});

// An identifier-first sign-in types the identifier on one screen, then the site hands off to a
// password screen on a host no inspection judged before typing. The host learns, by origin alone,
// each host its own predicate trusted (`trustedSignInOrigins`), since its refusal evidence still
// names such a host `other`. Credentials still go only to the site, its configured sign-in origins
// and what the predicate trusts within core's floor.
describe("a sign-in host first reached after typing", () => {
  const passwordStep: AutofillStep = {
    fields: [{ selector: "#password", slot: "password" }],
    submit: "#sign-in",
  };
  const afterTyping = { step: passwordStep, judgedBeforeTyping: [site] };

  it("names, by origin, the password screen's host the predicate trusted after typing", async () => {
    const host = predicate();
    const report = await inspect(`${signInHost}/u/password?state=synthetic`, {
      ...afterTyping,
      actions: [`${signInHost}/session`],
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(report).not.toHaveProperty("outcome");
    expect(report).toMatchObject({ trustedSignInOrigins: [signInHost] });
    expect(host.asked).toContain(`${signInHost}/u/password?state=synthetic`);
  });

  it("refuses that screen without a predicate, as before, naming its host other", async () => {
    const report = await inspect(`${signInHost}/u/password`, {
      ...afterTyping,
      actions: [`${signInHost}/session`],
    });
    expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(refusedCheck(report)).toMatchObject({
      check: "destination",
      part: "frame",
      frameOrigin: "other",
    });
    expect(report).not.toHaveProperty("trustedSignInOrigins");
  });

  it.each([
    ["plain http", "http://login.example.net/u/password"],
    ["an IP address", "https://203.0.113.7/u/password"],
    ["a private network name", "https://login.corp.local/u/password"],
    ["localhost", "https://localhost/u/password"],
  ])(
    "refuses a password screen on %s after typing whatever the predicate trusts",
    async (_, frameUrl) => {
      const host = predicate();
      const report = await inspect(frameUrl, {
        ...afterTyping,
        trustSignInUrl: host.trustSignInUrl,
      });
      expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
      expect(refusedCheck(report)).toMatchObject({ check: "destination", frameOrigin: "other" });
      expect(report).not.toHaveProperty("trustedSignInOrigins");
      expect(host.asked).toEqual([]);
    },
  );

  it("names only what the predicate trusted, never the site or a configured sign-in origin", async () => {
    const popupStep: AutofillStep = {
      ...passwordStep,
      popup: { opener: "primary", origin: "https://popup.example.com" },
    };
    const report = await inspect(`${signInHost}/u/password`, {
      ...afterTyping,
      step: popupStep,
      actions: [`${site}/session`, `${otherHost}/session`],
      authenticationOrigins: [signInHost],
      trustSignInUrl: predicate().trustSignInUrl,
    });
    expect(report).toMatchObject({
      trustedSignInOrigins: ["https://auth.example.org", "https://popup.example.com"],
    });
  });

  it("names nothing when the predicate trusted nothing", async () => {
    const report = await inspect(`${signInHost}/u/password`, {
      ...afterTyping,
      authenticationOrigins: [signInHost],
      trustSignInUrl: predicate().trustSignInUrl,
    });
    expect(report).not.toHaveProperty("outcome");
    expect(report).not.toHaveProperty("trustedSignInOrigins");
  });

  it("names nothing a predicate that throws was asked about", async () => {
    const report = await inspect(`${signInHost}/u/password`, {
      ...afterTyping,
      actions: [`${otherHost}/session`],
      trustSignInUrl: (url) => {
        if (url.origin === signInHost) return true;
        throw new Error("synthetic predicate failure");
      },
    });
    expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(report).not.toHaveProperty("trustedSignInOrigins");
  });
});

describe("card fields when the host trusts more sign-in addresses", () => {
  const host = predicate();
  const trust = {
    siteOrigin: site,
    authenticationOrigins: [],
    paymentFrameOrigins,
    trustSignInUrl: host.trustSignInUrl,
  };
  const cardStep = (...slots: FillSlot[]): AutofillStep<FillSlot> => ({
    fields: slots.map((slot, index) => ({ selector: `#field-${index}`, slot })),
  });

  it("refuses a card field in a frame off the payment processors' list", () => {
    expect(
      untrustedTarget(
        { fields: [target("https://pay.example.net/card.html")], submit: null },
        cardStep("card_number"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(host.asked).toEqual([]);
  });

  it("trusts no other field of a card step on another site's host", () => {
    expect(
      untrustedTarget(
        {
          fields: [target(`${site}/checkout`), target(`${signInHost}/u/login`)],
          submit: null,
        },
        cardStep("card_number", "zip"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused", target: 1 });
    expect(host.asked).toEqual([]);
  });

  it("trusts no sign-in field of a step with a card field after it", () => {
    expect(
      untrustedTarget(
        {
          fields: [target(`${signInHost}/u/login`), target(`${site}/checkout`)],
          submit: null,
        },
        cardStep("password", "card_number"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused", target: 0 });
    expect(host.asked).toEqual([]);
  });

  it("refuses a card step's page off the site, as before, and keeps no predicate", async () => {
    const step = cardStep("card_number");
    const page = (url: string) => ({
      targetId: "primary",
      execute: () =>
        Effect.succeed({
          fields: [
            { target: target(paymentFrameOrigins[0] ?? site), described: described("number") },
          ],
          submit: null,
          buttons: [],
          url,
        }),
    });
    const card = (url: string) =>
      Effect.runPromise(
        inspectAutofillStep({
          step,
          page: page(url),
          siteOrigin: site,
          authenticationOrigins: [],
          paymentFrameOrigins,
          trustSignInUrl: host.trustSignInUrl,
        }),
      );
    expect(await card(`${signInHost}/checkout`)).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
    });
    expect(Object.keys(await card(`${site}/checkout`))).not.toContain("trustSignInUrl");
    expect(host.asked).toEqual([]);
  });
});

describe("the fill's judgment when a control moves", () => {
  const passwordStep: AutofillStep = { fields: [{ selector: "#password", slot: "password" }] };
  const password = "synthetic-password";

  /**
   * The password field, found on `signInHost`, then moved by the page into a frame on `movedTo`
   * when the fill's first call looks for it: the fill judges it again by the inspection's rule.
   */
  const fillMoved = (
    trust: Pick<AutofillInspection, "authenticationOrigins" | "trustSignInUrl">,
    movedTo = `${otherHost}/password`,
  ) => {
    const typed: string[] = [];
    let calls = 0;
    const inspection: AutofillInspection = {
      page: `${signInHost}/u/login`,
      targets: { fields: [target(`${signInHost}/u/login`)], submit: null },
      siteOrigin: site,
      ...trust,
      screen: { origin: signInHost, fields: [], submit: null, buttons: [] },
    };
    const report = Effect.runPromise(
      fillAutofillStep({
        step: passwordStep,
        values: [password],
        inspection,
        settleMs: 0,
        page: {
          targetId: "primary",
          execute: () =>
            Effect.sync(() => {
              calls += 1;
              if (calls === 1)
                return {
                  changed: { fields: [target(movedTo)], submit: null },
                  url: movedTo,
                };
              return calls === 2
                ? { focused: true, url: movedTo }
                : { submit: "none", url: movedTo };
            }),
        },
        keyboard: {
          insertText: (_target, text) =>
            Effect.sync(() => {
              typed.push(text);
              return "inserted" as const;
            }),
        },
      }),
    );
    return { report, typed };
  };

  it("types into a field the page moved to another site's host the inspection's predicate trusts", async () => {
    const host = predicate();
    const { report, typed } = fillMoved({
      authenticationOrigins: [],
      trustSignInUrl: host.trustSignInUrl,
    });
    expect(await report).toMatchObject({ outcome: "filled", trustedSignInOrigins: [otherHost] });
    expect(typed).toEqual([password]);
    expect(host.asked).toContain(`${otherHost}/password`);
  });

  it("names nothing when the page moved the field within what the inspection trusted", async () => {
    const { report, typed } = fillMoved(
      { authenticationOrigins: [signInHost], trustSignInUrl: predicate().trustSignInUrl },
      `${signInHost}/password`,
    );
    const filled = await report;
    expect(filled).toMatchObject({ outcome: "filled" });
    expect(filled).not.toHaveProperty("trustedSignInOrigins");
    expect(typed).toEqual([password]);
  });

  it.each([
    { case: "its predicate refuses", trustSignInUrl: (url: URL) => url.origin === signInHost },
    { case: "it has no predicate", trustSignInUrl: undefined },
    {
      case: "its predicate throws",
      trustSignInUrl: (url: URL) => {
        if (url.origin === signInHost) return true;
        throw new Error("synthetic predicate failure");
      },
    },
  ])("refuses that field, typing nothing, when $case", async ({ trustSignInUrl }) => {
    const { report, typed } = fillMoved({
      authenticationOrigins: [signInHost],
      ...(trustSignInUrl === undefined ? {} : { trustSignInUrl }),
    });
    expect(await report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(typed).toEqual([]);
  });

  it.each([
    ["plain http", "http://auth.example.org/password"],
    ["an IP address", "https://203.0.113.7/password"],
    ["localhost", "https://localhost/password"],
  ])(
    "refuses a field the page moved to %s, typing nothing, whatever the predicate trusts",
    async (_, movedTo) => {
      const host = predicate();
      const { report, typed } = fillMoved(
        { authenticationOrigins: [], trustSignInUrl: host.trustSignInUrl },
        movedTo,
      );
      expect(await report).toMatchObject({
        outcome: "refused",
        reason: "credential_target_refused",
      });
      expect(typed).toEqual([]);
      expect(host.asked.filter((url) => new URL(url).origin === new URL(movedTo).origin)).toEqual(
        [],
      );
    },
  );
});

// Where a sign-in's values may be typed follows the site identity: with a host's added private
// suffix, a sibling subdomain below it is another site, and the host types nothing there.
describe("the credential gate under a host's added private suffixes", () => {
  const alpha = "https://alpha.apps.example.test";
  const inspectOn = (frameUrl: string) => {
    const page = pageWith(signInStep, frameUrl);
    return Effect.runPromise(
      inspectAutofillStep({
        step: signInStep,
        page: { ...page, execute: () => page.execute().pipe(Effect.map((found) => ({ ...found, url: frameUrl }))) },
        siteOrigin: alpha,
        authenticationOrigins: [],
      }),
    );
  };
  afterEach(() => {
    configureSiteIdentity({});
  });

  it("types into a sibling subdomain's form only while no added suffix splits them", async () => {
    expect(await inspectOn("https://beta.apps.example.test/sign-in")).not.toHaveProperty("outcome");
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    const report = await inspectOn("https://beta.apps.example.test/sign-in");
    expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "frame" });
  });

  it("still types on the site's own subdomains under an added suffix", async () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(await inspectOn("https://login.alpha.apps.example.test/sign-in")).not.toHaveProperty(
      "outcome",
    );
  });
});

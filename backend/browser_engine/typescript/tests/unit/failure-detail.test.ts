import { Data, Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  describeError,
  failureDetail,
  failureDetailBounds,
  failureDetailMetadata,
  failureDetailOf,
  redactDiagnosticText,
} from "../../src/runtime/failure-detail.js";
import { MintFailure } from "../../src/mint/contracts.js";

class StorageFailure extends Data.TaggedError("StorageFailure")<{
  readonly code: string;
  readonly storage: { readonly phase: string; readonly category: string };
  readonly password?: string;
}> {}

describe("failure detail", () => {
  // Members of the shared credential policy's name lists that no canary row carries.
  it.each([
    ["JSON passphrase", '{"passphrase":"json-phrase"}', "json-phrase"],
    ["SecretBinary", '{"SecretBinary":"YmluYXJ5LXNlY3JldA=="}', "YmluYXJ5LXNlY3JldA=="],
  ])("redacts a real credential: %s", (_label, text, secret) => {
    expect(redactDiagnosticText(text)).not.toContain(secret);
  });

  it("never lets a cut token fragment escape redaction", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    for (let offset = 0; offset < token.length; offset++) {
      const text = `${"x ".repeat((64 * 1024 - offset) / 2)}${token}`;
      const redacted = redactDiagnosticText(text, 70_000);
      expect(redacted).not.toContain("ghp_");
    }
    const started = performance.now();
    redactDiagnosticText(`${"a_b".repeat(30_000)} password=x`, 1_024);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("screens text of any length without cutting it when the caller keeps the whole text", () => {
    const filler = "ordinary words ".repeat(20_000);
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA".repeat(6_000)}\n-----END RSA PRIVATE KEY-----`;
    const text = `password=first-secret-1 ${filler}Authorization: Bearer abcdefgh12345678\n${filler}${key}\n${filler}password=last-secret-9`;
    expect(text.length).toBeGreaterThan(400_000);
    const redacted = redactDiagnosticText(text, Number.POSITIVE_INFINITY);
    expect(redacted).not.toMatch(/first-secret-1|abcdefgh12345678|MIIEowIBAAKCAQEA|last-secret-9/);
    expect(redacted).toContain("password=[redacted] ordinary words");
    expect(redacted.endsWith("password=[redacted]")).toBe(true);
    expect(redacted).toContain("[redacted_private_key]");
    // The prose is whole: only the credentials were replaced.
    expect(redacted.split("ordinary words ").length).toBe(text.split("ordinary words ").length);
    // A bounded caller still cuts its input first.
    expect(redactDiagnosticText(text, 1_024).length).toBeLessThan(1_100);
  });

  it("preserves a URL across diagnostic input and output bounds", () => {
    const url = `https://ada@site.example/path/${"x".repeat(1_100)}?password=raw#end`;
    const route = `/api/results/${"x".repeat(1_100)}?token=raw#end`;
    expect(redactDiagnosticText(`password=outside ${url}`)).toContain(url);
    expect(redactDiagnosticText(`password=outside ${"padding ".repeat(9_000)} ${url}`)).toContain(
      url,
    );
    expect(redactDiagnosticText(`password=outside ${url}`)).not.toContain("password=outside");
    expect(redactDiagnosticText(route)).toBe(route);
    const detail = failureDetail("origin_url_invalid", { context: { url, route } });
    expect(detail.context).toMatchObject({ url, route });
    expect(failureDetailMetadata({ failureDetail: detail })?.failureDetail.context).toMatchObject({
      url,
      route,
    });
    const oversizedUrl = `https://site.example/path/${"x".repeat(17_000)}?token=raw#end`;
    const oversized = failureDetail("origin_url_invalid", { context: { url: oversizedUrl } });
    expect(
      failureDetailMetadata({ failureDetail: oversized })?.failureDetail.context?.["url"],
    ).toBe(oversizedUrl);
  });

  it("keeps every field, masking only a credential value by its key's structure", () => {
    const error = Object.assign(new Error("request failed"), {
      options: {
        clientAuth: "kept-auth",
        pageToken: "kept-token",
        refreshToken: "masked-refresh",
        retries: 2,
      },
      token: "kept-top-token",
      password: "masked-password",
      headers: { authorization: "Bearer masked-bearer-0123456789abcdef", accept: "json" },
      credentials: { accessKeyId: "AKIA-visible-id", secretAccessKey: "masked-secret-key" },
    });
    const detail = failureDetail("credential_connector_failed", {
      error,
      context: { secretAccessKey: "masked-context", pgPassword: "masked-pg", region: "us" },
    });
    expect(detail.underlying?.fields).toMatchObject({
      options_clientAuth: "kept-auth",
      options_pageToken: "kept-token",
      options_refreshToken: "[redacted]",
      options_retries: 2,
      token: "kept-top-token",
      password: "[redacted]",
      headers_accept: "json",
      credentials_accessKeyId: "AKIA-visible-id",
      credentials_secretAccessKey: "[redacted]",
    });
    expect(detail.underlying?.fields?.["headers_authorization"]).toMatch(/^Bearer \[redacted/u);
    expect(detail.context).toEqual({
      secretAccessKey: "[redacted]",
      pgPassword: "[redacted]",
      region: "us",
    });
    expect(JSON.stringify(failureDetailMetadata({ failureDetail: detail }))).not.toMatch(/masked-/);
  });

  it("keeps the outermost causes up to the chain depth", () => {
    const depth = failureDetailBounds.chainDepth;
    const nested = Array.from({ length: depth }, (_, index) => depth - index).reduce<Error>(
      (cause, index) => new Error(`cause-${index}`, { cause }),
      new Error(`cause-${depth + 1}`),
    );
    expect(describeError(new Error("outer", { cause: nested })).causeChain).toHaveLength(depth);
    const detail = failureDetail("dependency_failed", {
      error: new Error("outer", { cause: nested }),
    });
    expect(detail.causeChain?.map((entry) => entry.message)).toEqual(
      Array.from({ length: depth }, (_, index) => `cause-${index + 1}`),
    );
    // A wrapped failure's own detail goes beneath the new one, within the same depth.
    const wrapped = failureDetail("dependency_failed", {
      error: Object.assign(new Error("wrapper"), { failureDetail: detail }),
    });
    expect(wrapped.causeChain?.map((entry) => entry.message)).toEqual([
      "outer",
      ...Array.from({ length: depth - 1 }, (_, index) => `cause-${index + 1}`),
    ]);
  });

  const jsonSyntaxError = (text: string) => {
    try {
      JSON.parse(text);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("keeps a JSON parse message's excerpt, masking a credential the excerpt quotes", () => {
    // Error detail is kept whole; only credentials are masked.
    const kept = describeError(jsonSyntaxError('{"status":"succeeded","note": zq-canary}'));
    expect(kept.underlying?.name).toBe("SyntaxError");
    expect(kept.underlying?.message).toContain("zq-canary");
    // V8 cuts the excerpt inside the key, so the rule reads the fragment that ends `password`.
    const cut = describeError(jsonSyntaxError('{"status":"succeeded","password": hunter2-canary}'));
    expect(cut.underlying?.message).toMatch(/^Unexpected token 'h', \.\.\."assword": \[redacted\]/);
    expect(JSON.stringify(cut)).not.toContain("hunter2");
    const whole = describeError(jsonSyntaxError('{"password": secret-in-json}'));
    expect(whole.underlying?.message).toContain("[redacted]");
    expect(JSON.stringify(whole)).not.toContain("secret-in");
    // A key fragment that ends no password name keeps its value.
    expect(
      describeError(jsonSyntaxError('{"status":"succeeded","record": zq-kept}')).underlying
        ?.message,
    ).toContain("zq-kept");
  });

  it("keeps a Schema parse error's whole message: real keys, kinds and actual values", () => {
    const Stored = Schema.parseJson(
      Schema.Struct({ vault: Schema.Struct({ seed: Schema.Number }) }),
    );
    const decodeError = (text: string) => {
      const result = Schema.decodeUnknownEither(Stored, { onExcessProperty: "error" })(text);
      if (Either.isRight(result)) throw new Error("expected a parse failure");
      return result.left;
    };
    const canary = "zq8-canary-4f1e-value";
    const wrongType = failureDetail("dependency_failed", {
      operation: "vault.decode",
      error: decodeError(`{"vault": {"seed": "${canary}"}}`),
    }).underlying;
    expect(wrongType).toMatchObject({ source: "effect", name: "ParseError" });
    expect(wrongType?.message).toContain('["vault"]');
    expect(wrongType?.message).toContain(
      `["seed"]\n               └─ Expected number, actual "${canary}"`,
    );
    // A transformation keeps its nested JSON.parse message and excerpt.
    expect(
      failureDetail("dependency_failed", { error: decodeError(`{"vault": {"seed": ${canary}}}`) })
        .underlying?.message,
    ).toMatch(/Transformation process failure\n\s+└─ Unexpected token 'z', .*zq8-canary/);
    // An excess property keeps the key the input used.
    expect(
      failureDetail("dependency_failed", {
        error: decodeError(`{"vault": {"seed": 1, "${canary}": 2}}`),
      }).underlying?.message,
    ).toContain(`["${canary}"]\n               └─ is unexpected, expected: "seed"`);
  });

  it("masks parse values beneath a credential-named key and keeps every other value", () => {
    const Login = Schema.Struct({
      username: Schema.String,
      password: Schema.Number,
      credentials: Schema.Struct({ code: Schema.Number }),
    });
    const result = Schema.decodeUnknownEither(Login, { errors: "all" })({
      username: 5,
      password: "hunter2-canary",
      credentials: { code: "code-canary-77" },
    });
    if (Either.isRight(result)) throw new Error("expected a parse failure");
    const detail = failureDetail("dependency_failed", {
      operation: "login.decode",
      error: result.left,
    });
    expect(detail.underlying?.message).toContain('["username"]\n│  └─ Expected string, actual 5');
    expect(detail.underlying?.message).toContain(
      '["password"]\n│  └─ Expected number, actual [redacted]',
    );
    expect(detail.underlying?.message).toContain(
      '["code"]\n         └─ Expected number, actual [redacted]',
    );
    expect(JSON.stringify(detail)).not.toMatch(/hunter2-canary|code-canary-77/);
  });

  it("keeps a parse error once, not again as the fiber failure that carried it", async () => {
    const canary = "zq8-canary-fiber-7a2c";
    const Seed = Schema.Struct({ seed: Schema.Number });
    // `decodeUnknownPromise` rejects with the fiber failure its own run throws.
    const rejected = await Schema.decodeUnknownPromise(Seed)({ seed: canary }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const viaTryPromise = await Effect.runPromise(
      Effect.flip(Effect.tryPromise(() => Schema.decodeUnknownPromise(Seed)({ seed: canary }))),
    );
    for (const error of [new Error("outer", { cause: rejected }), viaTryPromise]) {
      const detail = failureDetail("dependency_failed", { operation: "seed.decode", error });
      const quoting = (detail.causeChain ?? []).filter((entry) => entry.message?.includes(canary));
      expect(quoting).toEqual([
        expect.objectContaining({
          name: "ParseError",
          message: `{ readonly seed: number }\n└─ ["seed"]\n   └─ Expected number, actual "${canary}"`,
        }),
      ]);
    }
  });

  it("keeps record keys taken from the input", () => {
    const canary = "zq8-canary-key-51b0";
    const Headers = Schema.Struct({
      declared: Schema.Record({ key: Schema.String, value: Schema.Number }),
    });
    const result = Schema.decodeUnknownEither(Headers)({ declared: { [canary]: "x" } });
    if (Either.isRight(result)) throw new Error("expected a parse failure");
    const detail = failureDetail("dependency_failed", { error: result.left });
    expect(detail.underlying?.message).toContain(
      `["${canary}"]\n         └─ Expected number, actual "x"`,
    );
  });

  it("describes a value that throws on inspection instead of throwing", () => {
    const hostile = new Proxy(
      {},
      {
        has: () => {
          throw new Error("hostile has");
        },
        get: () => {
          throw new Error("hostile get");
        },
      },
    );
    expect(() => failureDetail("dependency_failed", { error: hostile })).not.toThrow();
  });

  it("keeps a failure's own detail beneath the fiber failure that Effect.runPromise throws", async () => {
    const inner = new StorageFailure({
      code: "Unavailable",
      storage: { phase: "put", category: "network" },
    });
    const wrapped = Object.assign(new Error("store unavailable"), {
      failureDetail: failureDetail("job_storage_failed", {
        operation: "jobs.put",
        error: inner,
        context: { jobId: "job-1" },
      }),
    });
    const thrown = await Effect.runPromise(Effect.fail(wrapped)).then(
      () => undefined,
      (error: unknown) => error,
    );
    const detail = failureDetail("worker_dependency_failed", { operation: "outer", error: thrown });
    expect(detail.underlying?.message).toBe("store unavailable");
    expect(detail.causeChain?.[0]).toMatchObject({ name: "StorageFailure", code: "Unavailable" });
    expect(detail.context).toEqual({ jobId: "job-1" });
  });

  it.each(['{"a":\n  at zq9}', "\n    at zq9"])(
    "reads no frame from a parse excerpt line that looks like one (%j)",
    (text) => {
      const caught = jsonSyntaxError(text);
      const described = describeError(caught);
      expect(described.stack?.length).toBeGreaterThan(0);
      expect(JSON.stringify(described.stack)).not.toContain("zq9");
      expect(described.underlying?.message).toContain("zq9");
      // A wrapper keeps the inner stack, so the built detail's frames must be clean too.
      const inner = failureDetail("worker_dependency_failed", { error: caught });
      const outer = failureDetail("mint_host_dependency_failed", {
        error: Object.assign(new Error("wrapped"), { failureDetail: inner }),
      });
      expect(JSON.stringify(inner.stack)).not.toContain("zq9");
      expect(JSON.stringify(outer.stack)).not.toContain("zq9");
    },
  );

  it("reads frames only after a multi-line message of any error", () => {
    const error = new Error("first line\n    at private-canary (typescript/src/x.ts:1:1)");
    const described = describeError(error);
    expect(described.stack?.[0]).toContain("tests/unit/failure-detail.test.ts");
    expect(JSON.stringify(described.stack)).not.toContain("private-canary");
  });

  it("names the caller as the site when a shared helper builds the detail", () => {
    const helper = () => failureDetail("dependency_failed", { helperFrames: 1 });
    const direct = failureDetail("dependency_failed");
    const viaHelper = helper();
    expect(direct.site).toContain("tests/unit/failure-detail.test.ts");
    expect(viaHelper.site).toContain("tests/unit/failure-detail.test.ts");
    expect(viaHelper.site).not.toMatch(/^helper \(/);
  });

  it("keeps every pg field and a rejected URL's input without its password", () => {
    const pg = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      severity: "ERROR",
      routine: "_bt_check_unique",
      table: "jobs",
      constraint: "jobs_pkey",
      detail: "Key (email)=(private-row@example.com) already exists.",
      where: "private-where-canary",
    });
    const described = describeError(pg);
    // A pg error's `detail`, `where` and `hint` are kept.
    expect(described.underlying?.fields).toEqual({
      severity: "ERROR",
      routine: "_bt_check_unique",
      table: "jobs",
      constraint: "jobs_pkey",
      detail: "Key (email)=(private-row@example.com) already exists.",
      where: "private-where-canary",
    });
    const invalidUrl = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
      input: "https://u:invalid-url-secret@@bad",
    });
    expect(describeError(invalidUrl).underlying?.fields).toEqual({
      input: "https://u:invalid-url-secret@@bad",
    });
  });

  it("redacts credentials in stack frames", () => {
    const error = new Error("x");
    error.stack = "Error: x\n    at eval (eval at run (password=frame-pw), <anonymous>:1:1)";
    expect(JSON.stringify(describeError(error).stack)).not.toContain("frame-pw");
  });

  it("enforces the byte bound with large context, a large error and emoji", () => {
    const emoji = "🔥".repeat(600);
    const detail = failureDetail("unclassified", {
      error: Object.assign(new Error(`${emoji}${"m".repeat(failureDetailBounds.message)}`), {
        extra: emoji,
        more: emoji,
      }),
      context: Object.fromEntries(
        Array.from({ length: failureDetailBounds.contextKeys }, (_, index) => [
          `key${index}`,
          `${"é".repeat(512)}${emoji}`,
        ]),
      ),
      cdpCommands: Array.from({ length: 32 }, (_, index) => ({
        id: index,
        method: "Fetch.continueRequest",
        cdpSession: "browser",
        state: "failed" as const,
        sentAtMs: index,
        errorMessage: emoji.slice(0, 400),
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThanOrEqual(
      failureDetailBounds.serialized,
    );
    expect(detail.subCause).toBe("unclassified");
    expect(JSON.stringify(detail)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const revalidated = failureDetailMetadata({ failureDetail: detail })?.failureDetail;
    expect(revalidated?.subCause).toBe("unclassified");
  });

  it("bounds messages, frames, context and command history", () => {
    const error = new Error("x".repeat(failureDetailBounds.message + 1_000));
    error.stack = [
      "Error: long",
      ...Array.from(
        { length: failureDetailBounds.stackFrames + 10 },
        (_, index) =>
          `    at step${index} (/home/runner/work/opengpt-browser-engine/typescript/src/example.ts:${index}:1)`,
      ),
    ].join("\n");
    const detail = failureDetail("unclassified", {
      error,
      context: Object.fromEntries(
        Array.from({ length: failureDetailBounds.contextKeys + 10 }, (_, index) => [
          `key${index}`,
          "v".repeat(200),
        ]),
      ),
      cdpCommands: Array.from({ length: failureDetailBounds.commands + 10 }, (_, index) => ({
        id: index,
        method: "Fetch.continueRequest",
        cdpSession: "browser",
        state: "acked" as const,
        sentAtMs: index,
      })),
    });
    expect(detail.underlying?.message?.length).toBeLessThan(failureDetailBounds.message + 40);
    expect(detail.stack).toHaveLength(failureDetailBounds.stackFrames);
    expect(detail.stack?.[0]).toBe("step0 (typescript/src/example.ts:0:1)");
    expect(JSON.stringify(detail)).not.toContain("/home/runner");
    expect(Object.keys(detail.context ?? {})).toHaveLength(failureDetailBounds.contextKeys);
    expect(detail.cdpCommands?.length).toBeLessThanOrEqual(failureDetailBounds.commands);
    expect(JSON.stringify(detail).length).toBeLessThanOrEqual(failureDetailBounds.serialized);
  });

  it("names the underlying error source: pg SQLSTATE, AWS name, Node code, Effect tag", () => {
    const pg = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
      severity: "ERROR",
      routine: "ProcessInterrupts",
    });
    expect(describeError(pg).underlying).toMatchObject({
      source: "postgres",
      code: "57014",
      message: "canceling statement due to statement timeout",
    });
    const aws = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $fault: "client",
      $metadata: { httpStatusCode: 403 },
    });
    expect(describeError(aws).underlying).toMatchObject({
      source: "aws",
      name: "AccessDenied",
      fields: { httpStatusCode: 403 },
    });
    const node = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(describeError(node).underlying).toMatchObject({ source: "node", code: "ECONNRESET" });
    const tagged = new StorageFailure({
      code: "StorageUnavailable",
      storage: { phase: "statement", category: "statement_timeout" },
      password: "never-retained",
    });
    const described = describeError(tagged);
    expect(described.underlying).toMatchObject({
      source: "effect",
      name: "StorageFailure",
      code: "StorageUnavailable",
      fields: { storage_phase: "statement", storage_category: "statement_timeout" },
    });
    expect(JSON.stringify(described)).not.toContain("never-retained");
  });

  it("follows a bounded cause chain and unwraps an Effect fiber failure", async () => {
    const root = new Error("socket hang up", { cause: new Error("ETIMEDOUT", { cause: "leaf" }) });
    const exit = await Effect.runPromise(Effect.either(Effect.fail(root)));
    expect(exit._tag).toBe("Left");
    const thrown = await Effect.runPromise(Effect.fail(root)).catch((error: unknown) => error);
    const described = describeError(thrown);
    expect(described.underlying?.message).toBe("socket hang up");
    expect(described.causeChain?.map((cause) => cause.message)).toEqual(["ETIMEDOUT", "leaf"]);
  });

  it("records the producing site as a stack when there is no underlying error", () => {
    const detail = failureDetail("startup_attempt_superseded");
    expect(detail.stack?.[0]).toContain("failure-detail.test.ts");
  });

  it("validates plain failure metadata and filters invalid context keys", () => {
    expect(failureDetailMetadata({ failureDetail: { subCause: "invented" } })).toBeUndefined();
    expect(
      failureDetailMetadata({
        failureDetail: { subCause: "unclassified", context: { "bad key": "x", good: 1 } },
      })?.failureDetail.context,
    ).toEqual({ good: 1 });
    expect(failureDetailMetadata({ code: "AuthorityChanged" })).toBeUndefined();
    expect(failureDetailOf(new Error("plain"))).toBeUndefined();
  });

  it("keeps a browser page call failure distinct from an unresponsive browser", () => {
    const detail = failureDetail("browser_page_call_failed", {
      operation: "page_reset",
      error: new Error("script threw"),
    });
    const revalidated = failureDetailMetadata({ failureDetail: detail })?.failureDetail;
    expect(revalidated?.subCause).toBe("browser_page_call_failed");
    expect(revalidated?.operation).toBe("page_reset");
  });
});

describe("a failure that carries detail", () => {
  it("keeps a built detail out of JSON serialization of the failure that carries it", () => {
    const failure = new MintFailure({
      code: "Unavailable",
      failureDetail: failureDetail("mint_host_dependency_failed", {
        error: new Error("RAW_PROVIDER_TEXT"),
      }),
    });
    expect(JSON.stringify(failure)).not.toContain("RAW_PROVIDER_TEXT");
    expect(JSON.stringify(failureDetailMetadata(failure))).toContain("RAW_PROVIDER_TEXT");
  });

  it("keeps a wrapped failure's own evidence and records the mapping site", () => {
    const inner = new MintFailure({
      code: "Unavailable",
      failureDetail: failureDetail("executor_boundary_failed", {
        operation: "local.execute",
        error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET", syscall: "read" }),
        context: { allocation: "pool-a" },
      }),
    });
    const outer = failureDetail("mint_host_dependency_failed", { error: inner });
    expect(outer.underlying).toMatchObject({
      name: "MintFailure",
      code: "Unavailable",
      subCause: "executor_boundary_failed",
    });
    expect(outer.causeChain?.[0]).toMatchObject({ source: "node", code: "ECONNRESET" });
    expect(outer.context).toMatchObject({ allocation: "pool-a" });
    expect(outer.site).toContain("failure-detail.test.ts");
  });

  it("projects a failure without detail as unclassified with its own stack", () => {
    const bare = new MintFailure({ code: "ScopeDenied" });
    expect(failureDetailOf(bare)?.failureDetail).toMatchObject({
      subCause: "unclassified",
      underlying: { source: "effect", name: "MintFailure", code: "ScopeDenied" },
    });
    expect(failureDetailOf(bare)?.failureDetail.stack?.[0]).toContain("failure-detail.test.ts");
  });
});

import { Context, Data, Effect, Schema } from "effect";
import type { ParseResult } from "effect";
import { FixtureUnavailable } from "./errors.js";

/**
 * What an offline test of an HTTP version reads: response bodies a live run saved, and the
 * evidence they came from. The host selects and screens them; authored code never opens the
 * files itself. A host without saved HTTP never provides these services.
 */

export interface SavedHttpBody {
  readonly state: "saved";
  readonly bytes: Uint8Array;
  readonly encoding: "utf-8";
}

export type HttpBodyFixture =
  | SavedHttpBody
  | { readonly state: "unavailable" | "incomplete" | "withheld" | "empty" };

/** Decodes a saved JSON body with `schema`, failing `FixtureUnavailable` when there is none. */
export const parseSavedHttp = <Value, Encoded>(
  fixture: HttpBodyFixture,
  schema: Schema.Schema<Value, Encoded>,
): Effect.Effect<Value, FixtureUnavailable | ParseResult.ParseError> =>
  Effect.gen(function* () {
    if (fixture.state !== "saved") {
      return yield* new FixtureUnavailable({ reason: "missing_body" });
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(fixture.bytes),
      catch: (error) => new FixtureUnavailable({ reason: "unsupported_encoding", cause: error }),
    });
    const value: unknown = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => new FixtureUnavailable({ reason: "invalid_json", cause: error }),
    });
    return yield* Schema.decodeUnknown(schema)(value);
  });

/** What the host observed of one side of a saved exchange: its URL and screened headers. */
export interface SavedHttpObservation {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * One saved exchange, as the host recorded it: method, URL, status, headers, whether each body
 * was saved, and where its bytes came from. A host may record more.
 */
export interface SavedHttpExchange {
  readonly requestId: string;
  readonly method: string;
  readonly status?: number | undefined;
  readonly redirectedFrom?: string | undefined;
  readonly requestObservation: SavedHttpObservation;
  readonly responseObservation: SavedHttpObservation;
  readonly requestBody: { readonly state: string };
  readonly responseBody: { readonly state: string };
  readonly bodyProvenance: string;
}

/** One selected saved response body: its path, its exchange and the body to parse. */
export interface SavedHttpFixture {
  readonly reference: string;
  readonly exchange: SavedHttpExchange;
  readonly fixture: SavedHttpBody;
}

/** One capture the selected evidence came from: its manifest and where it is. */
export interface SavedCapture {
  readonly manifestPath: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

/** The host could not give an offline test its fixtures. */
export class OfflineFixtureUnavailable extends Data.TaggedError("OfflineFixtureUnavailable")<{
  readonly reason: "invalid_binding" | "browser_unavailable";
}> {}

/** The captures behind an offline test's fixtures; an active one is a snapshot, not complete. */
export class SavedCaptureEvidence extends Context.Tag("opengpt-browser-engine/SavedCaptureEvidence")<
  SavedCaptureEvidence,
  readonly SavedCapture[]
>() {}

/** The complete saved response bodies an offline test selected, for its own parser. */
export class SavedHttpFixtures extends Context.Tag("opengpt-browser-engine/SavedHttpFixtures")<
  SavedHttpFixtures,
  readonly SavedHttpFixture[]
>() {}

import { Effect, Option, Schema } from "effect";
import { holdsFocusCode } from "./field-focus-code.js";

/** Keyboard remains decodable for older control documents, but is temporarily unsupported. */
export type CredentialTypingMode = "paste" | "keyboard";

/** The one-use, value-free binding a Kernel focus call placed on the original field. */
interface CredentialTarget {
  /** The host-inspected popup target only; absent binds to the stable primary tab. */
  readonly targetId?: string | undefined;
  readonly bindingKey: string;
  readonly documentOrigin: string;
}

/** Why native insertion inserted nothing, as one finite cause: never the binding key, a selector or a value. */
export const InsertionRefusal = Schema.Literal(
  /** No node carries the binding's marker in the target's sessions the host could read and walk. */
  "binding_not_found",
  /** More than one node carries it, in one session or across sessions. */
  "binding_ambiguous",
  /** The host could not find the binding's world or resolve the marked node in it. */
  "binding_unresolved",
  /** The marked node holds no binding in the private world: page code copied the marker. */
  "binding_not_in_world",
  /** The bound field left its document. */
  "detached",
  /** The bound field moved to another document. */
  "document_changed",
  /** The bound document no longer fills the frame it was bound in. */
  "frame_changed",
  /** That frame's origin is no longer the approved one. */
  "origin_changed",
  /** The bound field no longer holds its document's focus: another element, or none, does. */
  "focus_moved",
  /** The document itself does not hold the browser's focus. */
  "document_unfocused",
  /** A private answer's observed question no longer reads as it did when the host inspected it. */
  "question_changed",
  /** The browser's native insertion inserted nothing. */
  "insertion_rejected",
);
export type InsertionRefusal = typeof InsertionRefusal.Type;
/** A native insertion's answer: inserted, or why not. */
export const CredentialInsertion = Schema.Union(Schema.Literal("inserted"), InsertionRefusal);
/**
 * An insertion's answer when the host asked it to read a phone field back (`InsertionOptions`):
 * also `changed`, inserted, but the field then held other digits than the number's.
 */
export const CredentialReadBack = Schema.Union(CredentialInsertion, Schema.Literal("changed"));

/** What the host asks of an insertion besides typing. */
export interface InsertionOptions {
  /**
   * The field takes a phone number: once the page had `phoneReadBackMs` to reformat it, read the
   * field back and answer `changed` when it holds other digits than the number's
   * (`phoneDigitsCode`). A read that fails or finds no value answers `inserted`, as without it.
   */
  readonly phone?: true | undefined;
  /**
   * Type the text one character at a time, each between a keydown, keypress and keyup on the field,
   * for a page that reacts only to key presses. The guard holds before each character, so a
   * refusal after the first may leave part of the text typed.
   */
  readonly keys?: true | undefined;
}

/**
 * Inserts only into the original field, or refuses with the finite cause. It fails only at or after
 * the call that carries the value, so a failure may have typed it. A keyboard that does not read
 * back (`options`) answers as it would without them: `changed` comes only from one that does.
 */
export interface CredentialKeyboard {
  readonly insertText: (
    target: CredentialTarget,
    text: string,
    options?: InsertionOptions,
  ) => Effect.Effect<typeof CredentialReadBack.Type, Error>;
}

/**
 * How long a page has to reformat a phone number once it was typed, as an input mask, a country
 * picker's formatter or a framework's next render does, before the host reads the field back.
 */
export const phoneReadBackMs = 250;

/**
 * Page code, called on the field the host typed `text`, a phone number, into: whether the field
 * kept its digits. A field may drop up to three leading digits of the number, its country calling
 * code or trunk prefix, and may show up to three of its own before them, such as the picker's
 * calling code: what follows must be the rest of the number, every digit to the last. A number
 * dialed with an international prefix (`00`, or `011`) may also drop the prefix with them. A
 * number shifted into another country's digits or cut short is `changed`. A field gone from its
 * document, one with no text value or no digits, or a number with no digits is `unread`, so a
 * field the page emptied stays the empty-field failure the next call finds. Only digits 0 to 9
 * count.
 */
export const phoneDigitsCode = `function(text) {
  const field = this;
  if (!field.isConnected || typeof field.value !== "string") return "unread";
  const digits = (value) => value.replace(/[^0-9]/g, "");
  const typed = digits(text);
  const kept = digits(field.value);
  if (typed.length === 0 || kept.length === 0) return "unread";
  const numbers = [typed];
  if (typed.startsWith("00")) numbers.push(typed.slice(2));
  if (typed.startsWith("011")) numbers.push(typed.slice(3));
  for (const number of numbers)
    for (let dropped = 0; dropped <= 3; dropped++)
      for (let shown = 0; shown <= 3; shown++) {
        const rest = number.slice(dropped);
        if (rest.length > 0 && rest === kept.slice(shown)) return "kept";
      }
  return "changed";
}`;

/**
 * The execution context a host's page calls bound the field in, for a host whose page calls
 * evaluate in a world other than the page's main one. `frameId` is the field's frame when it is
 * not the session's own. Without it, the field resolves in the main world.
 */
export type CredentialBindingWorld = (
  cdp: PrivateCredentialCdp,
  binding: { readonly sessionId: string; readonly frameId: string | undefined },
) => Effect.Effect<number, Error>;

export interface PrivateCredentialCdp {
  readonly sessions: (targetId?: string) => readonly string[];
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => Promise<unknown>;
}

const RemoteResult = Schema.Struct({
  result: Schema.Struct({
    objectId: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

const NativeNode = Schema.Struct({
  backendNodeId: Schema.Number,
  frameId: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Array(Schema.String)),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
  contentDocument: Schema.optional(Schema.Unknown),
  shadowRoots: Schema.optional(Schema.Array(Schema.Unknown)),
});
const NativeDocument = Schema.Struct({ root: Schema.Unknown });
const ResolvedNode = Schema.Struct({
  object: Schema.Struct({ objectId: Schema.optional(Schema.String) }),
});

const nativeDescendants = (node: typeof NativeNode.Type, frameId: string | undefined) => {
  const descendants = [...(node.children ?? []), ...(node.shadowRoots ?? [])].map((value) => ({
    value,
    frameId,
  }));
  if (node.contentDocument !== undefined) {
    if (node.frameId === undefined) throw new Error("Credential frame unavailable");
    descendants.push({ value: node.contentDocument, frameId: node.frameId });
  }
  return descendants;
};

/** Ephemeral, bounded native traversal: exactly one opaque marker, never a selector fallback. */
const findMarkedNode = (
  value: unknown,
  key: string,
): { backendNodeId: number; frameId: string | undefined } | "binding_ambiguous" | undefined => {
  const document = Schema.decodeUnknownOption(NativeDocument)(value);
  if (document._tag === "None") throw new Error("Credential target document unavailable");
  const { root } = document.value;
  const pending: { value: unknown; frameId: string | undefined }[] = [
    { value: root, frameId: undefined },
  ];
  let found: { backendNodeId: number; frameId: string | undefined } | undefined;
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 50_000) throw new Error("Credential target document too large");
    const next = pending.pop();
    if (next === undefined) break;
    const decoded = Schema.decodeUnknownOption(NativeNode)(next.value);
    if (decoded._tag === "None") throw new Error("Credential target node unavailable");
    const node = decoded.value;
    const attributes = node.attributes ?? [];
    for (let index = 0; index < attributes.length; index += 2) {
      if (attributes[index] !== key) continue;
      if (found !== undefined) return "binding_ambiguous";
      found = { backendNodeId: node.backendNodeId, frameId: next.frameId };
    }
    pending.push(...nativeDescendants(node, next.frameId));
  }
  return found;
};

/**
 * Guard and insertion share this synchronous call on the original DOM object. Native insertion
 * emits a trusted InputEvent without key events. A stale document's object cannot run on a new
 * document; a moved focus never receives a value. Typed by keys, each character's key events run
 * page code, so the guard holds again before the host inserts each character.
 */
const atomicInsert = `function(key, origin, text, keys) {
  const field = this;
  const binding = field[key];
  field.removeAttribute(key);
  delete field[key];
  if (!binding) return "binding_not_in_world";
  const { document, frame } = binding;
  const holdsFocus = ${holdsFocusCode};
  const guard = () => {
    if (!field.isConnected) return "detached";
    if (field.ownerDocument !== document) return "document_changed";
    if (document.defaultView !== frame || frame.document !== document) return "frame_changed";
    if (frame.origin !== origin) return "origin_changed";
    if (!holdsFocus(field)) return "focus_moved";
    if (!document.hasFocus()) return "document_unfocused";
    if (binding.questionRequired &&
        (typeof binding.checkQuestion !== "function" || !binding.checkQuestion())) return "question_changed";
  };
  const refused = guard();
  if (refused) return refused;
  if (!keys) return document.execCommand("insertText", false, text) ? "inserted" : "insertion_rejected";
  for (const char of Array.from(text)) {
    const keyCode = /^[a-z0-9]$/i.test(char) ? char.toUpperCase().charCodeAt(0) : 0;
    const press = (type, code = keyCode) => field.dispatchEvent(new KeyboardEvent(type, {
      key: char, keyCode: code, which: code, charCode: type === "keypress" ? code : 0,
      bubbles: true, cancelable: true, composed: true,
    }));
    if (press("keydown") && press("keypress", char.charCodeAt(0))) {
      const moved = guard();
      if (moved) return moved;
      if (!document.execCommand("insertText", false, char)) return "insertion_rejected";
    }
    press("keyup");
  }
  return "inserted";
}`;

const command = (
  cdp: PrivateCredentialCdp,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: () => cdp.send(method, params, sessionId),
    catch: (error) =>
      error instanceof Error ? error : new Error("Credential insertion unavailable"),
  });

const resultOf = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(RemoteResult)(value);
  if (decoded._tag === "None" || decoded.value.exceptionDetails !== undefined)
    throw new Error("Credential target binding unavailable");
  return decoded.value.result;
};

/**
 * The one field the target's binding marks, resolved in its world, or why not, sending no value.
 * A session whose document the browser refuses to read, or the host cannot walk, such as a large
 * third-party frame's, is skipped: when it held the field, the binding is not found, and a marker
 * copied elsewhere holds no binding in the private world. A binding world that fails and a node
 * the browser refuses to resolve leave the binding unresolved. So nothing before the insertion
 * fails.
 */
const findBinding = (
  cdp: PrivateCredentialCdp,
  target: CredentialTarget,
  bindingWorld: CredentialBindingWorld | undefined,
) =>
  Effect.gen(function* () {
    let found:
      { sessionId: string; backendNodeId: number; frameId: string | undefined } | undefined;
    for (const sessionId of cdp.sessions(target.targetId)) {
      const read = yield* Effect.either(
        command(cdp, sessionId, "DOM.getDocument", { depth: -1, pierce: true }),
      );
      if (read._tag === "Left") continue;
      const walked = yield* Effect.either(
        Effect.try(() => findMarkedNode(read.right, target.bindingKey)),
      );
      if (walked._tag === "Left") continue;
      const node = walked.right;
      if (node === undefined) continue;
      if (node === "binding_ambiguous" || found !== undefined) return "binding_ambiguous" as const;
      found = { sessionId, ...node };
    }
    if (found === undefined) return "binding_not_found" as const;
    let executionContextId: number | undefined;
    if (bindingWorld !== undefined) {
      const world = yield* Effect.either(
        bindingWorld(cdp, { sessionId: found.sessionId, frameId: found.frameId }),
      );
      if (world._tag === "Left") return "binding_unresolved" as const;
      executionContextId = world.right;
    }
    const resolved = yield* Effect.either(
      command(cdp, found.sessionId, "DOM.resolveNode", {
        backendNodeId: found.backendNodeId,
        ...(executionContextId === undefined ? {} : { executionContextId }),
      }),
    );
    const objectId =
      resolved._tag === "Left"
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ResolvedNode)(resolved.right))?.object
            .objectId;
    return objectId === undefined
      ? ("binding_unresolved" as const)
      : { sessionId: found.sessionId, objectId };
  });

/**
 * A phone field read back once the page had `phoneReadBackMs` to reformat it: `changed` when it
 * kept other digits than the number's (`phoneDigitsCode`), else `inserted`. The number goes in as
 * an argument on the private socket, as the insertion's did, and only the finite answer comes
 * back. A read that fails or answers anything else can't tell, so it answers `inserted`.
 */
const readBackPhone = (
  cdp: PrivateCredentialCdp,
  bound: { readonly sessionId: string; readonly objectId: string },
  text: string,
) =>
  Effect.sleep(phoneReadBackMs).pipe(
    Effect.zipRight(
      command(cdp, bound.sessionId, "Runtime.callFunctionOn", {
        objectId: bound.objectId,
        functionDeclaration: phoneDigitsCode,
        arguments: [{ value: text }],
        returnByValue: true,
      }),
    ),
    Effect.map((value) =>
      Option.getOrUndefined(Schema.decodeUnknownOption(RemoteResult)(value))?.result.value ===
      "changed"
        ? ("changed" as const)
        : ("inserted" as const),
    ),
    // error-reporting-allow: typed-recovery the value is already typed and a read that fails can't tell what the field kept, so the fill goes on as it did before reading back
    Effect.orElseSucceed(() => "inserted" as const),
  );

/**
 * The credential-only native DOM reads and Runtime calls on the private socket resolve the original
 * field binding, insert atomically into that remote object, then release it. No parameters enter
 * recorder history or logs, and the secret is an argument, never Kernel REST script text. A phone
 * number (`InsertionOptions.phone`) is read back from that same object before its release.
 */
export const makeCredentialKeyboard = (
  cdp: PrivateCredentialCdp,
  // error-reporting-allow: typed-recovery releasing the temporary DOM object cannot undo inserted credentials; the owned browser context also releases it when closed
  release: (effect: Effect.Effect<unknown, Error>) => Effect.Effect<void> = Effect.ignore,
  bindingWorld?: CredentialBindingWorld,
): CredentialKeyboard => ({
  insertText: (target, text, options) =>
    Effect.gen(function* () {
      const bound = yield* findBinding(cdp, target, bindingWorld);
      if (typeof bound === "string") return bound;
      let readBack: "inserted" | "changed" = "inserted";
      const value = yield* command(cdp, bound.sessionId, "Runtime.callFunctionOn", {
        objectId: bound.objectId,
        functionDeclaration: atomicInsert,
        arguments: [
          { value: target.bindingKey },
          { value: target.documentOrigin },
          { value: text },
          { value: options?.keys === true },
        ],
        returnByValue: true,
      }).pipe(
        Effect.tap((inserted) =>
          Effect.gen(function* () {
            if (options?.phone !== true) return;
            const answer = Option.getOrUndefined(Schema.decodeUnknownOption(RemoteResult)(inserted));
            if (answer?.exceptionDetails === undefined && answer?.result.value === "inserted")
              readBack = yield* readBackPhone(cdp, bound, text);
          }),
        ),
        Effect.ensuring(
          release(
            command(cdp, bound.sessionId, "Runtime.releaseObject", { objectId: bound.objectId }),
          ),
        ),
      );
      const answer = yield* Effect.try({
        try: () => resultOf(value).value,
        catch: (error) =>
          error instanceof Error ? error : new Error("Credential insertion unavailable"),
      });
      // An answer outside the finite set leaves whether the value landed unknown.
      const inserted = yield* Schema.decodeUnknown(CredentialInsertion)(answer).pipe(
        Effect.mapError((cause) => new Error("Credential insertion unavailable", { cause })),
      );
      return inserted === "inserted" ? readBack : inserted;
    }),
});

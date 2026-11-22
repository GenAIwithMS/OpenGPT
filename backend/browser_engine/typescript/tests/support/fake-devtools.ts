import { Effect } from "effect";
import {
  type CredentialBindingWorld,
  type CredentialKeyboard,
  makeCredentialKeyboard,
  type PrivateCredentialCdp,
} from "../../src/destinations/credential-keyboard.js";

/** A browser's refusal of one DevTools command, as a host's transport reports it. */
export class CdpCommandRefused extends Error {
  /** The transport's finite reason. */
  readonly reason = "cdp_command_error";
  constructor(
    readonly method: string,
    /** The refused command's parameters, which a failure report never copies. */
    readonly params: Record<string, unknown>,
  ) {
    super(`${method} failed: synthetic refusal of ${JSON.stringify(params)}`);
    this.name = "CdpCommandFailure";
  }
}

/** One DevTools command the keyboard sent, in order. */
export interface SentCommand {
  readonly method: string;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
}

/**
 * The host's credential keyboard over a fake private DevTools socket. `marked` names each session
 * of the tab, in order, with how many fields in its document carry the binding's marker. `refuse`
 * returns the error the browser answers a command with, or undefined to answer it as Chromium
 * would. A session in `documents` answers its document read with that document, the insertion
 * answers `inserted` or `insertion`, and `bindingWorld` is the host's. `sent` lists every command.
 */
export const fakeDevtoolsKeyboard = (
  marked: Readonly<Record<string, number>>,
  refuse: (command: SentCommand) => Error | undefined = () => undefined,
  options: {
    readonly insertion?: unknown;
    readonly documents?: Readonly<Record<string, unknown>>;
    readonly bindingWorld?: CredentialBindingWorld;
  } = {},
) => {
  const sent: SentCommand[] = [];
  let bindingKey = "";
  const cdp: PrivateCredentialCdp = {
    sessions: () => Object.keys(marked),
    send: (method, params, sessionId) => {
      const command = { method, sessionId, params };
      sent.push(command);
      const refusal = refuse(command);
      if (refusal !== undefined) return Promise.reject(refusal);
      switch (method) {
        case "DOM.getDocument":
          if (options.documents?.[sessionId] !== undefined)
            return Promise.resolve(options.documents[sessionId]);
          return Promise.resolve({
            root: {
              backendNodeId: 1,
              children: Array.from({ length: marked[sessionId] ?? 0 }, (_, index) => ({
                backendNodeId: 10 + index,
                attributes: ["type", "password", bindingKey, ""],
              })),
            },
          });
        case "DOM.resolveNode":
          return Promise.resolve({ object: { objectId: "field" } });
        case "Runtime.callFunctionOn":
          return Promise.resolve({ result: { value: options.insertion ?? "inserted" } });
        default:
          return Promise.resolve({});
      }
    },
  };
  const native = makeCredentialKeyboard(cdp, undefined, options.bindingWorld);
  const keyboard: CredentialKeyboard = {
    insertText: (target, text) =>
      Effect.suspend(() => {
        bindingKey = target.bindingKey;
        return native.insertText(target, text);
      }),
  };
  return { keyboard, sent, bindingKey: () => bindingKey };
};

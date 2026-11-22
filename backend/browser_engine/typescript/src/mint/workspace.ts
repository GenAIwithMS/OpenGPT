import type { Editor } from "@openai/agents";
import { Manifest } from "@openai/agents/sandbox";
import type { SandboxSession } from "@openai/agents/sandbox";
import { Effect } from "effect";
import { MintFailure } from "./contracts.js";
import type { MintDependencies, MintTurn } from "./contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";

/** The workspace directories the minting agent authors in; every other path is host-owned. */
export const authoredDirectories = ["src", "explore", "test", "scratch"] as const;
const authoredPath = new RegExp(`^(${authoredDirectories.join("|")})/`);

export const relativeSourcePath = (path: string): string => {
  const relative = path.startsWith("/workspace/") ? path.slice(11) : path;
  if (
    !/^[A-Za-z0-9_./-]+$/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new MintFailure({ code: "ScopeDenied" });
  return relative;
};

/**
 * Model input, screened for credentials only. It is never withheld: when screening is
 * unavailable it is delivered with only the owner's explicit secrets masked.
 */
export const screenMintText = (
  dependencies: Pick<MintDependencies, "projection">,
  value: unknown,
  options?: { readonly area?: "model" | "review" },
): Effect.Effect<string, MintFailure> =>
  typeof value === "string"
    ? dependencies.projection.text(value, options?.area)
    : dependencies.projection.json(value).pipe(
        Effect.flatMap((screened) =>
          Effect.try({
            try: () => {
              const serialized = JSON.stringify(screened);
              if (serialized === undefined) throw new Error("Non-JSON mint input");
              return serialized;
            },
            catch: (error) =>
              new MintFailure({
                code: "Unavailable",
                failureDetail: failureDetail("mint_host_dependency_failed", {
                  operation: "JSON.stringify",
                  error,
                }),
              }),
          }),
        ),
      );

const screenMintSource = (
  dependencies: Pick<MintDependencies, "projection">,
  source: string,
  path: string,
) => dependencies.projection.source(path, source);

/** An effect question turn may only ask. Every source read, edit, command and mount is refused. */
export const questionOnlyWorkspace = (session: SandboxSession): SandboxSession => {
  const refuse = () => Promise.reject(new MintFailure({ code: "ScopeDenied" }));
  return {
    state: session.state,
    createEditor: () => ({ createFile: refuse, updateFile: refuse, deleteFile: refuse }),
    execCommand: refuse,
    supportsPty: () => false,
    readFile: refuse,
    pathExists: refuse,
    materializeEntry: refuse,
    applyManifest: refuse,
  };
};

/** A patch that did not apply to the file's current text; the editor left the file unchanged. */
const patchFailure = (error: object) => {
  const reason =
    "message" in error && typeof error.message === "string"
      ? ` (${error.message.slice(0, 300)})`
      : "";
  return {
    status: "failed" as const,
    output: `Workspace edit failed: the patch did not apply${reason}. The file is unchanged; read it with read_source and send a patch against its current text.`,
  };
};

/**
 * An edit the workspace editor refused before changing anything, named by the stage it stopped at
 * (the local editor's `refusedEdit`): a patch that did not apply, a file that exists or does not,
 * or a size limit. Only the stage, the errno name and the limit are shown.
 */
const stagedEditFailure = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("stage" in error)) return undefined;
  if (error.stage === "diff") return patchFailure(error);
  if (error.stage !== "open") return undefined;
  const code =
    "code" in error && typeof error.code === "string" && /^E[A-Z0-9]{1,15}$/.test(error.code)
      ? ` (${error.code})`
      : "";
  // A size refusal names its limit; no refusal carries file content.
  const limit =
    "message" in error && typeof error.message === "string" && /at most/.test(error.message)
      ? ` ${error.message}.`
      : "";
  return {
    status: "failed" as const,
    output: `Workspace edit failed at the open stage${code}.${limit} The file is unchanged.`,
  };
};

/** The model's workspace session over the job sandbox workspace; shell never runs on the worker. */
export const makeMintWorkspace = (
  dependencies: MintDependencies,
  command: (command: string) => Effect.Effect<string, MintFailure>,
  runTool: MintTurn["runTool"],
  editAction: <A>(run: () => Promise<A>) => Promise<A> = (run) => run(),
): SandboxSession => {
  const base = dependencies.workspace;
  /**
   * Views the host already screened for the model: the token view, and published captures read
   * back from the job sandbox.
   */
  const hostServedView = async (path: string) => {
    const tokens = dependencies.readSessionTokens?.(path);
    if (tokens !== undefined || !dependencies.readPublishedCapture) return tokens;
    const read = await runTool(Effect.either(dependencies.readPublishedCapture(path)));
    if (read._tag === "Left") throw read.left;
    return read.right;
  };
  if (
    !base.createEditor ||
    !base.readFile ||
    !base.applyManifest ||
    !base.materializeEntry ||
    !base.pathExists
  )
    throw new MintFailure({ code: "Unavailable" });
  if (
    Object.keys(base.state.manifest.environment).length > 0 ||
    base.state.manifest.extraPathGrants.length > 0
  )
    throw new MintFailure({ code: "ScopeDenied" });
  const originalEditor = base.createEditor();
  const writable = (path: string) => {
    const relative = relativeSourcePath(path);
    if (!authoredPath.test(relative) && !/^(NOTES|MINT-SUMMARY)\.md$/.test(relative))
      throw new MintFailure({ code: "ScopeDenied" });
    return relative;
  };
  const uncertainEdit = {
    status: "failed" as const,
    output:
      "Workspace edit outcome unknown. The file may have changed; use read_source to inspect it before another edit.",
  };
  const edit = async (prepare: () => () => ReturnType<Editor["createFile"]>) => {
    let invoked = false;
    let failure: { readonly status: "failed"; readonly output: string } | undefined;
    try {
      const run = prepare();
      const result = await editAction(async () => {
        invoked = true;
        try {
          return await run();
        } catch (error) {
          failure = stagedEditFailure(error);
          throw error;
        }
      });
      if (result?.status === "failed") return uncertainEdit;
      return {
        status: result?.status ?? ("completed" as const),
        output: "Workspace edit completed.",
      };
    } catch {
      return (
        failure ??
        (invoked
          ? uncertainEdit
          : {
              status: "failed" as const,
              output: "Workspace edit unavailable or outside allowed source paths.",
            })
      );
    }
  };
  return {
    state: { manifest: new Manifest({ root: "/workspace" }), workspaceReady: true },
    createEditor: () => ({
      createFile: (operation) =>
        edit(() => {
          const path = writable(operation.path);
          return () => originalEditor.createFile({ ...operation, path });
        }),
      updateFile: (operation) =>
        edit(() => {
          const path = writable(operation.path);
          const moveTo = operation.moveTo ? writable(operation.moveTo) : undefined;
          return () =>
            originalEditor.updateFile({
              ...operation,
              path,
              ...(moveTo ? { moveTo } : {}),
            });
        }),
      deleteFile: (operation) =>
        edit(() => {
          const path = writable(operation.path);
          return () => originalEditor.deleteFile({ ...operation, path });
        }),
    }),
    execCommand: async (args) => {
      if (
        args.tty ||
        args.runAs ||
        (args.workdir && args.workdir !== "/workspace" && args.workdir !== ".")
      )
        throw new MintFailure({ code: "ScopeDenied" });
      return runTool(command(args.cmd));
    },
    supportsPty: () => false,
    readFile: async ({ path }) => {
      try {
        // Re-screening serialized capture metadata as prose corrupts the host's
        // request IDs and file paths. This view contains only collector-screened
        // published bytes and is scoped to this host attempt, not caller files.
        const hostView = await hostServedView(relativeSourcePath(path));
        if (hostView !== undefined) return hostView;
        const retained = dependencies.readRetainedCapture
          ? await runTool(dependencies.readRetainedCapture(relativeSourcePath(path)))
          : undefined;
        if (retained !== undefined) return retained;
        const content = await base.readFile?.({
          path: relativeSourcePath(path),
          maxBytes: 8 * 1024 * 1024 + 1,
        });
        if (content === undefined) throw new MintFailure({ code: "Unavailable" });
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        if (bytes.byteLength > 8 * 1024 * 1024) throw new MintFailure({ code: "Unavailable" });
        const text =
          typeof content === "string"
            ? content
            : new TextDecoder("utf-8", { fatal: true }).decode(content);
        return await runTool(screenMintSource(dependencies, text, path));
      } catch (error) {
        // A job sandbox read keeps its finite detail (operation, path, reason) for the agent.
        throw new MintFailure({
          code: "Unavailable",
          ...(error instanceof MintFailure && error.workspace !== undefined
            ? { workspace: error.workspace }
            : {}),
        });
      }
    },
    pathExists: (path) => base.pathExists?.(relativeSourcePath(path)) ?? Promise.resolve(false),
    materializeEntry: async (args) => {
      const path = relativeSourcePath(args.path);
      if (!path.startsWith(".agents/")) throw new MintFailure({ code: "ScopeDenied" });
      await base.materializeEntry?.({ path, entry: args.entry });
    },
    applyManifest: async (manifest) => {
      if (Object.keys(manifest.environment).length || manifest.extraPathGrants.length)
        throw new MintFailure({ code: "ScopeDenied" });
      for (const path of Object.keys(manifest.entries))
        if (!relativeSourcePath(path).startsWith(".agents/"))
          throw new MintFailure({ code: "ScopeDenied" });
      await base.applyManifest?.(
        new Manifest({ root: base.state.manifest.root, entries: manifest.entries }),
      );
    },
  };
};

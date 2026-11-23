import { Effect } from "effect";
import { file } from "@openai/agents/sandbox";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { readScopedFile } from "../filesystem/read.js";
import { MintFailure } from "./contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { hostedFeaturesPreamble } from "../hosted-features.js";
import {
  publicationLiveTestsPolicy,
  publicationOutputPolicy,
  publicationWriteOutcomePolicy,
  publicationWritePathPolicy,
} from "../guardian/publication.js";

const catalog = [
  {
    name: "core",
    description: "Operation SDK, intake, ownership and execution targets",
    references: [
      "parser.ts",
      "native-page.ts",
      "navigation.ts",
      "selection.ts",
      "native-dialog.ts",
    ],
  },
  {
    name: "search",
    description:
      "Read before settling a search or listing tool's inputs: the site's own filters, sort and location, applied and read back, and honest empty results",
    references: [],
  },
  {
    name: "auth",
    description: "Discover an evidenced login entry and sign in through the host",
    references: ["auth-entry.ts"],
  },
  {
    name: "testing",
    description:
      "For a read: design a few combined live test cases and run them. A read signed out runs a handful; a signed-in read runs four inputs at most. A write skips it and proves its tool with one run",
    references: [],
  },
  {
    name: "pagination",
    description:
      "Read before settling the schema of any tool that returns a list: page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop",
    references: ["pagination.ts", "pager.ts"],
  },
  {
    name: "forms",
    description: "Native/custom selection, resolvers, staged forms and expected terms",
    references: [
      "dates-and-dropdowns.ts",
      "picker.ts",
      "picker-first.ts",
      "custom-selection.ts",
      "dialog-picker.ts",
      "dates-and-files.ts",
    ],
  },
  {
    name: "writes",
    description:
      "Perform an authorized write once, confirm it, then return its integration without running it again",
    references: ["write-session.ts", "write-readback.ts"],
  },
  {
    name: "cart",
    description:
      "Read before building any tool that reads, adds to, changes or checks out a cart: when to sign in or check out as a guest, read the cart before and after, quantity, account values and site limits",
    references: [],
  },
  {
    name: "caller-input",
    description:
      "Read before settling any tool's inputs and errors: what the input schema holds, the rules checked before touching the site, InvalidInput versus InputNotApplied, and asking the run's caller mid-run for what only they know",
    references: ["caller-choice.ts", "caller-code.ts"],
  },
  {
    name: "publication",
    description:
      "Read before the first finish_build: what publication checks, private values never to publish, and how to act on each rejection",
    references: [],
  },
] as const;

/**
 * The host-owned workspace guide, relative to the authoring directory. `AGENTS.md` is the
 * always-on context: the host installs it at the workspace root and gives the same text to the
 * minting model as its instructions, so it holds regardless of the agent runtime. The README is
 * read on demand. Each path is installed at the same path under the workspace root, without the
 * `workspace/` prefix.
 */
const workspaceGuideFiles = [{ path: "README.md", sectionKey: "guide" }] as const;

/**
 * The publication review's rules for live tests, output and a write's outcome and path, installed
 * in the workspace for the minter to read while it explores, so it gathers that evidence, and
 * declares a write's whole path, before its first publication or write step instead of learning
 * them from a denial. It is the text every host's publication policy includes, not a copy, so a
 * change to a rule reaches the minter in the same release. No host render applies: it is not
 * authoring text.
 */
const publicationReviewRules = {
  path: "reference/publication-review.md",
  text: [
    publicationLiveTestsPolicy,
    publicationOutputPolicy,
    `${publicationWriteOutcomePolicy} ${publicationWritePathPolicy}`,
  ].join("\n\n"),
} as const;

export interface WorkspaceGuide {
  /** The workspace `AGENTS.md`, which is also the minting model's instructions. */
  readonly instructions: string;
  /** Workspace-relative path to content, `AGENTS.md` included. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * Turns one authoring file's text into what the minter reads. `sectionKey` is the file's key, such
 * as `core` for `core/SKILL.md`. The default renders each named section's standalone text. A host
 * that composed the directory with its own text supplies a render that checks that text instead.
 */
export type AuthoringRender = (text: string, sectionKey: string) => string;

/**
 * A named section is `<!-- opengpt:section ID -->`, or `<!-- opengpt:section ID:start`, its
 * standalone text and `opengpt:section ID:end -->`. A section that ends the file also takes the
 * file's final newline. Each ID starts with its file's key, such as `core.` in `core/SKILL.md`.
 */
const section =
  /<!-- opengpt:section ([a-z0-9.-]+)(?: -->|:start\n([\s\S]*?)\nopengpt:section \1:end -->)(?:\n(?=$))?/g;
/**
 * Anything left that reads as a marker, in any case or spacing, is malformed: a broken section, or
 * a 0.1.1 block such as `opengpt:hosted:end -->`. Authoring text never says `opengpt:` itself.
 */
const sectionTrace = /opengpt:/i;
const fence = /^\s*(`{3,}|~{3,})/;

/** A section marker belongs to the file's own text, never to a fenced example. */
const refuseFencedSections = (text: string) => {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const marker = fence.exec(line)?.[1];
    if (marker === undefined) {
      if (open !== undefined && sectionTrace.test(line))
        throw new Error("Authoring section inside a code fence");
    } else if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = undefined;
  }
};

const standaloneText: AuthoringRender = (text, sectionKey) => {
  refuseFencedSections(text);
  const seen = new Set<string>();
  const rendered = text.replace(section, (_match: string, id: string, content?: string) => {
    if (!id.startsWith(`${sectionKey}.`))
      throw new Error(`Authoring section ${id} is not one of ${sectionKey}'s`);
    if (seen.has(id)) throw new Error(`Authoring section ${id} appears twice`);
    seen.add(id);
    return content ?? "";
  });
  if (sectionTrace.test(rendered)) throw new Error("Malformed authoring section");
  return rendered;
};

/**
 * The search URL fast path: a tool enters at the site's results URL with the caller's values in
 * it, filters and a location the URL carries included, whenever that mapping is reliable and
 * clear. A host turns it on with `searchUrlFastPath`. Off, the minter reads the files' own text,
 * which opens such a URL only for the parts it lists, and a search reaches its results through
 * the page's controls before it reads the page's own data. Each entry is whole lines of one
 * file's rendered text, which appear there exactly once, and the lines that replace them.
 */
const searchUrlFastPathPassages: readonly {
  readonly sectionKey: string;
  readonly off: readonly string[];
  readonly on: readonly string[];
}[] = [
  {
    sectionKey: "agents",
    off: [
      "which parts of it carry which input, such as the query, dates, guests or party size, sort or a",
      "record's own identifier route, the tool may open that URL with the caller's values in those",
      "parts, built with `URLSearchParams` for a query part or `encodeURIComponent` for a path part and",
      "every other part copied as the site wrote it, once the build checked that it gives the same answer as the controls. At run time it reads every input",
    ],
    on: [
      "which parts of it carry which input, such as the query, dates, guests or party size, sort,",
      "filters, a location the URL itself carries or a record's own identifier route, the tool enters",
      "at that URL with the caller's values in those parts when the mapping is reliable and clear: each",
      "part's valid values are known and readable in the URL, such as a sort or filter whose values",
      "become the input's enum, or a query the site encodes as typed. An opaque filter code still comes",
      "only from a link the page produced in this run (below). Otherwise it uses the page's controls.",
      "It builds that URL with `URLSearchParams` for a query part or `encodeURIComponent` for a path",
      "part and every other part copied as the site wrote it, once the build checked that it gives the same answer as the controls. At run time it reads every input",
    ],
  },
  {
    sectionKey: "search",
    off: [
      "On every run, set each input the site has a control for through that control, or through the URL",
      "or data request the site itself uses for it when the control is unreliable (testing skill), never",
      "by filtering the returned rows, then read it back from the site's committed state: the",
    ],
    on: [
      "On every run, set each input the site has a control for through that control, through the",
      'results URL when the site\'s URL reliably carries it (`AGENTS.md`, "Work through the page\'s own',
      'controls"), or through the data request the site itself uses for it when the control is',
      "unreliable (testing skill), never by filtering the returned rows, then read it back from the site's committed state: the",
    ],
  },
  {
    sectionKey: "search",
    off: [
      "Try the fast path first. While exploring, check whether the page's own data request or embedded",
      "data carries the result fields. When it does, the default design is: reach the results through",
      "the page's controls, then read that data in the same session, reading the applied location back",
      "from the page or that answer. Read rendered rows only when it doesn't. For a data request, prefer",
      "catching the page's own answer in the same call as the step that sends it",
      "(`Promise.all([page.waitForResponse(...), button.click()])`, core skill). Fetching it in the page",
      "(`page.evaluate(() => fetch(...))`) is fine to speed things up or when that answer can't be",
      "caught, once the page itself has reached the results, not as the only step.",
    ],
    on: [
      "Try the fast path first. While exploring, check whether the results page loads directly by URL",
      'with the inputs encoded (`AGENTS.md`, "Work through the page\'s own controls"), and whether the',
      "page's own data request or embedded data carries the result fields. When both hold, the default",
      "design is: set a location or store through the page's controls first if the URL cannot carry it,",
      "load the results URL, then read that data in the same session, reading the applied location back",
      "from the page or that answer. Drive the search form and read rendered rows only when they don't.",
      "For a data request, prefer catching the page's own answer in the same call as the step that sends",
      "it (`Promise.all([page.waitForResponse(...), button.click()])`, core skill). Fetching it in the",
      "page (`page.evaluate(() => fetch(...))`) is fine to speed things up or when that answer can't be",
      "caught, once the page itself has reached the results, not as the only step.",
    ],
  },
];

/** `render`, with the search URL fast path's lines in place of the files' own. */
const withSearchUrlFastPath =
  (render: AuthoringRender): AuthoringRender =>
  (text, sectionKey) =>
    searchUrlFastPathPassages.reduce((rendered, { sectionKey: key, off, on }) => {
      if (key !== sectionKey) return rendered;
      const parts = rendered.split(off.join("\n"));
      if (parts.length !== 2)
        throw new Error(`Authoring ${sectionKey} lacks one search URL fast path passage`);
      return parts.join(on.join("\n"));
    }, render(text, sectionKey));

/**
 * What a host may turn on in the authoring it loads. `searchUrlFastPath` renders the search URL
 * fast path (`searchUrlFastPathPassages`). It is off when absent, and the local host leaves it off.
 */
export type AuthoringOptions = { readonly searchUrlFastPath?: boolean };

const hostRender = (render: AuthoringRender, options: AuthoringOptions) =>
  options.searchUrlFastPath === true ? withSearchUrlFastPath(render) : render;

const readGuideFile = (
  directory: string,
  path: string,
  sectionKey: string,
  render: AuthoringRender,
) =>
  Effect.tryPromise({
    try: async () =>
      render(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readScopedFile(directory, `workspace/${path}`),
        ),
        sectionKey,
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "workspace_guide",
          error,
          context: { path },
        }),
        code: "Unavailable",
      }),
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadWorkspaceGuide = (
  directory: string,
  render: AuthoringRender = standaloneText,
  options: AuthoringOptions = {},
): Effect.Effect<WorkspaceGuide, MintFailure> =>
  Effect.gen(function* () {
    const rendering = hostRender(render, options);
    const instructions = yield* readGuideFile(directory, "AGENTS.md", "agents", rendering);
    const files = new Map([["AGENTS.md", instructions]]);
    for (const { path, sectionKey } of workspaceGuideFiles)
      files.set(path, yield* readGuideFile(directory, path, sectionKey, rendering));
    files.set(publicationReviewRules.path, publicationReviewRules.text);
    return { instructions, files };
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadAuthoringSkills = (
  directory: string,
  render: AuthoringRender = standaloneText,
  options: AuthoringOptions = {},
): Effect.Effect<readonly SkillDescriptor[], MintFailure> =>
  Effect.tryPromise({
    try: async () =>
      Promise.all(
        catalog.map(async (entry): Promise<SkillDescriptor> => {
          const references: Record<string, ReturnType<typeof file>> = {};
          for (const name of entry.references)
            references[name] = file({
              content: await readScopedFile(directory, `examples/${name}`),
            });
          return {
            name: entry.name,
            description: entry.description,
            content: new TextEncoder().encode(
              hostRender(render, options)(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  await readScopedFile(directory, `${entry.name}/SKILL.md`),
                ),
                entry.name,
              ),
            ),
            references,
          };
        }),
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "authoring_skills",
          error,
          context: { skillCount: catalog.length },
        }),
        code: "Unavailable",
      }),
  });

/**
 * A reference file's inline text, or undefined for an entry that is not an inline file, such as a
 * directory or a file on disk, or for content that is not UTF-8 text.
 */
const referenceText = (entry: NonNullable<SkillDescriptor["references"]>[string]) => {
  if (entry.type !== "file") return undefined;
  if (typeof entry.content === "string") return entry.content;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
  } catch {
    return undefined;
  }
};

/**
 * Each skill's text and reference files at the paths the minter reads them,
 * `.agents/<name>/SKILL.md` and `.agents/<name>/references/<file>`, for a review that may read the
 * skills the minter followed and the examples they point to. A skill's text or reference file that
 * is not inline text is left out.
 */
export const skillReferenceFiles = (
  skills: readonly SkillDescriptor[],
): ReadonlyMap<string, string> =>
  new Map(
    skills.flatMap(({ name, content, references = {} }) => {
      const text =
        typeof content === "string"
          ? content
          : content instanceof Uint8Array
            ? new TextDecoder().decode(content)
            : undefined;
      return [
        ...(text === undefined ? [] : [[`.agents/${name}/SKILL.md`, text] as const]),
        ...Object.entries(references).flatMap(([fileName, entry]) => {
          const reference = referenceText(entry);
          return reference === undefined
            ? []
            : [[`.agents/${name}/references/${fileName}`, reference] as const];
        }),
      ];
    }),
  );

/**
 * The local host's authoring: standalone text, with the hosted features its minter is to ignore on
 * top of `AGENTS.md`, both as instructions and as the workspace file.
 */
export const loadStandaloneAuthoring = (directory: string) =>
  Effect.gen(function* () {
    const guide = yield* loadWorkspaceGuide(directory);
    const skills = yield* loadAuthoringSkills(directory);
    if (hostedFeaturesPreamble === "") return { ...guide, skills };
    const instructions = `${hostedFeaturesPreamble}\n\n${guide.instructions}`;
    const files = new Map(
      [...guide.files].map(([path, text]) => [path, path === "AGENTS.md" ? instructions : text]),
    );
    return { instructions, files, skills };
  });

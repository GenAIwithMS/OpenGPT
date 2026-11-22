import { Effect, Either, Schema } from "effect";
import { expectedConfirmLimit } from "../browser/dialogs/expected.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { MintFailure, type MintDependencies } from "../mint/contracts.js";
import { runnableOperationFiles, savedOperationFiles } from "../mint/operation-source.js";
import {
  exampleOutputEvidence,
  exampleOutputPath,
  outputDigest,
  outputDigestNote,
  outputDigestPath,
  publicationEvidenceNote,
  publicDefinition,
  requestedOutputFields,
  reviewPublication,
  sessionEvidenceFiles,
  sessionOutputPath,
  sessionStepPath,
  type ExampleOutputSource,
} from "../mint/publication-review.js";
import { contractExtractionNote } from "../mint/review-context.js";
import { outputNotes, outputNotesPath } from "../mint/output-notes.js";
import { skillReferenceFiles } from "../mint/skills.js";
import { oneTimeLoginUrlParameters, refuseCredentialParts } from "../mint/login-url.js";
import { holdsSecretHandle } from "../mint/secret-handles.js";
import { holdsFileHandle } from "../mint/file-handles.js";
import { fileReadback } from "../mint/file-readback.js";
import { cardReadback } from "../mint/card-readback.js";
import type { PublishedSignIn } from "../mint/sign-in-recorder.js";
import { checkSignInVersion } from "../mint/sign-in-version.js";
import { sourceDigest } from "../mint/step-checks.js";
import { liveTestsEvidencePath } from "../mint/live-tests.js";
import { checkWriteSession } from "../mint/write-session.js";
import {
  awsAccessKeyIdPattern,
  isProviderKey,
  providerKeyPattern,
} from "../privacy/credential-policy.js";
import type { MintState } from "./mint-state.js";
import { SignInOrigin } from "./contracts.js";
import { publicationError } from "./errors.js";

type Run = MintState["runs"] extends Map<string, infer Value> ? Value : never;

/** Bind completion to the actual retained example or confirmed write step. */
const retainedPublicationSample = (
  state: MintState,
  evidence: Parameters<MintDependencies["publish"]>[1],
  entrypoint: string,
) =>
  Effect.suspend(() => {
    const { runs } = state;
    const sample = runs.get(evidence.executionId);
    if (
      sample === undefined ||
      !(
        (sample.purpose === "act" && evidence.confirmation !== undefined) ||
        (evidence.status === "completed" && evidence.resultRef === `local:${evidence.executionId}`)
      ) ||
      (sample.purpose !== "act" && sample.entrypoint !== entrypoint)
    )
      return Effect.fail(new MintFailure({ code: "ScopeDenied" }));
    return Effect.succeed(sample);
  });

/**
 * A build publishes nothing that rests on a live step the host ran after it sent a login no check
 * verified, unless it holds a recorded sign-in: such a step may have run signed in, its runs could
 * not sign in, and the build took the task to need the account. A write rests on every act step
 * of its session, since its composed script is judged against all of them; a read on the step it
 * publishes, an example or an explore. A sign-in the build verifies later records one, and then
 * the build publishes.
 */
const unverifiedSignInRefusal = (state: MintState, sample: Run) =>
  Effect.suspend(() => {
    const rests =
      sample.purpose === "act"
        ? [...state.runs.values()].some(
            (run) => run.purpose === "act" && run.afterUnverifiedSignIn === true,
          )
        : sample.afterUnverifiedSignIn === true;
    if (!rests || state.recorder.published() !== undefined) return Effect.void;
    return Effect.fail(
      new MintFailure({
        code: "PublicationUnavailable",
        reason: "autofill_recipe_not_verified",
      }),
    );
  });

/**
 * The build's https sign-in origins, as the tool saves them with a published sign-in: the
 * request's that are https origins, same-site ones included. None when there are none, so a build
 * without them saves what it always did.
 */
const savedSignInOrigins = (state: MintState) => {
  const origins = state.signInOrigins
    .all()
    .filter((origin) => Schema.is(SignInOrigin)(origin));
  return origins.length === 0 ? {} : { authenticationOrigins: origins };
};

/**
 * The step's retained output as publication review reads it: redacted of the build's secrets,
 * then held back whole if a secret is still in it. A step that kept none is `not_retained`.
 */
const outputEvidence = (state: MintState, sample: Run, source: ExampleOutputSource) =>
  Effect.gen(function* () {
    const { secrets, projection } = state.session;
    const screened =
      sample.output === undefined
        ? undefined
        : JSON.stringify(yield* projection.json(sample.output));
    return yield* exampleOutputEvidence(source, screened, (text) =>
      Effect.either(secrets.assertAbsent(text)).pipe(Effect.map(Either.isRight)),
    );
  });

/** 1-based line and column of an offset in the file as written. */
const position = (text: string, offset: number) => {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
};

const providerKey = providerKeyPattern();
const awsAccessKeyId = awsAccessKeyIdPattern();

/**
 * A saved file's first hard-coded provider key or AWS access key ID, refused as a publication gate
 * refuses one: the refusal names the file and where, never the key.
 */
export const providerKeyRefusal = (file: string, text: string): MintFailure | undefined => {
  const provider = [...text.matchAll(providerKey)].find((match) => isProviderKey(match[0]))?.index;
  const aws = text.search(awsAccessKeyId);
  const offsets = [provider, aws < 0 ? undefined : aws].filter((offset) => offset !== undefined);
  if (offsets.length === 0) return undefined;
  return new MintFailure({
    code: "PublicationUnavailable",
    reason: "source_screening",
    publicationBlock: {
      file,
      check: "provider_credential",
      entity: "API_TOKEN",
      ...position(text, Math.min(...offsets)),
    },
  });
};

/**
 * The build's verified sign-in as it ships, value-free: its recipe and the address its runs start
 * from. The login URL, name, description and site naming are refused every time one holds a
 * sign-in value the build was given, naming the part and never the value (`refuseCredentialParts`),
 * and a recipe holding one is refused too. A login URL that is one authorization request is asked
 * about once per URL (`login_url_one_time`); finishing again publishes it as it is.
 */
export const screenedSignIn = <E>(
  signIn: PublishedSignIn | undefined,
  metadata: {
    readonly name: string;
    readonly description: string;
    readonly siteName?: string | undefined;
    readonly siteSummary?: string | undefined;
  },
  assertAbsent: (text: string) => Effect.Effect<void, E>,
  oneTimeLoginUrlsAsked: Set<string>,
) =>
  Effect.gen(function* () {
    yield* refuseCredentialParts(
      {
        // This host registers values without their kinds, so a match names a credential.
        registeredSecretMatches: (text) =>
          Effect.either(assertAbsent(text)).pipe(
            Effect.map((absent) =>
              Either.isLeft(absent) ? [{ entity: "credential", supplied: true }] : [],
            ),
          ),
      },
      {
        loginUrl: signIn?.entryUrl,
        name: metadata.name,
        description: metadata.description,
        // Each part is screened on its own; a missing one is empty, which holds no value.
        site:
          metadata.siteName === undefined && metadata.siteSummary === undefined
            ? undefined
            : { name: metadata.siteName ?? "", summary: metadata.siteSummary ?? "" },
      },
    );
    if (signIn === undefined) return undefined;
    yield* assertAbsent(JSON.stringify(signIn.recipe));
    // One-time authorization values are not secrets, so this is advice: asked once, and finishing
    // again with the same URL publishes it as it is.
    const oneTimeParameters = oneTimeLoginUrlParameters(signIn.entryUrl);
    if (oneTimeParameters.length > 0 && !oneTimeLoginUrlsAsked.has(signIn.entryUrl)) {
      oneTimeLoginUrlsAsked.add(signIn.entryUrl);
      return yield* new MintFailure({
        code: "PublicationUnavailable",
        reason: "login_url_one_time",
        publicationFeedback: { oneTimeParameters },
      });
    }
    return signIn;
  });

/**
 * The build's verified sign-in as the sign-in version check judges it (`checkSignInVersion`),
 * refused every time it fails, naming each rule and part, never a value. A one-time login URL the
 * host already asked about passes, so finishing again publishes it as before. The host passes no
 * identity values or signed-out pages: it no longer holds the login, and the recorder already
 * applied the identity guards to each screen and compared the marker with the build's signed-out
 * pages as it recorded the sign-in. A login URL, page or popup off the site's registrable domain
 * is refused (`foreign_origin`), on a sign-in origin the request declares in
 * `authenticationOrigins` too, and one that is not https (`insecure_origin`).
 */
const signInVersionRefusal = (
  signIn: PublishedSignIn,
  siteOrigin: string,
  oneTimeLoginUrlsAsked: ReadonlySet<string>,
): MintFailure | undefined => {
  const findings = checkSignInVersion({
    siteOrigin,
    version: signIn,
    signedOutSnapshots: [],
    entryUrlAsked: oneTimeLoginUrlsAsked.has(signIn.entryUrl),
  });
  return findings.length === 0
    ? undefined
    : new MintFailure({
        code: "PublicationUnavailable",
        reason: "sign_in_version_refused",
        publicationFeedback: { signInFindings: findings },
      });
};

export const mintPublication =
  (state: MintState): MintDependencies["publish"] =>
  (publication, evidence, hostEvidence) =>
    Effect.gen(function* () {
      const { runs, workspace, context, writeSession } = state;
      const { secrets, browser } = state.session;
      const sample = yield* retainedPublicationSample(state, evidence, publication.entrypoint);
      yield* unverifiedSignInRefusal(state, sample);
      const write = sample.purpose === "act";
      // A write's composed contract decodes the input its session ran: the agent's exampleInput
      // when the caller sent none, as the first act step that passed one fixed it, even when the
      // named step ran before it; else the caller's own.
      const input = write ? (writeSession.input ?? sample.input) : sample.input;
      // The composed contract, read offline: the files that ship, screened for secrets and
      // handles, reviewed by Guardian and run in contract mode on the input.
      const extract = Effect.gen(function* () {
        // What the operation can load ships: all of src/, the entrypoint and the probes it imports.
        const snapshot = new Map(yield* workspace.snapshot);
        const files = savedOperationFiles(snapshot, publication.entrypoint);
        const sources = [...files];
        for (const [path, text] of sources) {
          yield* secrets.assertAbsent(text);
          const refused = providerKeyRefusal(path, text);
          if (refused !== undefined) return yield* Effect.fail(refused);
        }
        const signIn = yield* screenedSignIn(
          state.recorder.published(),
          publication.metadata,
          secrets.assertAbsent,
          state.oneTimeLoginUrlsAsked,
        );
        const versionRefused =
          signIn === undefined
            ? undefined
            : signInVersionRefusal(signIn, context.siteOrigin, state.oneTimeLoginUrlsAsked);
        if (versionRefused !== undefined) return yield* Effect.fail(versionRefused);
        // Published code never holds a handle: no saved file the operation could run may hold one,
        // whatever its extension. That is every saved file when Node could load one its imports
        // don't name (see runnableOperationFiles). Otherwise a probe no import reaches, saved only
        // because the workspace has a package manifest, is not checked.
        const runnable = runnableOperationFiles(snapshot, publication.entrypoint);
        if ([...runnable.values()].some(holdsSecretHandle))
          return yield* Effect.fail(
            new MintFailure({
              code: "PublicationUnavailable",
              reason: "secret_handle",
            }),
          );
        // Nor a file handle, which names a caller's file only in this build.
        if ([...runnable.values()].some(holdsFileHandle))
          return yield* Effect.fail(
            new MintFailure({ code: "PublicationUnavailable", reason: "file_handle" }),
          );
        // Nor code that moves or reads a file outside the host's file service.
        const readback = fileReadback(runnable, state.fileHandles.files.length > 0);
        if (readback !== undefined)
          return yield* Effect.fail(
            new MintFailure({ code: "PublicationUnavailable", reason: "file_readback" }),
          );
        // Nor code that fills a card and could read it back. A tool asks for its own card at run
        // time, so only its source's fillCard turns the check on.
        if (cardReadback(runnable, false) !== undefined)
          return yield* Effect.fail(
            new MintFailure({ code: "PublicationUnavailable", reason: "card_readback" }),
          );
        yield* context.review({
          entrypoint: `operation/${publication.entrypoint}`,
          sources: new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
          input,
          currentExecution: { purpose: "contract", target: "pureFiles" },
          note: contractExtractionNote,
        });
        const result = yield* runLocalOperation({
          workspace,
          entrypoint: publication.entrypoint,
          sources,
          input,
          validateInput: true,
          ...(write ? {} : { retainedOutput: { value: sample.output } }),
          browser,
          mode: "contract",
          target: "pureFiles",
        });
        context.setInputSchema(result.schemas.input);
        return {
          files,
          sources,
          signIn,
          result,
          contract: result,
          outputSchema: result.schemas.output,
          inputDecodes: result.inputDecodes === true,
        };
      });
      // A write first proves its session may have sent the write, then that its composed contract
      // matches the session and names each step a confirm popup was accepted at. A confirmation
      // proves the write was sent; otherwise an act step Guardian labelled a write that may have
      // reached the site, unless the outcome review found it did not happen.
      const session = write
        ? yield* checkWriteSession({
            session: {
              steps: writeSession.steps.map(({ executionId, ...step }) => {
                const outcome = state.assessments.get(executionId)?.outcome;
                return outcome === undefined ? step : { ...step, assessment: outcome };
              }),
            },
            step: sample.journal,
            extract,
            confirms: { steps: writeSession.confirmSteps, entrypoint: publication.entrypoint },
            ...(writeSession.path === undefined ? {} : { writePath: writeSession.path }),
          })
        : undefined;
      const { files, sources, signIn, result } = session?.extracted ?? (yield* extract);
      const acts = [...runs].filter(([, run]) => run.purpose === "act");
      // A write is judged against the act session that performed it, since its composed script
      // never ran; a read against the example that ran, whose source Guardian reads as executed.
      const judged =
        session !== undefined
          ? {
              note: publicationEvidenceNote({
                kind: "write",
                writeConfirmation: session.declared,
                intentDerived: writeSession.input !== undefined,
              }),
              files: new Map([
                [
                  sessionOutputPath,
                  (yield* outputEvidence(state, sample, {
                    kind: "write_session_output",
                    executionId: evidence.executionId,
                    executedEntrypoint: sessionStepPath(
                      acts.findIndex(([id]) => id === evidence.executionId),
                      sample.entrypoint,
                    ),
                  })).text,
                ],
                ...sessionEvidenceFiles(
                  acts.map(([, run]) => ({
                    entrypoint: run.entrypoint,
                    files: new Map(run.sources),
                  })),
                ),
              ]),
              intentDerivedInput: writeSession.input,
            }
          : yield* Effect.gen(function* () {
              const notes = outputNotes({
                output: sample.output,
                outputSchema: result.schemas.output,
                inputSchema: result.schemas.input,
                ...(sample.controlLabels === undefined
                  ? {}
                  : { controlLabels: sample.controlLabels }),
                ...(publication.outputOverrides === undefined
                  ? {}
                  : { overrides: publication.outputOverrides }),
                ...(hostEvidence?.testedFields === undefined
                  ? {}
                  : { alsoTested: hostEvidence.testedFields }),
              });
              if (notes.blocking.length > 0)
                return yield* new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "output_checks_blocked",
                  outputFindings: notes.blocking.map(({ path, check, count }) => ({
                    path,
                    check,
                    count,
                  })),
                });
              const baseline = savedOperationFiles(new Map(sample.sources), sample.entrypoint);
              const output = yield* outputEvidence(state, sample, {
                executionId: evidence.executionId,
                executedEntrypoint: `executed/${sample.entrypoint}`,
                executedSourceDigest: sourceDigest(baseline),
              });
              // Every field of each list in the output, across all its records, including those
              // past what the output's record keeps.
              const digest =
                output.screened === undefined ? undefined : outputDigest(output.screened);
              return {
                digest,
                note: publicationEvidenceNote({
                  kind: "read",
                  entrypoint: sample.entrypoint,
                  completed: evidence.status === "completed",
                  schemasReadOffline: sourceDigest(baseline) !== sourceDigest(files),
                }),
                files: new Map([
                  [exampleOutputPath, output.text],
                  ...(notes.any ? [[outputNotesPath, notes.text] as const] : []),
                  ...(digest === undefined ? [] : [[outputDigestPath, digest] as const]),
                  ...(hostEvidence?.liveTests === undefined
                    ? []
                    : [
                        [
                          liveTestsEvidencePath,
                          JSON.stringify(hostEvidence.liveTests, null, 2),
                        ] as const,
                      ]),
                ]),
                baseline,
                intentDerivedInput: sample.intentDerivedInput,
              };
            });
      // A read's digest is named before what its review judges, as every host names it.
      const digestNote =
        "digest" in judged && judged.digest !== undefined ? `${outputDigestNote} ` : "";
      yield* reviewPublication(context.reviewPublication, {
        entrypoint: publication.entrypoint,
        files,
        definition: publicDefinition(publication.metadata, result.schemas),
        evidence: judged.files,
        ...("baseline" in judged ? { baseline: judged.baseline } : {}),
        notes: `${digestNote}${judged.note} Coverage: ${secrets.redact(publication.coverage)}`,
        inputSchema: result.schemas.input,
        outputSchema: result.schemas.output,
        // What the request declares in structure: the caller's own input and the output fields
        // its updates declared. Its prose declares nothing the host can check.
        requested: {
          input: context.input,
          outputs: requestedOutputFields(context.taskUpdates),
        },
        references: skillReferenceFiles(state.authoring.skills),
        ...(judged.intentDerivedInput === undefined
          ? {}
          : { intentDerivedInput: judged.intentDerivedInput }),
        write,
      });
      return {
        artifact: {
          files: sources.map(([path, content]) => ({ path, content })),
          entrypoint: publication.entrypoint,
          inputSchema: result.schemas.input,
          outputSchema: result.schemas.output,
          ...(signIn === undefined ? {} : { signIn: { ...signIn, ...savedSignInOrigins(state) } }),
          // Always recorded, so a run falls back to reading the source only for an artifact saved
          // before builds recorded them.
          questions: result.schemas.questions ?? {},
          ...(write && writeSession.acceptedConfirms.length > 0
            ? { acceptedConfirms: writeSession.acceptedConfirms.slice(0, expectedConfirmLimit) }
            : {}),
        },
        diagnostics: [],
      };
    }).pipe(Effect.mapError(publicationError));

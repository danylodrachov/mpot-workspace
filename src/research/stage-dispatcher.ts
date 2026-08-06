import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { initializeRun, type InitializeRunConfig, type InitializeRunResult, type RunContext } from "./discovery-orchestrator.ts";
import { writeAppendOnlyJSONL } from "./artifact-writer.ts";
import type { RunEvent } from "./run-events.ts";
import type { RecipeStepV1, ExtractorInput } from "./url-map-recon/types.ts";
import type { ScorerGate } from "./relevance-gate-coordinator.ts";
import type { ScorerOutput } from "./url-field-relevance-scorer.types.ts";
import type { PageObservationProvider } from "./page-interactivity-profiler.ts";
import type { InteractionObservationProvider } from "./interaction-delta-profiler.ts";
import type { ProductObservationProvider } from "./url-map-recon/product-collector.ts";
import type { GapProbeRequest, GapProbeResult } from "./gap-validator.ts";
import { EXTRACTOR_IDS, OBSERVATION_KINDS, EXTRACTOR_ENTRY_SOURCE, type ExtractorId } from "./url-map-recon/types.ts";
import type { PageObservation, ExtractorInputContractMismatch } from "./url-map-recon/types.ts";
import { PAGE_BEHAVIOR_ARTIFACT } from "./discovery-types.ts";

/**
 * Thrown by the stage 1 (Stage 3 extraction) handler when `extractAndPersist`
 * reports one or more `EXTRACTOR_INPUT_CONTRACT_MISMATCH` failures (Issue 29).
 * This is an internal pipeline invariant failure, never a source-family error:
 * it must never be folded into ordinary blocked/absent/unsupported partial-run
 * semantics. Any caller catching this must stop the run outright rather than
 * continue dispatching downstream stages (Issue 30). Generic over any future
 * internal contract mismatch reported by Stage 3, not specific to one extractor.
 */
export class ExtractorContractViolationError extends Error {
  violations: ExtractorInputContractMismatch[];
  constructor(violations: ExtractorInputContractMismatch[]) {
    super(
      `Extractor input contract mismatch: ${violations
        .map((v) => `${v.extractorId} (observation ${v.observationId ?? "unknown"}) expected ${v.expectedInputTypes.join("/")}, got ${v.receivedInputType}`)
        .join("; ")}`,
    );
    this.name = "ExtractorContractViolationError";
    this.violations = violations;
  }
}

/**
 * Thrown when a recorded observation's `extractor_id` is not a registered URL
 * extractor (Issue 27, AC: "An unknown extractor ID fails explicitly"). Recipe
 * building must never silently substitute a known extractor (e.g.
 * `DOM_URL_ATTRIBUTES_V1`) for one it doesn't recognize.
 */
export class UnknownExtractorError extends Error {
  extractorId: string;
  constructor(extractorId: string) {
    super(`Unknown extractor id recorded in observations: ${extractorId}`);
    this.name = "UnknownExtractorError";
    this.extractorId = extractorId;
  }
}

/**
 * Thrown by `stageDispatcher()` before stage 1 runs when neither `observationsPath`
 * nor any explicit provider (input/page/interaction/product) was supplied (Issue 32,
 * AC4). A dispatch with no observation source must refuse to start rather than walk
 * the stage sequence and report per-stage pending/failure noise against empty input.
 */
export class MissingObservationSourceError extends Error {
  code = "MISSING_OBSERVATION_SOURCE" as const;
  constructor() {
    super(
      "No observation source supplied: pass observationsPath, or one of inputProvider/" +
        "pageObservationProvider/interactionObservationProvider/productObservationProvider.",
    );
    this.name = "MissingObservationSourceError";
  }
}

const EXTRACTOR_ID_SET = new Set<string>(EXTRACTOR_IDS);
const OBSERVATION_KIND_SET = new Set<string>(OBSERVATION_KINDS);

/**
 * Build one extraction recipe step per unique URL extractor id recorded in
 * `observations`, in stable first-seen order (Issue 27). Behavior/interaction/
 * product observation kinds (stage 8/9/12 seams) are not URL extractors and are
 * skipped here. Anything else is a genuinely unknown extractor id and fails
 * explicitly rather than being dropped or silently replaced.
 */
function buildStepsFromObservations(observations: PageObservation[]): RecipeStepV1[] {
  const seen = new Set<string>();
  const steps: RecipeStepV1[] = [];
  for (const obs of observations) {
    if (OBSERVATION_KIND_SET.has(obs.extractor_id)) continue;
    if (seen.has(obs.extractor_id)) continue;
    seen.add(obs.extractor_id);
    if (!EXTRACTOR_ID_SET.has(obs.extractor_id)) {
      throw new UnknownExtractorError(obs.extractor_id);
    }
    const extractorId = obs.extractor_id as ExtractorId;
    steps.push({
      extractorId,
      pageUrl: obs.page_url,
      source: EXTRACTOR_ENTRY_SOURCE[extractorId],
      resultType: "url_list",
    });
  }
  return steps;
}

/**
 * Supplies a raw probe result for one addressable gap, or `undefined` when no probe
 * capability is available (e.g. recorded-fixture runs with nothing to replay). The
 * dispatcher validates whatever is returned before merging it — this provider is never
 * trusted directly.
 */
export type GapProbeProvider = (request: GapProbeRequest) => GapProbeResult | undefined;

/**
 * Input provider for recorded fixture data (used for stages 1-5 extraction).
 * Supplies page HTML/JSON for each extraction step without touching a browser.
 */
export type InputProvider = (step: RecipeStepV1, index: number) => ExtractorInput;

/**
 * Configuration for stage dispatcher.
 */
export interface StageDispatcherConfig extends InitializeRunConfig {
  run_id?: string;
  inputProvider?: InputProvider;
  pageObservationProvider?: PageObservationProvider;
  interactionObservationProvider?: InteractionObservationProvider;
  productObservationProvider?: ProductObservationProvider;
  gapProbeProvider?: GapProbeProvider;
  /**
   * Path to a `page-observations.jsonl` file written by a browser agent (Issue 24).
   * When supplied, any of the four providers above left unset are derived from the
   * recorded observations instead, and the run records `observation_provider:
   * { provider_type: 'live_browser' }` on its run context. Providers passed explicitly
   * always win over observation-derived ones.
   */
  observationsPath?: string;
  /**
   * Path to a run directory already bootstrapped by `initializeRun()` (Issue 32). When
   * supplied, `stageDispatcher()` attaches to that run instead of minting a new one —
   * `run-context.json` must already exist there. Lets a caller create the run directory
   * first (so a browser agent has an `output_dir` to write `page-observations.jsonl`
   * into) and dispatch stages into it afterwards. Omitted (the default): every current
   * caller mints a new run exactly as before.
   */
  existingRunDir?: string;
}

/**
 * Result of successful stage dispatch.
 */
export interface StageDispatchResult extends InitializeRunResult {
  final_report?: string;
  pending_stages?: number[];
  needs_llm?: false;
}

/**
 * Returned instead of `StageDispatchResult` when the run reaches stage 6 and
 * needs the relevance scorer agent invoked. The payload carries exactly the
 * scorer's input: compiled field requirements and classified URL metadata.
 * No other stage may read run state until `resumeAfterRelevanceScoring` has
 * persisted and validated the scorer's reply.
 */
export interface StageDispatchGate {
  needs_llm: true;
  run_id: string;
  run_dir: string;
  casino_id: string;
  gate: ScorerGate;
  final_report: string;
  pending_stages: number[];
}

export type StageDispatchOutcome = StageDispatchResult | StageDispatchGate;

const VALID_TRANSITIONS: Record<number, number[]> = {
  1: [2],
  2: [3],
  3: [4],
  4: [5],
  5: [6],
  6: [7],
  7: [8],
  8: [9],
  9: [10],
  10: [11],
  11: [12],
  12: [13, 16], // Can loop to 13 for gap probing or finish at 16
  13: [14],
  14: [15],
  15: [12], // Loop back to 12
  16: [], // Terminal
};

/**
 * Dispatch stages 1-16 sequentially through the pipeline.
 *
 * Validates transitions against the declared graph, writes trace events for each stage,
 * and reports pending stages (those without real implementations yet).
 *
 * Stages 1-5 use real implementations when an inputProvider is supplied. When the run
 * reaches stage 6 with field requirements and classified URLs already on disk, dispatch
 * stops and returns a `StageDispatchGate` — the caller must invoke the relevance scorer
 * agent and call `resumeAfterRelevanceScoring` to continue.
 */
export async function stageDispatcher(config: StageDispatcherConfig): Promise<StageDispatchOutcome> {
  const resolvedConfig = await resolveObservationProviders(config);
  assertHasObservationSource(resolvedConfig);
  const initResult = resolvedConfig.existingRunDir
    ? await attachExistingRun(resolvedConfig.existingRunDir)
    : await initializeRun(resolvedConfig);
  return dispatchFrom(1, initResult, resolvedConfig);
}

/**
 * Refuses to dispatch when no observation source is available for stages 1-5, rather
 * than walking the stage sequence and reporting pending/failure noise against empty
 * input (Issue 32, AC4).
 */
function assertHasObservationSource(
  config: Pick<
    StageDispatcherConfig,
    "inputProvider" | "pageObservationProvider" | "interactionObservationProvider" | "productObservationProvider"
  >,
): void {
  if (
    !config.inputProvider &&
    !config.pageObservationProvider &&
    !config.interactionObservationProvider &&
    !config.productObservationProvider
  ) {
    throw new MissingObservationSourceError();
  }
}

/**
 * Attaches dispatch to a run directory an earlier `initializeRun()` call already
 * bootstrapped (Issue 32), instead of minting a second run. Fails loudly if the
 * directory was never bootstrapped.
 */
async function attachExistingRun(run_dir: string): Promise<InitializeRunResult> {
  const run_context_path = path.join(run_dir, "run-context.json");
  if (!fs.existsSync(run_context_path)) {
    throw new Error(
      `Cannot attach to run at ${run_dir}: run-context.json not found. Bootstrap the run with initializeRun() first.`,
    );
  }
  const run_context = JSON.parse(fs.readFileSync(run_context_path, "utf-8")) as RunContext;
  return {
    run_id: run_context.run_id,
    casino_id: run_context.casino_id,
    geo: run_context.geo,
    run_dir,
    canonical_origin: run_context.canonical_origin,
  };
}

/**
 * When `observationsPath` is supplied, reads the recorded observations once and fills
 * in any of the four provider slots the caller left unset, plus the run context's
 * `observation_provider` metadata. Explicit providers are never overridden.
 */
async function resolveObservationProviders<
  T extends Pick<
    StageDispatcherConfig,
    | "inputProvider"
    | "pageObservationProvider"
    | "interactionObservationProvider"
    | "productObservationProvider"
    | "observationsPath"
  > & { observation_provider?: StageDispatcherConfig["observation_provider"] },
>(config: T): Promise<T> {
  if (!config.observationsPath) return config;

  const {
    readObservations,
    createUrlInputProvider,
    createPageObservationProvider,
    createInteractionObservationProvider,
    createProductObservationProvider,
  } = await import('./observation-provider.ts');

  const observations = readObservations(config.observationsPath);

  return {
    ...config,
    inputProvider: config.inputProvider ?? createUrlInputProvider(observations),
    pageObservationProvider: config.pageObservationProvider ?? createPageObservationProvider(observations),
    interactionObservationProvider:
      config.interactionObservationProvider ?? createInteractionObservationProvider(observations),
    productObservationProvider: config.productObservationProvider ?? createProductObservationProvider(observations),
    observation_provider: config.observation_provider ?? {
      provider_type: 'live_browser',
      provider_name: 'observation-provider',
      observations_path: config.observationsPath,
    },
  };
}

/**
 * Resume a run after the caller has invoked the relevance scorer agent and received
 * its reply. Persists the reply verbatim, validates it, runs stage 7's deterministic
 * visit-plan builder, then continues to stage 8 through the ordinary transition rules —
 * not through a special-cased resume path.
 */
export async function resumeAfterRelevanceScoring(
  gateResult: StageDispatchGate,
  scorerReply: ScorerOutput,
  config: Pick<
    StageDispatcherConfig,
    | "inputProvider"
    | "pageObservationProvider"
    | "interactionObservationProvider"
    | "productObservationProvider"
    | "gapProbeProvider"
    | "observationsPath"
  > = {},
): Promise<StageDispatchOutcome> {
  config = await resolveObservationProviders(config);
  const { persistScorerReplyAndValidate, stage7_VisitPlanning } = await import("./relevance-gate-coordinator.ts");
  const traceEventsPath = path.join(gateResult.run_dir, "trace-events.jsonl");

  const scoreResult = await persistScorerReplyAndValidate(
    gateResult.gate,
    scorerReply,
    gateResult.run_dir,
    traceEventsPath,
  );

  await stage7_VisitPlanning(gateResult.run_dir, gateResult.run_id, traceEventsPath, scoreResult.validation_passed);

  const initResult = await attachExistingRun(gateResult.run_dir);

  return dispatchFrom(8, initResult, config);
}

/**
 * Walk the stage sequence starting at `startStage`, running handlers for
 * implemented stages and stopping early with a gate if stage 6 is reached
 * and needs the relevance scorer.
 */
async function dispatchFrom(
  startStage: number,
  initResult: InitializeRunResult,
  config: Pick<
    StageDispatcherConfig,
    | "inputProvider"
    | "pageObservationProvider"
    | "interactionObservationProvider"
    | "productObservationProvider"
    | "gapProbeProvider"
    | "observationsPath"
  >,
): Promise<StageDispatchOutcome> {
  const IMPLEMENTED_STAGES = new Set<number>(
    config.inputProvider ? [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16] : [8, 9, 10, 11, 12, 13, 14, 15, 16]
  );

  const pendingStages: number[] = [];
  const traceEventsPath = path.join(initResult.run_dir, "trace-events.jsonl");

  const stageSequence = computeStageSequence(VALID_TRANSITIONS);
  const startIndex = stageSequence.indexOf(startStage);
  if (startIndex === -1) {
    throw new Error(`Cannot resume dispatch from unknown stage ${startStage}`);
  }

  for (let i = startIndex; i < stageSequence.length; i++) {
    const stage = stageSequence[i];

    if (stage === 6) {
      const fieldRequirementsPath = path.join(initResult.run_dir, "field-requirements.json");
      const classifiedUrlsPath = path.join(initResult.run_dir, "clean-url-inventory.json");

      if (fs.existsSync(fieldRequirementsPath) && fs.existsSync(classifiedUrlsPath)) {
        const { buildRelevanceGate } = await import("./relevance-gate-coordinator.ts");
        const gate = await buildRelevanceGate(initResult.run_dir, initResult.run_id, traceEventsPath);

        return {
          needs_llm: true,
          run_id: initResult.run_id,
          run_dir: initResult.run_dir,
          casino_id: initResult.casino_id,
          gate,
          final_report: `Stage dispatch paused at stage 6: awaiting relevance scorer output for run ${initResult.run_id}.`,
          pending_stages: pendingStages,
        };
      }

      // Stages 1-5 never ran for this dispatch (no field requirements / classified URLs
      // on disk yet) — stage 6 has nothing to gate on. Record it pending and move on.
      pendingStages.push(stage);
      await writeAppendOnlyJSONL(traceEventsPath, pendingStageEvent(initResult.run_id, stage));
      continue;
    }

    if (stage === 7) {
      // Stage 7 only runs to completion via resumeAfterRelevanceScoring. Reaching it
      // here means stage 6 was skipped (no gate was ever issued for this dispatch).
      pendingStages.push(stage);
      await writeAppendOnlyJSONL(traceEventsPath, pendingStageEvent(initResult.run_id, stage));
      continue;
    }

    const isImplemented = IMPLEMENTED_STAGES.has(stage);
    let status: "pending" | "running" | "completed" | "blocked" | "error" = isImplemented
      ? "completed"
      : "pending";

    let caughtError: unknown;
    if (!isImplemented) {
      pendingStages.push(stage);
    } else {
      try {
        await runStageHandler(stage, initResult.run_dir, config, initResult.casino_id);
        if (stage === 15) {
          await runGapProbeLoop(initResult.run_dir, initResult.run_id, initResult.casino_id, config, traceEventsPath);
        }
      } catch (error) {
        status = "error";
        caughtError = error;
        console.error(`Stage ${stage} failed:`, error);
      }
    }

    const stageEvent: RunEvent = {
      run_id: initResult.run_id,
      event_id: crypto.randomUUID(),
      actor: "orchestrator",
      module: "stage-dispatcher",
      stage: stage,
      action: "stage_visited",
      status: status,
      timestamp: new Date().toISOString(),
    };
    await writeAppendOnlyJSONL(traceEventsPath, stageEvent);

    if (caughtError instanceof ExtractorContractViolationError) {
      // Internal pipeline invariant failure (Issue 30): no successful Stage 3
      // completion state was written (the stage_visited event above is
      // `error`), and the run must stop before any downstream stage — URL
      // cleaning, metadata classification, the Stage 6 gate, and the scorer —
      // does any work. Ordinary blocked/absent/unsupported source states never
      // throw this error and are unaffected.
      const violationEvent: RunEvent = {
        run_id: initResult.run_id,
        event_id: crypto.randomUUID(),
        actor: "system",
        module: "stage-dispatcher",
        stage: stage,
        action: "extractor_contract_violation",
        status: "error",
        timestamp: new Date().toISOString(),
        error: JSON.stringify({
          code: "EXTRACTOR_INPUT_CONTRACT_MISMATCH",
          violations: caughtError.violations,
        }),
      };
      await writeAppendOnlyJSONL(traceEventsPath, violationEvent);

      const remainingStages = stageSequence.slice(i + 1);
      pendingStages.push(...remainingStages);

      return {
        ...initResult,
        final_report: `Stage dispatch stopped: extractor input contract violation at stage ${stage} (${caughtError.violations
          .map((v) => v.extractorId)
          .join(", ")}). This is an internal pipeline invariant failure, not a partial-run source-family error. The run must be repeated after the extractor contract is fixed.`,
        pending_stages: pendingStages,
        needs_llm: false,
      };
    }
  }

  const pendingStagesStr = pendingStages.length > 0 ? pendingStages.join(", ") : "none";
  const finalReport = `Stage dispatch complete. Visited stages ${startStage}-16 in order. Pending stages: ${pendingStagesStr}`;

  return {
    ...initResult,
    final_report: finalReport,
    pending_stages: pendingStages,
  };
}

function pendingStageEvent(runId: string, stage: number): RunEvent {
  return {
    run_id: runId,
    event_id: crypto.randomUUID(),
    actor: "orchestrator",
    module: "stage-dispatcher",
    stage,
    action: "stage_visited",
    status: "pending",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run the handler for a specific stage (1-5 have real implementations).
 *
 * Each stage reads its inputs from the run directory and writes outputs there.
 */
async function runStageHandler(
  stage: number,
  runDir: string,
  config: Pick<
    StageDispatcherConfig,
    | "inputProvider"
    | "pageObservationProvider"
    | "interactionObservationProvider"
    | "productObservationProvider"
    | "gapProbeProvider"
    | "observationsPath"
  >,
  casinoId: string,
): Promise<void> {
  const inputProvider = config.inputProvider;
  // Lazy imports to avoid circular dependencies
  const { extractAndPersist } = await import("./url-map-recon/extraction-coordinator.ts");
  const { cleanAndPersist } = await import("./url-map-recon/url-clean.ts");
  const { classifyAndPersist } = await import("./url-map-recon/url-metadata-classifier.ts");
  const { compileTemplateRequirements } = await import("./template-requirements.ts");
  const fs = await import("node:fs");

  // Stages 1-2 must scope extraction/cleaning to this run's own validated canonical
  // origin (run-context.json), never a fixture literal (Issue 27).
  const runContextPath = path.join(runDir, "run-context.json");
  const readCanonicalOrigin = (): string => {
    const runContext = JSON.parse(fs.default.readFileSync(runContextPath, "utf-8")) as { canonical_origin: string };
    return runContext.canonical_origin;
  };

  switch (stage) {
    case 1: {
      // Stage 1: Deterministic URL extraction
      // Extract raw URL candidates using recorded input provider
      if (!inputProvider) {
        return; // Stage 1 requires input provider
      }

      const canonicalOrigin = readCanonicalOrigin();

      let steps: RecipeStepV1[];
      if (config.observationsPath) {
        // Live/recorded-observation run: request exactly the source families the
        // browser agent actually recorded, never a fabricated fixture recipe.
        const { readObservations } = await import("./observation-provider.ts");
        const observations = readObservations(config.observationsPath);
        steps = buildStepsFromObservations(observations);
      } else {
        // No recorded observations (fixture-provider run): fall back to a single
        // DOM extraction step scoped to this run's own casino origin.
        steps = [
          {
            extractorId: "DOM_URL_ATTRIBUTES_V1",
            pageUrl: canonicalOrigin,
            source: "dom_anchor",
            resultType: "url_list",
          },
        ];
      }

      // Parse casino ID to get geo and run ID from run dir path
      // runDir format: {baseDir}/{casinoId}/{geo}/{runId}
      const pathParts = runDir.split(path.sep);
      const geo = pathParts[pathParts.length - 2];
      const runId = pathParts[pathParts.length - 1];
      const baseDir = path.join(runDir, "..", "..", "..");

      const extractResult = await extractAndPersist(baseDir, casinoId, geo, runId, steps, inputProvider, canonicalOrigin);

      // An EXTRACTOR_INPUT_CONTRACT_MISMATCH is an internal pipeline invariant
      // failure, never a source-family error state — it must stop the run, not
      // become a partial-run outcome (Issue 30).
      if (extractResult.contractViolations.length > 0) {
        throw new ExtractorContractViolationError(extractResult.contractViolations);
      }
      break;
    }

    case 2: {
      // Stage 2: URL cleaning and decision logging
      // Read raw candidates and clean them
      const candidatesPath = path.join(runDir, "raw-url-candidates.json");
      if (!fs.default.existsSync(candidatesPath)) {
        // If no raw candidates, skip cleaning
        return;
      }

      const content = fs.default.readFileSync(candidatesPath, "utf-8");
      // raw-url-candidates.json entries carry provenance (source family, extractor
      // id, observation id) as of Issue 29; URL cleaning still operates on the flat
      // URL list itself (deterministic keep/drop rules are out of scope here).
      const rawCandidates = JSON.parse(content) as Array<{ url: string }>;
      const allUrls = rawCandidates.map((c) => c.url);

      await cleanAndPersist(runDir, allUrls, {
        origin: readCanonicalOrigin(),
        source: "dom_anchor",
      });
      break;
    }

    case 3:
    case 4: {
      // Stages 3-4: URL metadata classification
      // Classify cleaned URLs with metadata (page class, mandatory flags, etc.)
      await classifyAndPersist(runDir);
      break;
    }

    case 5: {
      // Stage 5: Template requirements compilation
      // Compile field requirements and dropdown catalog from templates
      // Templates are in docs/artifacts/json-templates/ (shared input, not run-specific)
      const templatesDir = path.resolve("docs/artifacts/json-templates");
      await compileTemplateRequirements(templatesDir, runDir);
      break;
    }

    case 8: {
      // Stage 8: Page interactivity profiling
      // Profile all selected pages from visit plan and write page-behavior.json
      const { profilePages } = await import("./page-interactivity-profiler.ts");
      const fs = await import("node:fs");

      // Read visit plan from stage 7
      const visitPlanPath = path.join(runDir, "visit-plan.json");
      if (!fs.default.existsSync(visitPlanPath)) {
        return; // No visit plan, skip profiling
      }

      const visitPlanContent = fs.default.readFileSync(visitPlanPath, "utf-8");
      const visitPlan = JSON.parse(visitPlanContent);

      // Read run context for profiling
      const runContextPath = path.join(runDir, "run-context.json");
      if (!fs.default.existsSync(runContextPath)) {
        return; // No run context, skip profiling
      }
      const runContextContent = fs.default.readFileSync(runContextPath, "utf-8");
      const runContext = JSON.parse(runContextContent);

      // Run profiling
      await profilePages(visitPlan, runContext, runDir, config.pageObservationProvider);
      break;
    }

    case 9:
    case 10: {
      // Stages 9-10: Interaction execution and delta profiling
      // Execute interactions for selected pages and record state deltas
      const { executeInteractions } = await import("./interaction-delta-profiler.ts");
      const fs = await import("node:fs");

      // Read visit plan and run context
      const visitPlanPath = path.join(runDir, "visit-plan.json");
      if (!fs.default.existsSync(visitPlanPath)) {
        return; // No visit plan, skip interaction execution
      }

      const visitPlanContent = fs.default.readFileSync(visitPlanPath, "utf-8");
      const visitPlan = JSON.parse(visitPlanContent);

      const runContextPath = path.join(runDir, "run-context.json");
      const runContextContent = fs.default.readFileSync(runContextPath, "utf-8");
      const runContext = JSON.parse(runContextContent);

      // Execute interactions (only run once, at stage 9; stage 10 verifies output exists)
      if (stage === 9) {
        await executeInteractions(visitPlan, runContext, runDir, config.interactionObservationProvider);
      } else {
        const interactionRecordsPath = path.join(runDir, "interaction-records.json");
        if (!fs.default.existsSync(interactionRecordsPath)) {
          throw new Error(`Stage 10: interaction-records.json missing; stage 9 must run first.`);
        }
      }
      break;
    }

    case 11:
    case 12: {
      // Stages 11-12: Field and product collection
      // Collect field evidence and product candidates from visited pages
      const { collectFieldEvidence } = await import("./field-collector.ts");
      const { collectAndPersistProductCandidates } = await import("./url-map-recon/product-collector.ts");

      const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
      const pageBehaviorPath = path.join(runDir, PAGE_BEHAVIOR_ARTIFACT);
      const visitPlanPath = path.join(runDir, "visit-plan.json");
      const fieldEvidencePath = path.join(runDir, "field-evidence.jsonl");
      const productCandidatesPath = path.join(runDir, "product-candidates.json");

      // Stage 11 collects field evidence; refuses to run before behaviour instructions exist.
      if (stage === 11) {
        await collectFieldEvidence(fieldRequirementsPath, pageBehaviorPath, fieldEvidencePath, visitPlanPath);
      }

      // Stage 12 collects product candidates; refuses to run before behaviour instructions exist.
      if (stage === 12) {
        await collectAndPersistProductCandidates(
          pageBehaviorPath,
          visitPlanPath,
          productCandidatesPath,
          config.productObservationProvider,
        );
      }
      break;
    }

    case 13: {
      // Stage 13: Completion and outcome reporting
      // Verify all collection stage outputs exist and are well-formed
      const fs = await import("node:fs");

      // Check that key artifacts exist; a missing artifact means the segment did not
      // complete and stage 13 must not silently report success.
      const expectedArtifacts = [
        path.join(runDir, PAGE_BEHAVIOR_ARTIFACT),
        path.join(runDir, "interaction-records.json"),
        path.join(runDir, "field-evidence.jsonl"),
        path.join(runDir, "product-candidates.json"),
      ];

      for (const artifactPath of expectedArtifacts) {
        if (!fs.default.existsSync(artifactPath)) {
          throw new Error(`Stage 13: expected artifact missing: ${artifactPath}`);
        }
      }
      break;
    }

    case 14: {
      // Stage 14: Normalisation and conflict resolution
      // Normalize field evidence candidates against dropdown catalog
      // and resolve conflicts based on completeness dimensions
      const { normalizeAndResolveFieldCandidates } = await import("./normalisers.ts");
      const fs = await import("node:fs");

      const fieldEvidencePath = path.join(runDir, "field-evidence.jsonl");
      const dropdownCatalogPath = path.join(runDir, "dropdown-catalog.json");

      // Only run if both inputs exist
      if (fs.default.existsSync(fieldEvidencePath) && fs.default.existsSync(dropdownCatalogPath)) {
        try {
          await normalizeAndResolveFieldCandidates(fieldEvidencePath, dropdownCatalogPath, runDir);
        } catch (error) {
          console.error(`Stage 14: Normalisation failed:`, error);
        }
      }
      break;
    }

    case 15: {
      // Stage 15: Coverage reporting and discovery delta
      // Assign terminal status to every field and produce delta against previous run
      const { generateFieldCoverage } = await import("./coverage-reporter.ts");
      const fs = await import("node:fs");

      const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
      const fieldEvidencePath = path.join(runDir, "field-evidence.jsonl");
      const normalisationPath = path.join(runDir, "normalisation-decisions.jsonl");
      const visitPlanPath = path.join(runDir, "visit-plan.json");
      const coveragePath = path.join(runDir, "field-coverage.json");
      const deltaPath = path.join(runDir, "discovery-delta.json");

      // Only run if inputs exist
      if (fs.default.existsSync(fieldRequirementsPath) && fs.default.existsSync(visitPlanPath)) {
        try {
          const previousCoveragePath = findPreviousRunCoveragePath(runDir);
          await generateFieldCoverage(
            fieldRequirementsPath,
            fieldEvidencePath,
            normalisationPath,
            visitPlanPath,
            coveragePath,
            deltaPath,
            previousCoveragePath
          );
        } catch (error) {
          console.error(`Stage 15: Coverage reporting failed:`, error);
        }
      }
      break;
    }

    case 16: {
      // Stage 16: Report rendering and completion
      // Generate the final discovery review artifact
      const { renderDiscoveryReport } = await import("./final-report-renderer.ts");
      const fs = await import("node:fs");

      const coveragePath = path.join(runDir, "field-coverage.json");
      const deltaPath = path.join(runDir, "discovery-delta.json");
      const reportPath = path.join(runDir, "discovery-review.json");
      const runContextPath = path.join(runDir, "run-context.json");
      const visitPlanPath = path.join(runDir, "visit-plan.json");

      // Only run if inputs exist
      if (
        fs.default.existsSync(coveragePath) &&
        fs.default.existsSync(deltaPath) &&
        fs.default.existsSync(runContextPath)
      ) {
        try {
          const runContextContent = fs.default.readFileSync(runContextPath, "utf-8");
          const runContext = JSON.parse(runContextContent);

          let visitPlan = { plan: [] };
          if (fs.default.existsSync(visitPlanPath)) {
            const visitPlanContent = fs.default.readFileSync(visitPlanPath, "utf-8");
            visitPlan = JSON.parse(visitPlanContent);
          }

          await renderDiscoveryReport(coveragePath, deltaPath, reportPath, runContext, visitPlan);
        } catch (error) {
          console.error(`Stage 16: Report rendering failed:`, error);
        }
      }
      break;
    }

    default:
      // Unknown stages are not implemented
      break;
  }
}

/**
 * Compute the sequence of stages to visit: the linear pipeline 1->2->...->15, followed
 * by stage 16. The optional gap-probe loop (13->14->15, repeated) is not part of this
 * static sequence — it runs dynamically inside `runGapProbeLoop`, driven by whatever
 * addressable gaps coverage actually reports, bounded by `MAX_GAP_PROBE_LOOPS`.
 */
function computeStageSequence(transitions: Record<number, number[]>): number[] {
  const sequence: number[] = [];
  for (let stage = 1; stage <= 16; stage++) {
    sequence.push(stage);
  }
  return sequence;
}

/** Maximum number of gap-probe iterations before a run finishes as partial rather than spinning. */
const MAX_GAP_PROBE_LOOPS = 2;

/**
 * Exported for direct black-box testing of the bounded gap-probe loop and the
 * previous-run lookup, whose real trigger point (immediately after stage 15 inside
 * `dispatchFrom`) is otherwise only reachable by driving an entire pipeline run.
 */
export { runGapProbeLoop, findPreviousRunCoveragePath };

/**
 * Locate the most recently modified sibling run directory (same casino/geo, excluding
 * the current run) that has a field-coverage.json — that run's coverage is what this
 * run's delta is computed against. Returns undefined on a first run for this casino/geo.
 */
function findPreviousRunCoveragePath(runDir: string): string | undefined {
  const geoDir = path.dirname(runDir);
  const currentRunFolder = path.basename(runDir);
  if (!fs.existsSync(geoDir)) return undefined;

  const candidates = fs
    .readdirSync(geoDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentRunFolder)
    .map((entry) => path.join(geoDir, entry.name, "field-coverage.json"))
    .filter((coveragePath) => fs.existsSync(coveragePath));

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * Drive the optional, bounded gap-probe loop after coverage has been generated.
 *
 * Each iteration: pick the first addressable gap (a `missing` field with a known URL),
 * ask `config.gapProbeProvider` for a raw probe result, validate it against the frozen
 * gap contract, and merge only the validated patch as new field evidence before
 * re-running normalisation and coverage. A probe that fails validation is discarded —
 * evidence and coverage are left untouched, but the attempt still counts against the
 * loop bound so a persistently-invalid probe cannot spin forever.
 *
 * No probe capability (`gapProbeProvider` absent) or no addressable gaps ends the loop
 * immediately without touching the bound. Hitting the bound with gaps still addressable
 * is recorded on run-context.json so the report renderer's completion status (naturally
 * `partial` while gaps remain) is backed by an auditable reason.
 */
async function runGapProbeLoop(
  runDir: string,
  runId: string,
  casinoId: string,
  config: Pick<StageDispatcherConfig, "gapProbeProvider">,
  traceEventsPath: string,
): Promise<void> {
  if (!config.gapProbeProvider) return;

  const deltaPath = path.join(runDir, "discovery-delta.json");
  const fieldEvidencePath = path.join(runDir, "field-evidence.jsonl");
  const dropdownCatalogPath = path.join(runDir, "dropdown-catalog.json");
  const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
  const visitPlanPath = path.join(runDir, "visit-plan.json");
  const coveragePath = path.join(runDir, "field-coverage.json");
  const normalisationPath = path.join(runDir, "normalisation-decisions.jsonl");

  const { validateGapProbeResult, validateAndMergeGapPatch } = await import("./gap-validator.ts");
  const { normalizeAndResolveFieldCandidates } = await import("./normalisers.ts");
  const { generateFieldCoverage } = await import("./coverage-reporter.ts");

  let iterations = 0;
  let boundHit = false;

  while (iterations < MAX_GAP_PROBE_LOOPS) {
    if (!fs.existsSync(deltaPath)) break;
    const delta = JSON.parse(fs.readFileSync(deltaPath, "utf-8"));
    const addressable = (delta.gaps ?? []).filter(
      (gap: { gap_type: string; visited_urls?: string[]; unvisited_urls?: string[] }) =>
        gap.gap_type === "missing" && ((gap.unvisited_urls?.length ?? 0) > 0 || (gap.visited_urls?.length ?? 0) > 0),
    );
    if (addressable.length === 0) break;

    const gap = addressable[0];
    const frozenUrl: string = gap.unvisited_urls?.[0] ?? gap.visited_urls[0];

    iterations++;

    const request: GapProbeRequest = {
      gap_id: `${runId}-${gap.field_id}-${iterations}`,
      casino_id: casinoId,
      field_id: gap.field_id,
      section: gap.category,
      frozen_url: frozenUrl,
      allowed_actions: [],
      stop_condition: "field_value_located_or_absent",
    };

    const rawResult = config.gapProbeProvider(request);
    if (!rawResult) break; // no probe available for this gap; loop cannot proceed further

    let validated;
    try {
      validated = validateGapProbeResult(rawResult, request, runDir);
    } catch (error) {
      await writeAppendOnlyJSONL(traceEventsPath, {
        run_id: runId,
        event_id: crypto.randomUUID(),
        actor: "orchestrator",
        module: "gap-validator",
        stage: 13,
        action: "gap_probe_rejected",
        status: "error",
        timestamp: new Date().toISOString(),
      } as RunEvent);
      // AC6: validation failure discards the result — coverage and evidence stay untouched.
      if (iterations >= MAX_GAP_PROBE_LOOPS) boundHit = true;
      continue;
    }

    validateAndMergeGapPatch(
      {
        gap_id: request.gap_id,
        field_id: gap.field_id,
        status: "accepted",
        value: validated.field_values?.find((v) => v !== null && v !== undefined) ?? undefined,
        timestamp: new Date().toISOString(),
      },
      runDir,
    );

    const acceptedValue = validated.field_values?.find((v) => v !== null && v !== undefined);
    if (acceptedValue) {
      await writeAppendOnlyJSONL(fieldEvidencePath, {
        field_id: gap.field_id,
        template: gap.category,
        field_name: gap.name,
        value: acceptedValue,
        url: frozenUrl,
        section: gap.category,
        interaction_state: "gap_probe",
        extraction_rule_id: "GAP_PROBE_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["visible"],
        truncated: false,
        timestamp: new Date().toISOString(),
      });
    }

    await writeAppendOnlyJSONL(traceEventsPath, {
      run_id: runId,
      event_id: crypto.randomUUID(),
      actor: "orchestrator",
      module: "gap-validator",
      stage: 13,
      action: "gap_probe_accepted",
      status: "completed",
      timestamp: new Date().toISOString(),
    } as RunEvent);

    if (fs.existsSync(dropdownCatalogPath)) {
      await normalizeAndResolveFieldCandidates(fieldEvidencePath, dropdownCatalogPath, runDir);
    }
    if (fs.existsSync(fieldRequirementsPath) && fs.existsSync(visitPlanPath)) {
      const previousCoveragePath = findPreviousRunCoveragePath(runDir);
      await generateFieldCoverage(
        fieldRequirementsPath,
        fieldEvidencePath,
        normalisationPath,
        visitPlanPath,
        coveragePath,
        deltaPath,
        previousCoveragePath,
      );
    }

    if (iterations >= MAX_GAP_PROBE_LOOPS) {
      // Re-check whether addressable gaps remain after this iteration's merge.
      const remainingDelta = fs.existsSync(deltaPath) ? JSON.parse(fs.readFileSync(deltaPath, "utf-8")) : { gaps: [] };
      const stillAddressable = (remainingDelta.gaps ?? []).some(
        (g: { gap_type: string }) => g.gap_type === "missing",
      );
      if (stillAddressable) boundHit = true;
    }
  }

  if (iterations > 0) {
    const runContextPath = path.join(runDir, "run-context.json");
    if (fs.existsSync(runContextPath)) {
      const runContext = JSON.parse(fs.readFileSync(runContextPath, "utf-8"));
      runContext.gap_loop = { iterations, bound_hit: boundHit };
      const tempPath = runContextPath + ".tmp";
      fs.writeFileSync(tempPath, JSON.stringify(runContext, null, 2));
      fs.renameSync(tempPath, runContextPath);
    }

    if (boundHit) {
      await writeAppendOnlyJSONL(traceEventsPath, {
        run_id: runId,
        event_id: crypto.randomUUID(),
        actor: "orchestrator",
        module: "gap-validator",
        stage: 13,
        action: "gap_loop_bound_hit",
        status: "completed",
        timestamp: new Date().toISOString(),
      } as RunEvent);
    }
  }
}

/**
 * Relevance Gate Coordinator (Stages 6-7)
 *
 * Stage 6 builds the LLM scoring gate payload — field requirements, classified
 * URLs, and nothing else — and hands it to the caller. The caller (the thin
 * launcher skill) invokes the relevance scorer agent and passes the reply back.
 *
 * `persistScorerReplyAndValidate` is the deterministic adapter that receives that
 * reply: it persists it verbatim as the untrusted raw artifact BEFORE any
 * validation, then validates it against the exact gate that was issued.
 *
 * Stage 7 then runs the deterministic relevance validator against the (possibly
 * invalid) raw reply, building the visit plan. A rejected reply makes the run
 * fail open: every URL stays eligible and the fail-open is recorded in the trace.
 *
 * Core invariants:
 * - Stage 6 invokes no agent itself; it only builds and returns the gate payload.
 * - No scoring, extraction, or validation logic lives outside this module and
 *   the deterministic validator it delegates to.
 * - Failed validation makes run fail-open (all URLs eligible for visiting).
 */

import path from "node:path";
import fs from "node:fs";
import type { ScorerInput, ScorerOutput, FieldRequirement, ClassifiedUrl } from "./url-field-relevance-scorer.types.ts";
import { validateScorerOutput } from "./url-field-relevance-scorer.types.ts";
import { validateRelevanceMatrix, buildVisitPlan, extractLlmRejectedUrls } from "./relevance-validator.ts";
import { writeAtomicJSON } from "./artifact-writer.ts";
import type { UrlMapEntry } from "./url-map-recon/types.ts";
import type { RunEvent } from "./run-events.ts";
import { writeAppendOnlyJSONL } from "./artifact-writer.ts";
import crypto from "node:crypto";

export interface ScorerGate {
  run_id: string;
  stage: number;
  field_requirements: FieldRequirement[];
  classified_urls: ClassifiedUrl[];
  request_id: string;
  timestamp: string;
}

/**
 * Deterministic stable id for a classified URL entry, keyed on its canonical
 * URL. The classifier does not always assign `url_id`; both stage 6 and
 * stage 7 must derive the same id independently from the same on-disk
 * inventory, so this is a pure function of canonicalUrl rather than a
 * counter or random value.
 */
function deriveUrlId(canonicalUrl: string): string {
  return crypto.createHash("sha1").update(canonicalUrl).digest("hex").slice(0, 16);
}

function withUrlIds<T extends { canonicalUrl: string; url_id?: string }>(entries: T[]): (T & { url_id: string })[] {
  return entries.map((entry) => ({ ...entry, url_id: entry.url_id || deriveUrlId(entry.canonicalUrl) }));
}

export interface ScorerGateResult {
  success: boolean;
  raw_artifact_path: string;
  validation_passed: boolean;
  error?: string;
  validation_errors?: string[];
}

/**
 * Stage 6: build the relevance scoring gate payload.
 *
 * Reads the field requirements and classified URLs produced by stages 1-5 and
 * returns a gate carrying exactly those two inputs plus request/run identity.
 * Does not invoke the scorer agent — that is the caller's job.
 */
export async function buildRelevanceGate(
  runDir: string,
  runId: string,
  traceEventsPath: string,
): Promise<ScorerGate> {
  const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
  const classifiedUrlsPath = path.join(runDir, "clean-url-inventory.json");

  if (!fs.existsSync(fieldRequirementsPath)) {
    throw new Error(`Field requirements not found at ${fieldRequirementsPath}`);
  }
  if (!fs.existsSync(classifiedUrlsPath)) {
    throw new Error(`Classified URLs not found at ${classifiedUrlsPath}`);
  }

  const fieldReqsData = JSON.parse(fs.readFileSync(fieldRequirementsPath, "utf-8"));
  const fieldRequirements: FieldRequirement[] = fieldReqsData.fields || fieldReqsData;

  const classifiedUrls: ClassifiedUrl[] = withUrlIds(JSON.parse(fs.readFileSync(classifiedUrlsPath, "utf-8")));

  const requestId = crypto.randomUUID();
  const gate: ScorerGate = {
    run_id: runId,
    stage: 6,
    field_requirements: fieldRequirements,
    classified_urls: classifiedUrls,
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };

  const gateEvent: RunEvent = {
    run_id: runId,
    event_id: crypto.randomUUID(),
    actor: "orchestrator",
    module: "relevance-gate",
    stage: 6,
    action: "gate_created",
    status: "blocked",
    timestamp: new Date().toISOString(),
    counts: {
      field_requirements: fieldRequirements.length,
      classified_urls: classifiedUrls.length,
    },
  };
  await writeAppendOnlyJSONL(traceEventsPath, gateEvent);

  return gate;
}

/**
 * Deterministic adapter for the scorer's reply.
 *
 * Persists the reply verbatim as the untrusted raw artifact BEFORE any
 * validation or downstream read, then validates it against the gate that
 * produced it. Malformed replies are retained as-is for audit; the run does
 * not drop URLs on the strength of an invalid score (stage 7 fails open).
 */
export async function persistScorerReplyAndValidate(
  gate: ScorerGate,
  scorerReply: ScorerOutput,
  runDir: string,
  traceEventsPath: string,
): Promise<ScorerGateResult> {
  const rawArtifactPath = path.join(runDir, "url-field-relevance.raw.json");

  // Persist verbatim BEFORE validation — this is the audit trail of what the LLM returned.
  await writeAtomicJSON(rawArtifactPath, scorerReply);

  const scorerInput: ScorerInput = {
    field_requirements: gate.field_requirements,
    classified_urls: gate.classified_urls,
    request_id: gate.request_id,
  };

  const validationResult = validateScorerOutput(scorerInput, scorerReply);

  if (!validationResult.valid) {
    const validationErrorEvent: RunEvent = {
      run_id: gate.run_id,
      event_id: crypto.randomUUID(),
      actor: "stage-6",
      module: "relevance-gate",
      stage: 6,
      action: "validation_failed",
      status: "completed",
      timestamp: new Date().toISOString(),
      error: `Scorer output validation failed: ${validationResult.errors.join("; ")}`,
      counts: {
        validation_errors: validationResult.errors.length,
      },
    };
    await writeAppendOnlyJSONL(traceEventsPath, validationErrorEvent);

    return {
      success: false,
      raw_artifact_path: rawArtifactPath,
      validation_passed: false,
      validation_errors: validationResult.errors,
      error: `Scorer output validation failed with ${validationResult.errors.length} errors`,
    };
  }

  const validationSuccessEvent: RunEvent = {
    run_id: gate.run_id,
    event_id: crypto.randomUUID(),
    actor: "stage-6",
    module: "relevance-gate",
    stage: 6,
    action: "validation_passed",
    status: "completed",
    timestamp: new Date().toISOString(),
    counts: {
      scores_validated: scorerReply.scores?.length ?? 0,
    },
  };
  await writeAppendOnlyJSONL(traceEventsPath, validationSuccessEvent);

  return {
    success: true,
    raw_artifact_path: rawArtifactPath,
    validation_passed: true,
  };
}

/**
 * Stage 7: Relevance validation and visit plan generation.
 *
 * Runs the deterministic validator on the (verbatim-persisted) scorer output,
 * builds the visit plan, and writes artifacts. When validation did not pass,
 * fails open: every candidate URL stays in the visit plan.
 */
export async function stage7_VisitPlanning(
  runDir: string,
  runId: string,
  traceEventsPath: string,
  validationPassed: boolean,
): Promise<void> {
  try {
    const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
    const classifiedUrlsPath = path.join(runDir, "clean-url-inventory.json");
    const scorerOutputRawPath = path.join(runDir, "url-field-relevance.raw.json");

    if (!fs.existsSync(fieldRequirementsPath)) {
      throw new Error(`Field requirements not found`);
    }
    if (!fs.existsSync(classifiedUrlsPath)) {
      throw new Error(`Classified URLs not found`);
    }

    const fieldReqsData = JSON.parse(fs.readFileSync(fieldRequirementsPath, "utf-8"));
    const fieldRequirements: FieldRequirement[] = fieldReqsData.fields || fieldReqsData;

    const classifiedUrls: UrlMapEntry[] = withUrlIds(JSON.parse(fs.readFileSync(classifiedUrlsPath, "utf-8")));

    let validatedMatrix = [];
    let visitPlan = [];
    let llmRejectedUrls = [];

    if (validationPassed && fs.existsSync(scorerOutputRawPath)) {
      const scorerOutput: ScorerOutput = JSON.parse(fs.readFileSync(scorerOutputRawPath, "utf-8"));

      const validationResult = validateRelevanceMatrix(scorerOutput.scores, fieldRequirements, classifiedUrls);
      validatedMatrix = validationResult.validatedMatrix;

      visitPlan = buildVisitPlan(validatedMatrix, classifiedUrls);
      llmRejectedUrls = extractLlmRejectedUrls(visitPlan);
    } else {
      // Validation failed (or reply missing entirely): fail open.
      // Every URL stays eligible for visiting rather than being dropped.
      const validationResult = validateRelevanceMatrix([], fieldRequirements, classifiedUrls);
      validatedMatrix = validationResult.validatedMatrix;

      visitPlan = buildVisitPlan(validatedMatrix, classifiedUrls);
      llmRejectedUrls = extractLlmRejectedUrls(visitPlan);

      const failOpenEvent: RunEvent = {
        run_id: runId,
        event_id: crypto.randomUUID(),
        actor: "stage-7",
        module: "visit-planning",
        stage: 7,
        action: "fail_open",
        status: "completed",
        timestamp: new Date().toISOString(),
        counts: {
          urls_selected: visitPlan.filter((v) => v.selected).length,
          urls_rejected: visitPlan.filter((v) => !v.selected).length,
        },
      };
      await writeAppendOnlyJSONL(traceEventsPath, failOpenEvent);
    }

    const validatedMatrixPath = path.join(runDir, "url-field-relevance.json");
    await writeAtomicJSON(validatedMatrixPath, validatedMatrix);

    const visitPlanPath = path.join(runDir, "visit-plan.json");
    await writeAtomicJSON(visitPlanPath, visitPlan);

    const llmRejectedPath = path.join(runDir, "llm-rejected-urls.json");
    await writeAtomicJSON(llmRejectedPath, llmRejectedUrls);

    const successEvent: RunEvent = {
      run_id: runId,
      event_id: crypto.randomUUID(),
      actor: "stage-7",
      module: "visit-planning",
      stage: 7,
      action: "stage_completed",
      status: "completed",
      timestamp: new Date().toISOString(),
      counts: {
        validated_pairs: validatedMatrix.length,
        visit_plan_entries: visitPlan.length,
        llm_rejected_urls: llmRejectedUrls.length,
      },
    };
    await writeAppendOnlyJSONL(traceEventsPath, successEvent);
  } catch (error) {
    const errorEvent: RunEvent = {
      run_id: runId,
      event_id: crypto.randomUUID(),
      actor: "stage-7",
      module: "visit-planning",
      stage: 7,
      action: "stage_error",
      status: "error",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeAppendOnlyJSONL(traceEventsPath, errorEvent);

    throw error;
  }
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeAtomicJSON, writeAppendOnlyJSONL } from "./artifact-writer.ts";
import { type Stage, validateStage } from "./discovery-types.ts";
import type { RunEvent } from "./run-events.ts";

/**
 * A stage gate indicates the pipeline needs external intervention (LLM scoring).
 */
export interface StageGate {
  gate_type: "needs_llm";
  stage: Stage;
  gate_id: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

/**
 * A pipeline state represents the current stage and completion status.
 */
export interface PipelineState {
  stage: Stage;
  status: "running" | "completed" | "blocked" | "error";
  state_id: string;
  timestamp: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Launch configuration for starting a pipeline run.
 */
export interface LaunchConfig {
  runDir: string;
  runId: string;
}

/**
 * Resume configuration for continuing after a gate is resolved.
 */
export interface ResumeConfig {
  runDir: string;
  runId: string;
  fromStage: Stage;
  toStage: Stage;
  scorerOutput: Record<string, unknown>;
}

/**
 * Define valid stage transitions in the Source order.
 * Includes the optional Stage 13→14→12 loop for gap probing.
 */
const VALID_TRANSITIONS: Record<Stage, Stage[]> = {
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
  12: [13, 16], // Optional loop to 13, or finish at 16
  13: [14],
  14: [15],
  15: [12], // Loop back to 12
  16: [], // Terminal stage
};

/**
 * Validates a stage transition.
 * Returns null if valid, or an error object if invalid.
 */
function validateTransition(fromStage: unknown, toStage: unknown): { code: string; message: string } | null {
  try {
    validateStage(fromStage);
    validateStage(toStage);
  } catch (err) {
    return {
      code: "invalid_stage",
      message: `Invalid stage(s): from=${fromStage}, to=${toStage}`,
    };
  }

  const from = fromStage as Stage;
  const to = toStage as Stage;

  if (!VALID_TRANSITIONS[from] || !VALID_TRANSITIONS[from].includes(to)) {
    return {
      code: "invalid_transition",
      message: `Invalid transition: ${from} → ${to}. Valid next stages from ${from} are: ${VALID_TRANSITIONS[from].join(", ")}`,
    };
  }

  return null;
}

/**
 * Launches the discovery pipeline, returning either a Stage 6 gate or a terminal state.
 * For now, returns a Stage 6 needs_llm gate (where the skill invokes the scorer).
 */
export async function launchPipeline(config: LaunchConfig): Promise<StageGate | PipelineState> {
  // Verify run context exists
  const runContextPath = path.join(config.runDir, "run-context.json");
  if (!fs.existsSync(runContextPath)) {
    throw new Error(`Run context not found at ${runContextPath}`);
  }

  const runContext = JSON.parse(fs.readFileSync(runContextPath, "utf-8"));

  // For this implementation, we deterministically progress through stages 1-5
  // and return a Stage 6 gate for scorer invocation
  const gateId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Emit stage progression events (stages 1-5 are deterministic)
  const traceEventsPath = path.join(config.runDir, "trace-events.jsonl");

  for (let stage = 2; stage <= 5; stage++) {
    const event: RunEvent = {
      run_id: config.runId,
      event_id: crypto.randomUUID(),
      actor: "orchestrator",
      module: "stage-orchestration",
      stage: stage as Stage,
      action: "stage_completed",
      status: "completed",
      timestamp,
    };
    await writeAppendOnlyJSONL(traceEventsPath, event);
  }

  // Create and return a Stage 6 needs_llm gate
  const gate: StageGate = {
    gate_type: "needs_llm",
    stage: 6,
    gate_id: gateId,
    timestamp,
    context: {
      run_id: config.runId,
      casino_url: runContext.casino_url,
      casino_id: runContext.casino_id,
    },
  };

  return gate;
}

/**
 * Resumes the pipeline after a scorer provides its output.
 * Validates the transition, writes the scorer output, and continues.
 */
export async function resumeFromScorer(config: ResumeConfig): Promise<PipelineState> {
  // Validate the transition
  const transitionError = validateTransition(config.fromStage, config.toStage);
  if (transitionError) {
    throw new Error(`${transitionError.code}: ${transitionError.message}`);
  }

  // Verify run context exists
  const runContextPath = path.join(config.runDir, "run-context.json");
  if (!fs.existsSync(runContextPath)) {
    throw new Error(`Run context not found at ${runContextPath}`);
  }

  // Persist scorer output
  const scorerOutputPath = path.join(config.runDir, "scorer-output.json");
  await writeAtomicJSON(scorerOutputPath, config.scorerOutput);

  // Emit resume event
  const traceEventsPath = path.join(config.runDir, "trace-events.jsonl");
  const resumeEvent: RunEvent = {
    run_id: config.runId,
    event_id: crypto.randomUUID(),
    actor: "orchestrator",
    module: "stage-orchestration",
    stage: config.toStage,
    action: "resume_from_scorer",
    status: "completed",
    timestamp: new Date().toISOString(),
    artifact_references: [scorerOutputPath],
  };

  await writeAppendOnlyJSONL(traceEventsPath, resumeEvent);

  // Return the next state
  const state: PipelineState = {
    stage: config.toStage,
    status: "running",
    state_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  return state;
}

/**
 * Export valid transitions for testing or external stage machine validation.
 */
export { VALID_TRANSITIONS };

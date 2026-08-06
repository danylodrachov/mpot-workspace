import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeAtomicJSON, writeAppendOnlyJSONL } from "./artifact-writer.ts";
import { getRunDir } from "./artifact-paths.ts";
import type { RunEvent } from "./run-events.ts";

/**
 * Run context schema for casino discovery pipeline.
 * Immutable record of run initialization parameters, hashes, and metadata.
 */
export interface RunContext {
  run_id: string;
  casino_url: string;
  casino_id: string;
  geo: string;
  locale: string;
  canonical_origin: string;
  approved_same_domain_scope: string;
  template_hash: string;
  extraction_rules_hash: string;
  url_rules_hash: string;
  module_version_hash: string;
  scorer_prompt_hash: string;
  visit_policy_hash: string;
  probe_policy_hash: string;
  timestamp: string;
  authentication_disabled: true;
  /** Metadata tracking which provider supplied observations for this run (Issue 24) */
  observation_provider?: {
    provider_type: 'fixture_recorded' | 'live_browser';
    provider_name?: string;
    observations_path?: string;
  };
}

/**
 * Input configuration for run initialization.
 */
export interface InitializeRunConfig {
  baseDir: string;
  casino_url: string;
  geo: string;
  template_path: string;
  extraction_rules_path: string;
  url_rules_path: string;
  run_id?: string;
  storage_state_path?: string;
  /** Which provider supplied this run's observations (Issue 24). Omitted for runs that never touch stages 1-13's observation seam. */
  observation_provider?: RunContext['observation_provider'];
}

/**
 * Result of successful run initialization.
 */
export interface InitializeRunResult {
  run_id: string;
  casino_id: string;
  geo: string;
  run_dir: string;
  canonical_origin: string;
}

/**
 * Derives casino ID from casino URL.
 */
function deriveCasinoId(casino_url: string): string {
  try {
    const url = new URL(casino_url);
    // Extract domain without www
    let domain = url.hostname;
    if (domain.startsWith("www.")) {
      domain = domain.slice(4);
    }
    // Use domain as casino_id, replacing special chars with underscores
    return domain.replace(/[^a-z0-9-]/gi, "_").toLowerCase();
  } catch {
    throw new Error(`Invalid casino_url: ${casino_url}`);
  }
}

/**
 * Derives canonical origin from casino URL.
 */
function deriveCanonicalOrigin(casino_url: string): string {
  try {
    const url = new URL(casino_url);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    throw new Error(`Invalid casino_url: ${casino_url}`);
  }
}

/**
 * Derives approved same-domain scope from casino URL.
 */
function deriveApprovedScope(casino_url: string): string {
  try {
    const url = new URL(casino_url);
    return `https://${url.hostname}`;
  } catch {
    throw new Error(`Invalid casino_url: ${casino_url}`);
  }
}

/**
 * Derives locale from geo (simplified - in practice would be more complex).
 */
function deriveLocale(geo: string): string {
  const locales: Record<string, string> = {
    US: "en-US",
    GB: "en-GB",
    CA: "en-CA",
    AU: "en-AU",
  };
  return locales[geo] || `en-${geo}`;
}

/**
 * Reads a file and computes its SHA256 hash.
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Initializes a run with immutable configuration and authentication isolation.
 * Validates all inputs before creating any artifacts.
 * Rejects storage-state for anonymous-first operation.
 */
export async function initializeRun(config: InitializeRunConfig): Promise<InitializeRunResult> {
  // Validation: all required fields must be non-empty
  if (!config.casino_url || typeof config.casino_url !== "string" || config.casino_url.trim() === "") {
    throw new Error("casino_url is required and must be a non-empty string");
  }
  if (!config.geo || typeof config.geo !== "string" || config.geo.trim() === "") {
    throw new Error("geo is required and must be a non-empty string");
  }
  if (!config.template_path || typeof config.template_path !== "string" || config.template_path.trim() === "") {
    throw new Error("template_path is required and must be a non-empty string");
  }
  if (!config.extraction_rules_path || typeof config.extraction_rules_path !== "string" || config.extraction_rules_path.trim() === "") {
    throw new Error("extraction_rules_path is required and must be a non-empty string");
  }
  if (!config.url_rules_path || typeof config.url_rules_path !== "string" || config.url_rules_path.trim() === "") {
    throw new Error("url_rules_path is required and must be a non-empty string");
  }

  // Validation: reject storage-state (anonymous-first)
  if (config.storage_state_path) {
    throw new Error("storage_state_path is not allowed. Runs must start with anonymous browser context.");
  }

  // Validation: fixture files must exist
  if (!fs.existsSync(config.template_path)) {
    throw new Error(`template_path does not exist: ${config.template_path}`);
  }
  if (!fs.existsSync(config.extraction_rules_path)) {
    throw new Error(`extraction_rules_path does not exist: ${config.extraction_rules_path}`);
  }
  if (!fs.existsSync(config.url_rules_path)) {
    throw new Error(`url_rules_path does not exist: ${config.url_rules_path}`);
  }

  // Derive constants from inputs
  const casino_id = deriveCasinoId(config.casino_url);
  const run_id = config.run_id || crypto.randomUUID();
  const locale = deriveLocale(config.geo);
  const canonical_origin = deriveCanonicalOrigin(config.casino_url);
  const approved_same_domain_scope = deriveApprovedScope(config.casino_url);

  // Compute hashes
  const template_hash = computeFileHash(config.template_path);
  const extraction_rules_hash = computeFileHash(config.extraction_rules_path);
  const url_rules_hash = computeFileHash(config.url_rules_path);

  // Placeholder hashes for module version, scorer prompt, and policies
  // In a real implementation, these would be computed from actual values
  const module_version_hash = crypto.createHash("sha256").update("module-version-1.0.0").digest("hex");
  const scorer_prompt_hash = crypto.createHash("sha256").update("scorer-prompt-default").digest("hex");
  const visit_policy_hash = crypto.createHash("sha256").update("visit-policy-default").digest("hex");
  const probe_policy_hash = crypto.createHash("sha256").update("probe-policy-default").digest("hex");

  // Resolve run directory
  const run_dir = getRunDir(config.baseDir, casino_id, config.geo, run_id);

  // Check if run-context already exists (immutability check)
  const run_context_path = path.join(run_dir, "run-context.json");
  if (fs.existsSync(run_context_path)) {
    throw new Error(`Cannot overwrite existing run context at ${run_context_path}. The run already exists.`);
  }

  // Create run-context.json immutably
  const run_context: RunContext = {
    run_id,
    casino_url: config.casino_url,
    casino_id,
    geo: config.geo,
    locale,
    canonical_origin,
    approved_same_domain_scope,
    template_hash,
    extraction_rules_hash,
    url_rules_hash,
    module_version_hash,
    scorer_prompt_hash,
    visit_policy_hash,
    probe_policy_hash,
    timestamp: new Date().toISOString(),
    authentication_disabled: true,
    ...(config.observation_provider ? { observation_provider: config.observation_provider } : {}),
  };

  await writeAtomicJSON(run_context_path, run_context, { immutable: true });

  // Emit run_started event
  const trace_events_path = path.join(run_dir, "trace-events.jsonl");
  const run_started_event: RunEvent = {
    run_id,
    event_id: crypto.randomUUID(),
    actor: "system",
    module: "discovery-orchestrator",
    stage: 1,
    action: "run_started",
    status: "completed",
    timestamp: new Date().toISOString(),
    artifact_references: [run_context_path],
  };

  await writeAppendOnlyJSONL(trace_events_path, run_started_event);

  return {
    run_id,
    casino_id,
    geo: config.geo,
    run_dir,
    canonical_origin,
  };
}

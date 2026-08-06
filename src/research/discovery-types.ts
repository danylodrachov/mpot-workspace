/**
 * Shared pipeline contracts for casino discovery (CD-068).
 *
 * Defines stages 1–16, stage states, actors, source statuses, field terminal
 * statuses, stable ID types, and canonical artifact-name constants with
 * ownership registry.
 *
 * Core constraint: reject "present" and "human_required" in canonical schemas.
 * Use "complete" for source status instead of "present"; "human_required" is
 * not a field or source status.
 *
 * See ADR-001 for pipeline architecture and ownership model.
 */

// --- Stages 1-16 -------------------------------------------------------

export const STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
export type Stage = (typeof STAGES)[number];

export function validateStage(stage: unknown): asserts stage is Stage {
  if (!STAGES.includes(stage as Stage)) {
    throw new Error(`Unsupported stage: ${stage}. Valid stages are 1-16.`);
  }
}

// --- Stage states -------------------------------------------------------

export const STAGE_STATES = ["pending", "running", "completed", "blocked", "error"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export function validateStageState(state: unknown): asserts state is StageState {
  if (!STAGE_STATES.includes(state as StageState)) {
    throw new Error(`Unsupported stage state: ${state}`);
  }
}

// --- Actors -------------------------------------------------------

export const ACTORS = [
  "system",
  "recon-agent",
  "browser-agent",
  "product-collector",
  "reviewer-agent",
  "orchestrator",
] as const;
export type Actor = (typeof ACTORS)[number];

export function validateActor(actor: unknown): asserts actor is Actor {
  if (!ACTORS.includes(actor as Actor)) {
    throw new Error(`Unsupported actor: ${actor}`);
  }
}

// --- Source statuses (complete|absent|blocked|unsupported|error) ---------

export const SOURCE_STATUSES = ["complete", "absent", "blocked", "unsupported", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export function validateSourceStatus(status: unknown): asserts status is SourceStatus {
  if (!SOURCE_STATUSES.includes(status as SourceStatus)) {
    throw new Error(
      `Unsupported source status: ${status}. Valid statuses are: complete, absent, blocked, unsupported, error.`
    );
  }
}

// --- Field terminal statuses -------------------------------------------------------

export const FIELD_STATUSES = [
  "found",
  "missing",
  "blocked",
  "not_publicly_available",
  "conflicting",
  "unsupported",
  "error",
] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export function validateFieldStatus(status: unknown): asserts status is FieldStatus {
  if (!FIELD_STATUSES.includes(status as FieldStatus)) {
    throw new Error(
      `Unsupported field status: ${status}. Valid statuses are: found, missing, blocked, not_publicly_available, conflicting, unsupported, error.`
    );
  }
}

// --- Stable ID types -------------------------------------------------------

export const STABLE_ID_TYPES = ["stage", "actor", "artifact", "source_family", "field", "error_code"] as const;
export type StableIdType = (typeof STABLE_ID_TYPES)[number];

export function validateStableIdType(idType: unknown): asserts idType is StableIdType {
  if (!STABLE_ID_TYPES.includes(idType as StableIdType)) {
    throw new Error(`Unsupported stable ID type: ${idType}`);
  }
}

// --- Shared artifact filename constants -----------------------------------------

/**
 * Canonical filename for the Stage 11 page-behavior profiling artifact (Issue 28).
 * Producers (page-interactivity-profiler, interaction-delta-profiler) and consumers
 * (field-collector, product-collector, stage-dispatcher) must all resolve this same
 * name — do not repeat the "page-behavior.json" string literal in new code.
 */
export const PAGE_BEHAVIOR_ARTIFACT = "page-behavior.json";

// --- Artifact ownership registry -----------------------------------------------

export const ARTIFACT_MUTATION_MODES = ["immutable-create", "append-only", "report-only"] as const;
export type ArtifactMutationMode = (typeof ARTIFACT_MUTATION_MODES)[number];

export type ArtifactOwnershipEntry = {
  /** Canonical artifact name (filename or artifact identifier) */
  artifact: string;
  /** Producer module or actor that owns this artifact */
  producer: Actor | string;
  /** Mutation mode: immutable-create, append-only, report-only */
  mode: ArtifactMutationMode;
  /** Whether this is a canonical artifact (required for pipeline progress) */
  canonical: boolean;
};

/**
 * Artifact ownership registry: every canonical artifact has exactly one producer
 * and one mutation mode. The producer is responsible for creating and managing
 * the artifact lifecycle.
 *
 * Updated for pipeline v2 (issues 01-18): removed legacy artifacts (sports.json,
 * live-casino.json, slots.json, document-url-map.json, regex-clean-decisions.jsonl)
 * and added new artifacts produced by current modules.
 */
export const ARTIFACT_OWNERS: ArtifactOwnershipEntry[] = [
  // Run context and tracing
  { artifact: "run-context.json", producer: "orchestrator", mode: "immutable-create", canonical: true },
  { artifact: "trace-events.jsonl", producer: "system", mode: "append-only", canonical: true },

  // Stage 0: browser agent observation handoff (Issue 24) — the only artifact
  // browser agents (url-map-recon, discovery-browser) write directly. Deterministic
  // stages read it through src/research/observation-provider.ts.
  {
    artifact: "page-observations.jsonl",
    producer: "browser-agent",
    mode: "append-only",
    canonical: false,
  },

  // Stage 1: URL discovery (url-map-recon) — now produced deterministically from
  // page-observations.jsonl by the stage 1 handler, not written directly by the agent.
  {
    artifact: "raw-url-candidates.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "url-source-coverage.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "extraction-recipe.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 7: URL cleaning (url-cleaning-coordinator)
  {
    artifact: "clean-url-inventory.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "deterministic-rejected-urls.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "url-clean-decisions.jsonl",
    producer: "system",
    mode: "append-only",
    canonical: true,
  },

  // Stage 8: URL metadata classification
  {
    artifact: "url-metadata-classifications.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 5: Template requirements compilation
  {
    artifact: "field-requirements.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "dropdown-catalog.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 9: URL field relevance scoring
  {
    artifact: "raw-relevance-scores.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 10: Relevance validation
  {
    artifact: "visit-plan.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 11: Page interactivity profiling
  {
    artifact: PAGE_BEHAVIOR_ARTIFACT,
    producer: "browser-agent",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 12: Interaction execution and evidence redaction
  {
    artifact: "field-evidence.json",
    producer: "browser-agent",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 13: Field and product collection
  {
    artifact: "field-catalog.json",
    producer: "product-collector",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 14: Normalisation and conflict resolution
  {
    artifact: "normalisation-decisions.jsonl",
    producer: "system",
    mode: "append-only",
    canonical: true,
  },
  {
    artifact: "dropdown-additions.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 15: Coverage and delta generation
  {
    artifact: "field-coverage.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
  {
    artifact: "discovery-delta.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 16: Ranked gap probing and merge
  {
    artifact: "validated-gap-patch.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },

  // Stage 16: Report rendering (final-report-renderer.ts). "discovery-report.html" was the
  // aspirational name from an earlier design; the deterministic renderer that actually ships
  // writes "discovery-review.json".
  {
    artifact: "discovery-review.json",
    producer: "system",
    mode: "immutable-create",
    canonical: true,
  },
];

export function validateArtifactOwnership(registry: ArtifactOwnershipEntry[]): void {
  const artifactToOwner = new Map<string, string>();

  for (const entry of registry) {
    if (artifactToOwner.has(entry.artifact)) {
      throw new Error(
        `Artifact "${entry.artifact}" has multiple owners: ` +
          `"${artifactToOwner.get(entry.artifact)}" and "${entry.producer}"`
      );
    }
    artifactToOwner.set(entry.artifact, entry.producer);
  }
}

// Validate the global registry on module load
validateArtifactOwnership(ARTIFACT_OWNERS);

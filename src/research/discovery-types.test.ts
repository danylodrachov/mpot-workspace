import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  STAGE_STATES,
  ACTORS,
  SOURCE_STATUSES,
  FIELD_STATUSES,
  STABLE_ID_TYPES,
  ARTIFACT_OWNERS,
  validateStage,
  validateStageState,
  validateActor,
  validateSourceStatus,
  validateFieldStatus,
  validateStableIdType,
  validateArtifactOwnership,
  type Stage,
  type StageState,
  type Actor,
  type SourceStatus,
  type FieldStatus,
  type StableIdType,
  type ArtifactOwnershipEntry,
} from "./discovery-types.ts";

test("discovery-types: stages 1-16 are defined", () => {
  assert.equal(STAGES.length, 16);
  assert.ok(STAGES.includes(1));
  assert.ok(STAGES.includes(16));
  // Ensure no gaps
  for (let i = 1; i <= 16; i++) {
    assert.ok(STAGES.includes(i as Stage), `Stage ${i} should be defined`);
  }
});

test("discovery-types: stage states are defined", () => {
  assert.ok(STAGE_STATES.length > 0);
  // Should include at least: pending, running, completed, blocked, error
  const stateNames = STAGE_STATES.map((s) => s.toLowerCase());
  assert.ok(
    stateNames.some((s) => s.includes("pending") || s.includes("ready")),
    "Should have a pending/ready state"
  );
});

test("discovery-types: actors are defined", () => {
  assert.ok(ACTORS.length > 0);
  // Should include at least: system, recon-agent, browser-agent, collector, reviewer
  const actorNames = ACTORS.map((a) => a.toLowerCase());
  assert.ok(actorNames.length > 0);
});

test("discovery-types: source statuses are defined (complete|absent|blocked|unsupported|error)", () => {
  assert.ok(SOURCE_STATUSES.includes("complete"));
  assert.ok(SOURCE_STATUSES.includes("absent"));
  assert.ok(SOURCE_STATUSES.includes("blocked"));
  assert.ok(SOURCE_STATUSES.includes("unsupported"));
  assert.ok(SOURCE_STATUSES.includes("error"));
  // Should NOT include "present" or "human_required"
  assert.ok(!SOURCE_STATUSES.includes("present" as unknown as SourceStatus));
  assert.ok(!SOURCE_STATUSES.includes("human_required" as unknown as SourceStatus));
});

test("discovery-types: field statuses are defined (found|missing|blocked|not_publicly_available|conflicting|unsupported|error)", () => {
  assert.ok(FIELD_STATUSES.includes("found"));
  assert.ok(FIELD_STATUSES.includes("missing"));
  assert.ok(FIELD_STATUSES.includes("blocked"));
  assert.ok(FIELD_STATUSES.includes("not_publicly_available"));
  assert.ok(FIELD_STATUSES.includes("conflicting"));
  assert.ok(FIELD_STATUSES.includes("unsupported"));
  assert.ok(FIELD_STATUSES.includes("error"));
});

test("discovery-types: stable ID types are defined", () => {
  assert.ok(STABLE_ID_TYPES.length > 0);
  // Should include types like: stage, actor, artifact, source_family, etc.
  const idTypeNames = STABLE_ID_TYPES.map((t) => t.toLowerCase());
  assert.ok(idTypeNames.length > 0);
});

test("discovery-types: validateStage rejects unsupported stages", () => {
  assert.doesNotThrow(() => {
    validateStage(1);
    validateStage(16);
  });
  assert.throws(() => {
    validateStage(0 as unknown as Stage);
  });
  assert.throws(() => {
    validateStage(17 as unknown as Stage);
  });
});

test("discovery-types: validateSourceStatus rejects unsupported statuses", () => {
  assert.doesNotThrow(() => {
    validateSourceStatus("complete");
    validateSourceStatus("absent");
    validateSourceStatus("blocked");
    validateSourceStatus("unsupported");
    validateSourceStatus("error");
  });
  assert.throws(() => {
    validateSourceStatus("present" as unknown as SourceStatus);
  });
  assert.throws(() => {
    validateSourceStatus("human_required" as unknown as SourceStatus);
  });
  assert.throws(() => {
    validateSourceStatus("unknown" as unknown as SourceStatus);
  });
});

test("discovery-types: validateFieldStatus rejects unsupported statuses", () => {
  assert.doesNotThrow(() => {
    validateFieldStatus("found");
    validateFieldStatus("missing");
    validateFieldStatus("blocked");
    validateFieldStatus("not_publicly_available");
    validateFieldStatus("conflicting");
    validateFieldStatus("unsupported");
    validateFieldStatus("error");
  });
  assert.throws(() => {
    validateFieldStatus("unknown" as FieldStatus);
  });
});

test("discovery-types: ARTIFACT_OWNERS registry exists and is non-empty", () => {
  assert.ok(ARTIFACT_OWNERS.length > 0);
});

test("discovery-types: every artifact has exactly one owner", () => {
  // Build a map of artifact names to their owners
  const artifactOwnerMap = new Map<string, string>();

  for (const entry of ARTIFACT_OWNERS) {
    const { artifact, producer } = entry;
    if (artifactOwnerMap.has(artifact)) {
      assert.fail(
        `Artifact "${artifact}" has multiple owners: "${artifactOwnerMap.get(artifact)}" and "${producer}"`
      );
    }
    artifactOwnerMap.set(artifact, producer);
  }

  // Ensure we have at least the expected artifacts
  assert.ok(
    artifactOwnerMap.size > 0,
    "ARTIFACT_OWNERS should have entries for canonical artifacts"
  );
});

test("discovery-types: duplicate artifact owners are caught by validation", () => {
  // Create a test list with duplicate artifact names
  const duplicateRegistry: ArtifactOwnershipEntry[] = [
    { artifact: "run-context.json", producer: "run-initializer", mode: "immutable-create", canonical: true },
    { artifact: "run-context.json", producer: "different-producer", mode: "immutable-create", canonical: true },
  ];

  // The validator should catch this
  assert.throws(() => {
    validateArtifactOwnership(duplicateRegistry);
  });
});

test("discovery-types: validateArtifactOwnership passes for valid ownership registry", () => {
  const validRegistry: ArtifactOwnershipEntry[] = [
    { artifact: "run-context.json", producer: "run-initializer", mode: "immutable-create", canonical: true },
    { artifact: "trace-events.jsonl", producer: "trace-writer", mode: "append-only", canonical: true },
    {
      artifact: "raw-candidates.json",
      producer: "raw-candidate-writer",
      mode: "immutable-create",
      canonical: true,
    },
  ];

  assert.doesNotThrow(() => {
    validateArtifactOwnership(validRegistry);
  });
});

test("discovery-types: typecheck passes", () => {
  // This test validates that all type imports and usage are valid TypeScript.
  // If there are type errors, this test file won't compile.
  const stage: Stage = 1;
  const state: StageState = STAGE_STATES[0];
  const actor: Actor = ACTORS[0];
  const sourceStatus: SourceStatus = "complete";
  const fieldStatus: FieldStatus = "found";
  const idType: StableIdType = STABLE_ID_TYPES[0];

  assert.ok(stage);
  assert.ok(state);
  assert.ok(actor);
  assert.ok(sourceStatus);
  assert.ok(fieldStatus);
  assert.ok(idType);
});

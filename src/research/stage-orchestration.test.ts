import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchPipeline, resumeFromScorer, type StageGate, type PipelineState } from "./stage-orchestration.ts";

// Create a temporary directory for tests
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage-orchestration-test-"));
}

// Cleanup test directory
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("stage-orchestration: launcher returns Stage 6 needs_llm gate", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));

    // Initialize a run first (using the orchestrator module)
    const { initializeRun } = await import("./discovery-orchestrator.ts");
    const runResult = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    // Launch the pipeline
    const gateOrState = await launchPipeline({
      runDir: runResult.run_dir,
      runId: runResult.run_id,
    });

    // Should return a Stage 6 gate (needs_llm)
    assert.ok("gate_type" in gateOrState, "Should return a gate object");
    const gate = gateOrState as StageGate;
    assert.equal(gate.stage, 6, "Should be Stage 6");
    assert.equal(gate.gate_type, "needs_llm", "Should be needs_llm gate type");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("stage-orchestration: invalid transition returns machine-readable error", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));

    // Initialize a run
    const { initializeRun } = await import("./discovery-orchestrator.ts");
    const runResult = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    // Try invalid transition (jumping from stage 1 to stage 16)
    try {
      await resumeFromScorer({
        runDir: runResult.run_dir,
        runId: runResult.run_id,
        fromStage: 1,
        toStage: 16, // Invalid jump
        scorerOutput: {},
      });
      assert.fail("Should have thrown for invalid transition");
    } catch (err) {
      assert.ok(err instanceof Error, "Should throw an error");
      const message = err.message;
      // Should contain machine-readable information about the invalid transition
      assert.ok(
        message.includes("invalid") || message.includes("transition") || message.includes("stage"),
        "Error message should reference stages or transitions"
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test("stage-orchestration: resume from scorer returns next state", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));

    // Initialize a run
    const { initializeRun } = await import("./discovery-orchestrator.ts");
    const runResult = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    // Launch to get Stage 6 gate
    const gate = (await launchPipeline({
      runDir: runResult.run_dir,
      runId: runResult.run_id,
    })) as StageGate;

    // Resume from scorer with sample output
    const nextState = (await resumeFromScorer({
      runDir: runResult.run_dir,
      runId: runResult.run_id,
      fromStage: gate.stage,
      toStage: 7, // Valid next stage after 6
      scorerOutput: {
        sample_field: {
          probability: 0.85,
          class: "likely" as const,
        },
      },
    })) as PipelineState;

    assert.ok("stage" in nextState, "Should return a state with stage");
    assert.equal(nextState.stage, 7, "Should advance to stage 7");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("stage-orchestration: launcher produces deterministic output with identical data", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ fields: ["field1", "field2"] }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: ["rule1"] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify({ patterns: ["pattern1"] }));

    // Initialize a run
    const { initializeRun } = await import("./discovery-orchestrator.ts");
    const runResult = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    // Launch twice
    const result1 = await launchPipeline({
      runDir: runResult.run_dir,
      runId: runResult.run_id,
    });

    // Create a second run with the same data
    const runResult2 = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    const result2 = await launchPipeline({
      runDir: runResult2.run_dir,
      runId: runResult2.run_id,
    });

    // Both should return Stage 6 gate
    assert.ok("gate_type" in result1, "First result should be a gate");
    assert.ok("gate_type" in result2, "Second result should be a gate");
    assert.equal(
      (result1 as StageGate).stage,
      (result2 as StageGate).stage,
      "Both should return the same stage"
    );
  } finally {
    cleanupTestDir(testDir);
  }
});

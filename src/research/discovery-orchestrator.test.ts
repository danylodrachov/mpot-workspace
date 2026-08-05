import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initializeRun } from "./discovery-orchestrator.ts";

// Create a temporary directory for tests
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "discovery-orchestrator-test-"));
}

// Cleanup test directory
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("discovery-orchestrator: missing input fails before any artifact exists", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Ensure temp dir has some fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));

    // Try to initialize with missing casino_url
    try {
      await initializeRun({
        baseDir,
        casino_url: "", // Missing!
        geo: "US",
        template_path: path.join(tempDir, "template.json"),
        extraction_rules_path: path.join(tempDir, "extraction.json"),
        url_rules_path: path.join(tempDir, "rules.json"),
      });
      assert.fail("Should have thrown for missing casino_url");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /casino_url|missing|required/i);
    }

    // Verify no artifact was created
    assert.ok(!fs.existsSync(baseDir));
  } finally {
    cleanupTestDir(testDir);
  }
});

test("discovery-orchestrator: existing run context cannot be overwritten", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));

    // First initialization
    const result1 = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: path.join(tempDir, "template.json"),
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    const runContextPath1 = path.join(baseDir, `${result1.casino_id}/${result1.geo}/${result1.run_id}/run-context.json`);
    assert.ok(fs.existsSync(runContextPath1), "First run-context.json should exist");

    // Try to overwrite with same run_id
    try {
      await initializeRun({
        baseDir,
        casino_url: "https://example-casino.com",
        geo: "US",
        template_path: path.join(tempDir, "template.json"),
        extraction_rules_path: path.join(tempDir, "extraction.json"),
        url_rules_path: path.join(tempDir, "rules.json"),
        run_id: result1.run_id, // Force same run_id
      });
      assert.fail("Should not allow overwriting existing run context");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cannot overwrite|already exists|immutable/i);
    }

    // Verify original is still there and unchanged
    const context = JSON.parse(fs.readFileSync(runContextPath1, "utf-8"));
    assert.equal(context.run_id, result1.run_id);
  } finally {
    cleanupTestDir(testDir);
  }
});

test("discovery-orchestrator: storage-state option is rejected", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify({ name: "test" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));
    fs.writeFileSync(path.join(tempDir, "storage-state.json"), JSON.stringify({}));

    // Try to initialize with storage_state_path
    try {
      await initializeRun({
        baseDir,
        casino_url: "https://example-casino.com",
        geo: "US",
        template_path: path.join(tempDir, "template.json"),
        extraction_rules_path: path.join(tempDir, "extraction.json"),
        url_rules_path: path.join(tempDir, "rules.json"),
        storage_state_path: path.join(tempDir, "storage-state.json"), // Should be rejected!
      });
      assert.fail("Should reject storage_state_path");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /storage|state|not allowed|rejected|anonymous/i);
    }

    // Verify no artifact was created
    assert.ok(!fs.existsSync(baseDir));
  } finally {
    cleanupTestDir(testDir);
  }
});

test("discovery-orchestrator: hashes change when fixture changes", async () => {
  const testDir = createTestDir();
  try {
    const baseDir1 = path.join(testDir, "runs1");
    const baseDir2 = path.join(testDir, "runs2");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files
    fs.mkdirSync(tempDir, { recursive: true });
    const templatePath = path.join(tempDir, "template.json");
    fs.writeFileSync(templatePath, JSON.stringify({ name: "version1" }));
    fs.writeFileSync(path.join(tempDir, "extraction.json"), JSON.stringify({ rules: [] }));
    fs.writeFileSync(path.join(tempDir, "rules.json"), JSON.stringify([]));

    // First initialization
    const result1 = await initializeRun({
      baseDir: baseDir1,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: templatePath,
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    const context1Path = path.join(baseDir1, `${result1.casino_id}/${result1.geo}/${result1.run_id}/run-context.json`);
    const context1 = JSON.parse(fs.readFileSync(context1Path, "utf-8"));
    const hash1 = context1.template_hash;

    // Modify template
    fs.writeFileSync(templatePath, JSON.stringify({ name: "version2" }));

    // Second initialization (will generate new run_id)
    const result2 = await initializeRun({
      baseDir: baseDir2,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: templatePath,
      extraction_rules_path: path.join(tempDir, "extraction.json"),
      url_rules_path: path.join(tempDir, "rules.json"),
    });

    const context2Path = path.join(baseDir2, `${result2.casino_id}/${result2.geo}/${result2.run_id}/run-context.json`);
    const context2 = JSON.parse(fs.readFileSync(context2Path, "utf-8"));
    const hash2 = context2.template_hash;

    // Hashes should be different
    assert.notEqual(hash1, hash2, "Hashes should change when fixture changes");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("discovery-orchestrator: no credential field is read", async () => {
  const testDir = createTestDir();
  try {
    const baseDir = path.join(testDir, "runs");
    const tempDir = path.join(testDir, "temp");

    // Create fixture files with credential fields
    fs.mkdirSync(tempDir, { recursive: true });
    const templatePath = path.join(tempDir, "template.json");
    const extractionPath = path.join(tempDir, "extraction.json");
    const rulesPath = path.join(tempDir, "rules.json");

    fs.writeFileSync(templatePath, JSON.stringify({
      name: "test",
      credentials: "SECRET123", // Should not be hashed
      api_key: "SUPER_SECRET", // Should not be hashed
      password: "DONT_HASH", // Should not be hashed
    }));
    fs.writeFileSync(extractionPath, JSON.stringify({ rules: [] }));
    fs.writeFileSync(rulesPath, JSON.stringify([]));

    // Initialize
    const result = await initializeRun({
      baseDir,
      casino_url: "https://example-casino.com",
      geo: "US",
      template_path: templatePath,
      extraction_rules_path: extractionPath,
      url_rules_path: rulesPath,
    });

    const contextPath = path.join(baseDir, `${result.casino_id}/${result.geo}/${result.run_id}/run-context.json`);
    const context = JSON.parse(fs.readFileSync(contextPath, "utf-8"));

    // Verify context doesn't contain credentials
    const contextStr = JSON.stringify(context);
    assert.ok(!contextStr.includes("SECRET123"), "Credentials should not be in run-context");
    assert.ok(!contextStr.includes("SUPER_SECRET"), "API keys should not be in run-context");
    assert.ok(!contextStr.includes("DONT_HASH"), "Passwords should not be in run-context");

    // However, the hash should exist and be deterministic
    assert.ok(context.template_hash, "Template hash should exist");
    assert.ok(typeof context.template_hash === "string", "Hash should be a string");
  } finally {
    cleanupTestDir(testDir);
  }
});

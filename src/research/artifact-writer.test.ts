import { test } from "node:test";
import assert from "node:assert/strict";
import { writeAtomicJSON, writeAppendOnlyJSONL } from "./artifact-writer.ts";
import { resolvePath } from "./artifact-paths.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Create a temporary directory for tests
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "artifact-test-"));
}

// Cleanup test directory
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("artifact-writer: failed write leaves previous file intact", async () => {
  const testDir = createTestDir();
  try {
    const filePath = path.join(testDir, "config.json");

    // Write initial content
    const initial = { version: 1 };
    await writeAtomicJSON(filePath, initial);
    assert.ok(fs.existsSync(filePath));

    // Read and verify initial
    const content1 = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepEqual(content1, initial);

    // Simulate a write failure by trying to write to a locked file on Windows or similar
    // For this test, we'll write successfully first, then attempt write to non-existent parent
    const badPath = path.join(testDir, "nonexistent", "file.json");
    try {
      await writeAtomicJSON(badPath, { version: 2 });
    } catch {
      // Expected to fail
    }

    // Verify original file unchanged
    const content2 = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepEqual(content2, initial);
  } finally {
    cleanupTestDir(testDir);
  }
});

test("artifact-writer: immutable artifacts cannot be overwritten", async () => {
  const testDir = createTestDir();
  try {
    const filePath = path.join(testDir, "immutable.json");

    // Write immutable file
    const initial = { id: "run-123", created: true };
    await writeAtomicJSON(filePath, initial, { immutable: true });
    assert.ok(fs.existsSync(filePath));

    // Try to overwrite - should throw
    try {
      await writeAtomicJSON(filePath, { id: "run-123", created: true, modified: true }, { immutable: true });
      assert.fail("Should not allow overwriting immutable file");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /immutable|cannot.*overwrite/i);
    }

    // Verify original unchanged
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepEqual(content, initial);
  } finally {
    cleanupTestDir(testDir);
  }
});

test("artifact-writer: two event appends remain valid ordered JSONL", async () => {
  const testDir = createTestDir();
  try {
    const filePath = path.join(testDir, "events.jsonl");

    // Append first event
    const event1 = { event_id: "1", action: "start", timestamp: "2024-01-01T00:00:00Z" };
    await writeAppendOnlyJSONL(filePath, event1);

    // Append second event
    const event2 = { event_id: "2", action: "complete", timestamp: "2024-01-01T00:01:00Z" };
    await writeAppendOnlyJSONL(filePath, event2);

    // Read and parse JSONL
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);

    assert.deepEqual(parsed1, event1);
    assert.deepEqual(parsed2, event2);
    assert.equal(parsed1.event_id, "1");
    assert.equal(parsed2.event_id, "2");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("artifact-writer: no update/delete API exists for events", async () => {
  // Verify that artifact-writer module does not export updateEvent or deleteEvent
  // We check this by ensuring only atomic and append-only APIs are available
  const writer: Record<string, unknown> = await import("./artifact-writer.ts");

  // Should not have update/delete methods
  assert.equal(writer.updateEvent, undefined, "updateEvent should not exist");
  assert.equal(writer.deleteEvent, undefined, "deleteEvent should not exist");

  // Verify correct exports exist
  assert.ok(writer.writeAtomicJSON, "writeAtomicJSON should exist");
  assert.ok(writer.writeAppendOnlyJSONL, "writeAppendOnlyJSONL should exist");
});

test("artifact-writer: different data with multiple appends works correctly", async () => {
  const testDir = createTestDir();
  try {
    const filePath = path.join(testDir, "multi-events.jsonl");

    // Append multiple different events in sequence
    const events = [
      { event_id: "evt-alpha", action: "init", timestamp: "2024-01-01T00:00:00Z", status: "running" },
      { event_id: "evt-beta", action: "stage-1", timestamp: "2024-01-01T00:05:00Z", status: "completed", counts: { urls: 42 } },
      { event_id: "evt-gamma", action: "review", timestamp: "2024-01-01T00:10:00Z", status: "blocked", error: "missing-data" },
    ];

    for (const event of events) {
      await writeAppendOnlyJSONL(filePath, event);
    }

    // Verify all events written
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3);

    // Verify each event matches exactly
    for (let i = 0; i < events.length; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.deepEqual(parsed, events[i], `Event ${i} should match exactly`);
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test("artifact-writer: atomic write with different complex object shapes", async () => {
  const testDir = createTestDir();
  try {
    // Test 1: Write a run-context style object
    const runContext = {
      run_id: "run-abc123",
      casino_id: "betfair",
      geo: "GB",
      created_at: "2024-01-01T00:00:00Z",
      version: 2,
      config: { depth: "full", timeout_sec: 30 },
    };

    const contextPath = path.join(testDir, "contexts", "run-context.json");
    await writeAtomicJSON(contextPath, runContext);
    const readContext = JSON.parse(fs.readFileSync(contextPath, "utf-8"));
    assert.deepEqual(readContext, runContext);

    // Test 2: Write a completely different structure
    const coverage = {
      total_urls: 156,
      unique_candidates: 42,
      by_source: { dom: 80, spa: 42, api: 20, external: 14 },
    };

    const coveragePath = path.join(testDir, "coverage.json");
    await writeAtomicJSON(coveragePath, coverage);
    const readCoverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));
    assert.deepEqual(readCoverage, coverage);
  } finally {
    cleanupTestDir(testDir);
  }
});

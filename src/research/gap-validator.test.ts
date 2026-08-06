import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGapProbeResult,
  validateAndMergeGapPatch,
  type GapProbeRequest,
  type GapProbeResult,
  type ValidatedGapPatch,
} from "./gap-validator.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gap-validator-test-"));
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("gap-validator: multiple URLs in result fail validation", async () => {
  const request: GapProbeRequest = {
    gap_id: "gap-001",
    casino_id: "casino-123",
    field_id: "casinos:year_of_foundation",
    section: "company_info",
    frozen_url: "https://example.com/about",
    allowed_actions: ["click", "read"],
    stop_condition: "element_found",
  };

  const result: GapProbeResult = {
    gap_id: "gap-001",
    timestamp: new Date().toISOString(),
    urls_accessed: [
      "https://example.com/about",
      "https://example.com/history", // Multiple URLs - should fail
    ],
    field_values: ["2020"],
  };

  assert.throws(
    () => validateGapProbeResult(result, request),
    /multiple.*url|more than one url/i,
  );
});

test("gap-validator: missing stop condition fails validation", async () => {
  const request: GapProbeRequest = {
    gap_id: "gap-002",
    casino_id: "casino-123",
    field_id: "casinos:license_type",
    section: "legal",
    frozen_url: "https://example.com/legal",
    allowed_actions: ["click"],
    stop_condition: "element_found",
  };

  const result: GapProbeResult = {
    gap_id: "gap-002",
    timestamp: new Date().toISOString(),
    urls_accessed: ["https://example.com/legal"],
    field_values: ["Malta Gaming Authority"],
    // Missing stop_reason - should fail
  };

  assert.throws(
    () => validateGapProbeResult(result, request),
    /stop.*condition|stop_reason/i,
  );
});

test("gap-validator: probe cannot broaden URL, section, or field group", async () => {
  const request: GapProbeRequest = {
    gap_id: "gap-003",
    casino_id: "casino-123",
    field_id: "casinos:year_of_foundation",
    section: "company_info",
    frozen_url: "https://example.com/about",
    allowed_actions: ["read"],
    stop_condition: "element_found",
  };

  // Result with different URL - should fail
  const resultDifferentUrl: GapProbeResult = {
    gap_id: "gap-003",
    timestamp: new Date().toISOString(),
    urls_accessed: ["https://example.com/different"], // Different URL - broadening
    field_values: ["2020"],
    stop_reason: "element_found",
  };

  assert.throws(
    () => validateGapProbeResult(resultDifferentUrl, request),
    /url.*mismatch|must.*match frozen url/i,
  );

  // Result with different section - should fail
  const resultDifferentSection: GapProbeResult = {
    gap_id: "gap-003",
    timestamp: new Date().toISOString(),
    urls_accessed: ["https://example.com/about"],
    field_values: ["2020"],
    stop_reason: "element_found",
    section: "legal", // Different section - broadening
  };

  assert.throws(
    () => validateGapProbeResult(resultDifferentSection, request),
    /section.*mismatch|must.*match.*section/i,
  );
});

test("gap-validator: out-of-scope returned URLs are rejected", async () => {
  const request: GapProbeRequest = {
    gap_id: "gap-004",
    casino_id: "casino-123",
    field_id: "casinos:support_email",
    section: "contact",
    frozen_url: "https://example.com/contact",
    allowed_actions: ["read"],
    stop_condition: "element_found",
  };

  const result: GapProbeResult = {
    gap_id: "gap-004",
    timestamp: new Date().toISOString(),
    urls_accessed: ["https://example.com/contact"],
    field_values: ["support@example.com"],
    returned_urls: ["https://external-site.com/page"], // External URL - out of scope
    stop_reason: "element_found",
  };

  assert.throws(
    () => validateGapProbeResult(result, request),
    /out.*scope|external|different.*origin/i,
  );
});

test("gap-validator: raw probe output cannot modify canonical artifacts", async () => {
  const testDir = createTestDir();
  try {
    const runDir = path.join(testDir, "run-001");
    fs.mkdirSync(runDir, { recursive: true });

    // Write a canonical artifact
    const canonicalArtifact = {
      version: "1.0",
      created_at: "2024-01-01T00:00:00Z",
      immutable: true,
    };
    fs.writeFileSync(
      path.join(runDir, "field-coverage.json"),
      JSON.stringify(canonicalArtifact),
    );

    const request: GapProbeRequest = {
      gap_id: "gap-005",
      casino_id: "casino-123",
      field_id: "casinos:country",
      section: "location",
      frozen_url: "https://example.com/location",
      allowed_actions: ["read"],
      stop_condition: "element_found",
    };

    const result: GapProbeResult = {
      gap_id: "gap-005",
      timestamp: new Date().toISOString(),
      urls_accessed: ["https://example.com/location"],
      field_values: ["Malta"],
      stop_reason: "element_found",
    };

    // Validation should pass
    const validated = validateGapProbeResult(result, request);
    assert.ok(validated);

    // Write validated patch - should NOT overwrite canonical artifact
    const patch: ValidatedGapPatch = {
      gap_id: "gap-005",
      field_id: "casinos:country",
      status: "accepted",
      value: "Malta",
      timestamp: new Date().toISOString(),
    };

    // This should handle merge without overwriting original
    const merged = validateAndMergeGapPatch(patch, runDir);
    assert.ok(merged);

    // Verify canonical artifact still has original content
    const canonicalContent = JSON.parse(
      fs.readFileSync(path.join(runDir, "field-coverage.json"), "utf-8"),
    );
    assert.deepEqual(canonicalContent, canonicalArtifact);
  } finally {
    cleanupTestDir(testDir);
  }
});

test("gap-validator: second same-section cycle is denied by policy", async () => {
  const testDir = createTestDir();
  try {
    const runDir = path.join(testDir, "run-002");
    fs.mkdirSync(runDir, { recursive: true });

    // Write evidence of first cycle for section "legal"
    const probeHistory = {
      cycles: [
        {
          section: "legal",
          timestamp: "2024-01-01T10:00:00Z",
          field_id: "casinos:license_type",
          status: "completed",
        },
      ],
    };
    fs.writeFileSync(
      path.join(runDir, "gap-probe-history.json"),
      JSON.stringify(probeHistory),
    );

    const request: GapProbeRequest = {
      gap_id: "gap-006",
      casino_id: "casino-123",
      field_id: "casinos:license_number", // Different field, same section
      section: "legal", // Same section - should be denied
      frozen_url: "https://example.com/legal",
      allowed_actions: ["read"],
      stop_condition: "element_found",
    };

    const result: GapProbeResult = {
      gap_id: "gap-006",
      timestamp: new Date().toISOString(),
      urls_accessed: ["https://example.com/legal"],
      field_values: ["Malta License"],
      stop_reason: "element_found",
    };

    // Attempting to validate a second cycle for the same section should fail
    assert.throws(
      () => validateGapProbeResult(result, request, runDir),
      /second.*cycle|already.*probed|policy.*deny/i,
    );
  } finally {
    cleanupTestDir(testDir);
  }
});

test("gap-validator: valid probe result passes all checks", async () => {
  const request: GapProbeRequest = {
    gap_id: "gap-007",
    casino_id: "casino-123",
    field_id: "casinos:year_of_foundation",
    section: "company_info",
    frozen_url: "https://example.com/about",
    allowed_actions: ["click", "read"],
    stop_condition: "element_found",
  };

  const result: GapProbeResult = {
    gap_id: "gap-007",
    timestamp: new Date().toISOString(),
    urls_accessed: ["https://example.com/about"],
    field_values: ["2020"],
    stop_reason: "element_found",
    returned_urls: ["https://example.com/careers"], // Same origin
  };

  // Should pass all validation
  const validated = validateGapProbeResult(result, request);
  assert.ok(validated);
  assert.equal(validated.gap_id, "gap-007");
});

test("gap-validator: merge creates validated-gap-patch.json", async () => {
  const testDir = createTestDir();
  try {
    const runDir = path.join(testDir, "run-003");
    fs.mkdirSync(runDir, { recursive: true });

    const patch: ValidatedGapPatch = {
      gap_id: "gap-008",
      field_id: "casinos:support_email",
      status: "accepted",
      value: "support@example.com",
      timestamp: new Date().toISOString(),
    };

    const merged = validateAndMergeGapPatch(patch, runDir);
    assert.ok(merged);

    // Verify file was written
    const patchPath = path.join(runDir, "validated-gap-patch.json");
    assert.ok(fs.existsSync(patchPath));

    const content = JSON.parse(fs.readFileSync(patchPath, "utf-8"));
    assert.ok(Array.isArray(content.patches));
    assert.equal(content.patches.length, 1);
    assert.equal(content.patches[0].field_id, "casinos:support_email");
  } finally {
    cleanupTestDir(testDir);
  }
});

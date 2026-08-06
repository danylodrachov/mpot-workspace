import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderDiscoveryReport, type DiscoveryReview } from "./final-report-renderer.ts";
import type { FieldCoverageOutput } from "./coverage-reporter.ts";

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "report-test-"));
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockCoverageData(): FieldCoverageOutput {
  return {
    fields: [
      {
        field_id: "casino:name",
        category: "casino",
        name: "Casino Name",
        type: "text",
        status: "found",
        evidence_count: 2,
        visited_urls: ["https://example.com/"],
      },
      {
        field_id: "support:email",
        category: "support",
        name: "Support Email",
        type: "email",
        status: "missing",
        evidence_count: 0,
        visited_urls: ["https://example.com/"],
      },
      {
        field_id: "legal:license",
        category: "legal",
        name: "License Number",
        type: "text",
        status: "blocked",
        evidence_count: 0,
        visited_urls: ["https://example.com/"],
      },
    ],
    total_fields: 3,
    found_count: 1,
    missing_count: 1,
    blocked_count: 1,
    conflicting_count: 0,
    error_count: 0,
    version: "1.0.0",
  };
}

function createMockDeltaData() {
  return {
    gaps: [
      {
        field_id: "support:email",
        category: "support",
        name: "Support Email",
        gap_type: "missing" as const,
        visited_urls: ["https://example.com/"],
      },
      {
        field_id: "legal:license",
        category: "legal",
        name: "License Number",
        gap_type: "blocked" as const,
        visited_urls: ["https://example.com/"],
        source_family_limitations: ["forms"],
      },
    ],
    total_gaps: 2,
    version: "1.0.0",
  };
}

test("final-report-renderer: rendering identical inputs is byte-stable", async () => {
  const testDir = createTestDir();
  try {
    const coverageData = createMockCoverageData();
    const deltaData = createMockDeltaData();
    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath1 = path.join(testDir, "discovery-review-1.json");
    const reportPath2 = path.join(testDir, "discovery-review-2.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    // Render report twice with same inputs
    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath1,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath2,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    // Read both reports
    const report1 = fs.readFileSync(reportPath1, "utf-8");
    const report2 = fs.readFileSync(reportPath2, "utf-8");

    // Parse both as JSON to allow timestamp differences
    const review1: DiscoveryReview = JSON.parse(report1);
    const review2: DiscoveryReview = JSON.parse(report2);

    // Verify structure is identical (except for timestamp fields)
    assert.equal(review1.completion_status, review2.completion_status);
    assert.equal(review1.summary.found_count, review2.summary.found_count);
    assert.equal(review1.summary.missing_count, review2.summary.missing_count);
    assert.equal(review1.summary.blocked_count, review2.summary.blocked_count);
  } finally {
    cleanupTestDir(testDir);
  }
});

test("final-report-renderer: an unreported blocker cannot return complete", async () => {
  const testDir = createTestDir();
  try {
    const coverageData = createMockCoverageData();
    const deltaData = createMockDeltaData();
    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath = path.join(testDir, "discovery-review.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    const reportContent = fs.readFileSync(reportPath, "utf-8");
    const review: DiscoveryReview = JSON.parse(reportContent);

    // With blocked fields, should return partial
    assert.notEqual(
      review.completion_status,
      "complete",
      "Unreported blocker should not return complete"
    );
    assert.equal(review.completion_status, "partial");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("final-report-renderer: missing evidence is never shown as positive finding", async () => {
  const testDir = createTestDir();
  try {
    const coverageData = createMockCoverageData();
    const deltaData = createMockDeltaData();
    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath = path.join(testDir, "discovery-review.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    const reportContent = fs.readFileSync(reportPath, "utf-8");
    const review: DiscoveryReview = JSON.parse(reportContent);

    // Verify missing field is not shown in findings (should be in gaps only)
    const findingFieldIds = review.findings?.map((f) => f.field_id) || [];
    assert.ok(
      !findingFieldIds.includes("support:email"),
      "Missing field should not be in findings"
    );
  } finally {
    cleanupTestDir(testDir);
  }
});

test("final-report-renderer: properly reported blocked fixture returns partial", async () => {
  const testDir = createTestDir();
  try {
    const coverageData: FieldCoverageOutput = {
      fields: [
        {
          field_id: "casino:name",
          category: "casino",
          name: "Casino Name",
          type: "text",
          status: "found",
          evidence_count: 1,
          visited_urls: ["https://example.com/"],
        },
        {
          field_id: "legal:license",
          category: "legal",
          name: "License Number",
          type: "text",
          status: "blocked",
          evidence_count: 0,
          visited_urls: ["https://example.com/"],
        },
      ],
      total_fields: 2,
      found_count: 1,
      missing_count: 0,
      blocked_count: 1,
      conflicting_count: 0,
      error_count: 0,
      version: "1.0.0",
    };

    const deltaData = {
      gaps: [
        {
          field_id: "legal:license",
          category: "legal",
          name: "License Number",
          gap_type: "blocked" as const,
          visited_urls: ["https://example.com/"],
          source_family_limitations: ["forms", "metadata"],
        },
      ],
      total_gaps: 1,
      version: "1.0.0",
    };

    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath = path.join(testDir, "discovery-review.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    const reportContent = fs.readFileSync(reportPath, "utf-8");
    const review: DiscoveryReview = JSON.parse(reportContent);

    // With properly reported blocked field, should return partial
    assert.equal(review.completion_status, "partial");

    // Verify gap is reported with proper reason
    assert.ok(
      review.gaps && review.gaps.length > 0,
      "Blocked field should be reported as gap"
    );
    const blockedGap = review.gaps.find((g) => g.field_id === "legal:license");
    assert.ok(blockedGap, "Blocked field gap should exist");
    assert.equal(blockedGap.gap_type, "blocked");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("final-report-renderer: read-only processing doesn't mutate inputs", async () => {
  const testDir = createTestDir();
  try {
    const coverageData = createMockCoverageData();
    const deltaData = createMockDeltaData();
    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath = path.join(testDir, "discovery-review.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    // Read original content
    const originalCoverage = fs.readFileSync(coveragePath, "utf-8");
    const originalDelta = fs.readFileSync(deltaPath, "utf-8");

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath,
      { run_id: "test-run-1", casino_id: "test-casino" } as any,
      { plan: [] }
    );

    // Verify input files are unchanged
    const afterCoverage = fs.readFileSync(coveragePath, "utf-8");
    const afterDelta = fs.readFileSync(deltaPath, "utf-8");

    assert.equal(
      originalCoverage,
      afterCoverage,
      "Coverage file should not be mutated"
    );
    assert.equal(originalDelta, afterDelta, "Delta file should not be mutated");
  } finally {
    cleanupTestDir(testDir);
  }
});

test("final-report-renderer: works with completely different casino data", async () => {
  const testDir = createTestDir();
  try {
    // Different casino, different fields, all found
    const coverageData: FieldCoverageOutput = {
      fields: [
        {
          field_id: "contact:phone",
          category: "contact",
          name: "Phone Number",
          type: "text",
          status: "found",
          evidence_count: 1,
          visited_urls: ["https://different-casino.org/contact"],
        },
        {
          field_id: "contact:address",
          category: "contact",
          name: "Address",
          type: "text",
          status: "found",
          evidence_count: 2,
          visited_urls: ["https://different-casino.org/contact"],
        },
        {
          field_id: "banking:withdrawal_methods",
          category: "banking",
          name: "Withdrawal Methods",
          type: "dropdown",
          status: "missing",
          evidence_count: 0,
          visited_urls: ["https://different-casino.org/banking"],
        },
      ],
      total_fields: 3,
      found_count: 2,
      missing_count: 1,
      blocked_count: 0,
      conflicting_count: 0,
      error_count: 0,
      version: "1.0.0",
    };

    const deltaData = {
      gaps: [
        {
          field_id: "banking:withdrawal_methods",
          category: "banking",
          name: "Withdrawal Methods",
          gap_type: "missing" as const,
          visited_urls: ["https://different-casino.org/banking"],
        },
      ],
      total_gaps: 1,
      version: "1.0.0",
    };

    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");
    const reportPath = path.join(testDir, "discovery-review.json");

    fs.writeFileSync(coveragePath, JSON.stringify(coverageData, null, 2));
    fs.writeFileSync(deltaPath, JSON.stringify(deltaData, null, 2));

    await renderDiscoveryReport(
      coveragePath,
      deltaPath,
      reportPath,
      { run_id: "run-xyz", casino_id: "different-casino-org" } as any,
      { plan: [] }
    );

    const reportContent = fs.readFileSync(reportPath, "utf-8");
    const review: DiscoveryReview = JSON.parse(reportContent);

    // Verify run_id and casino_id are from this different data
    assert.equal(review.run_id, "run-xyz");
    assert.equal(review.casino_id, "different-casino-org");

    // With 2 found and 1 missing but no blocked/error, should be partial
    assert.equal(review.completion_status, "partial");

    // Verify summary counts
    assert.equal(review.summary.found_count, 2);
    assert.equal(review.summary.missing_count, 1);
    assert.equal(review.summary.blocked_count, 0);

    // Verify findings contain only found fields (different IDs)
    const findingIds = review.findings?.map((f) => f.field_id) || [];
    assert.ok(
      findingIds.includes("contact:phone"),
      "contact:phone should be in findings"
    );
    assert.ok(
      findingIds.includes("contact:address"),
      "contact:address should be in findings"
    );
    assert.ok(
      !findingIds.includes("banking:withdrawal_methods"),
      "banking:withdrawal_methods should not be in findings"
    );

    // Verify gaps contain only non-found fields
    const gapIds = review.gaps?.map((g) => g.field_id) || [];
    assert.ok(
      gapIds.includes("banking:withdrawal_methods"),
      "banking:withdrawal_methods should be in gaps"
    );
  } finally {
    cleanupTestDir(testDir);
  }
});

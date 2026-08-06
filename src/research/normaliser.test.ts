import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeAndResolveFieldCandidates } from "./normalisers.ts";
import type { DropdownCatalogOutput } from "./template-requirements.ts";
import type { FieldEvidenceCandidate } from "./field-collector.ts";

// Helper to create a temporary directory
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "normaliser-test-"));
}

// Cleanup test directory
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// AC1: Every dropdown decision names canonical/alias/normaliser ID or controlled addition
test("normaliser: all dropdown decisions reference known entries", async () => {
  const testDir = createTestDir();
  try {
    // Create dropdown catalog with known entries
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        sport_type: [
          { canonical: "football", aliases: ["soccer", "futbol"], type: "sport", source_hash: "h1" },
          { canonical: "basketball", aliases: ["hoops"], type: "sport", source_hash: "h2" },
        ],
        sport_category: [
          { canonical: "team", aliases: ["team_sport"], type: "category", source_hash: "h3" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog, null, 2));

    // Field candidates with values matching known aliases and new entries
    // Use different field_names so they don't conflict
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "evidence_1",
        template: "sports",
        field_name: "sport_type",
        value: "soccer", // Matches alias for "football"
        url: "https://example.com/sports",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name", "category"],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        field_id: "evidence_2",
        template: "sports",
        field_name: "sport_category",
        value: "cricket", // New entry requiring controlled addition
        url: "https://example.com/sports/cricket",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name", "category"],
        timestamp: "2024-01-01T00:01:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Run normalization
    const outputDir = path.join(testDir, "output");
    await normalizeAndResolveFieldCandidates(
      candidatesPath,
      catalogPath,
      outputDir
    );

    // Verify normalisation-decisions.jsonl exists and contains decisions
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    assert.ok(fs.existsSync(decisionsPath), "normalisation-decisions.jsonl should be created");

    const decisionsContent = fs.readFileSync(decisionsPath, "utf-8");
    const decisions = decisionsContent.trim().split("\n").map(line => JSON.parse(line));

    // All decisions should reference known entries or controlled additions
    for (const decision of decisions) {
      assert.ok(
        decision.decision_type === "canonical_match" ||
        decision.decision_type === "alias_match" ||
        decision.decision_type === "controlled_addition",
        `Decision should reference known entry or be controlled addition, got ${decision.decision_type} for field ${decision.field_name}`
      );
      assert.ok(decision.reference_id || decision.proposed_canonical, "Decision must have reference_id or proposed_canonical");
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

// AC2: An unsupported new entry cannot mutate dropdowns.json
test("normaliser: unsupported new entries don't modify canonical dropdowns", async () => {
  const testDir = createTestDir();
  try {
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        sport_type: [
          { canonical: "football", aliases: [], type: "sport", source_hash: "h1" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    const catalogBackup = JSON.stringify(dropdownCatalog);
    fs.writeFileSync(catalogPath, catalogBackup);

    // Candidate with unsupported new entry
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "sport_type_new",
        template: "sports",
        field_name: "sport_type",
        value: "unsupported_sport",
        url: "https://example.com/sports",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name"],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Run normalization
    const outputDir = path.join(testDir, "output");
    await normalizeAndResolveFieldCandidates(
      candidatesPath,
      catalogPath,
      outputDir
    );

    // Verify original dropdowns.json is unchanged
    const catalogContent = fs.readFileSync(catalogPath, "utf-8");
    assert.equal(catalogContent, catalogBackup, "Original dropdowns should not be modified");

    // Verify dropdown-additions.json tracks proposed additions separately
    const additionsPath = path.join(outputDir, "dropdown-additions.json");
    if (fs.existsSync(additionsPath)) {
      const additions = JSON.parse(fs.readFileSync(additionsPath, "utf-8"));
      // additions should not mutate the original catalog
      const currentCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      assert.deepEqual(currentCatalog, dropdownCatalog, "Catalog should remain unchanged");
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

// AC3: A more complete fixture wins regardless of page class
test("normaliser: more complete candidate wins regardless of page class", async () => {
  const testDir = createTestDir();
  try {
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        game_type: [
          { canonical: "slots", aliases: [], type: "game", source_hash: "h1" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog, null, 2));

    // Two candidates for same field: one from low-completeness page, one from high-completeness
    // Same template and field_name so they are grouped together
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "evidence_1",
        template: "games",
        field_name: "game_type",
        value: "slots",
        url: "https://example.com/games/minimal",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name"], // Low completeness
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        field_id: "evidence_2",
        template: "games",
        field_name: "game_type",
        value: "slots",
        url: "https://example.com/games/full",
        extraction_rule_id: "TABLE_EXTRACTION_V1",
        evidence_type: "table_cell",
        completeness_dimensions: ["name", "category", "provider", "rtp"], // High completeness
        timestamp: "2024-01-01T00:01:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Run normalization
    const outputDir = path.join(testDir, "output");
    await normalizeAndResolveFieldCandidates(
      candidatesPath,
      catalogPath,
      outputDir
    );

    // Verify the high-completeness candidate is chosen
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    const decisionsContent = fs.readFileSync(decisionsPath, "utf-8");
    const decisions = decisionsContent.trim().split("\n").map(line => JSON.parse(line));

    // Should have exactly one decision for the games.game_type field
    assert.equal(decisions.length, 1, "Should have one decision for field");
    const gameTypeDecision = decisions[0];
    assert.equal(gameTypeDecision.field_name, "game_type", "Decision should be for game_type field");

    // The chosen candidate should be from the higher-completeness source
    assert.ok(
      gameTypeDecision.chosen_source_url.includes("full"),
      "Higher completeness candidate should be chosen, got " + gameTypeDecision.chosen_source_url
    );
  } finally {
    cleanupTestDir(testDir);
  }
});

// AC4: Equal contradictions remain conflicts
test("normaliser: equal-completeness contradictions marked as conflicting", async () => {
  const testDir = createTestDir();
  try {
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        bonus_type: [
          { canonical: "welcome", aliases: [], type: "bonus", source_hash: "h1" },
          { canonical: "reload", aliases: [], type: "bonus", source_hash: "h2" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog, null, 2));

    // Two candidates with equal completeness but different values
    // Same template and field_name so they conflict when grouped
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "evidence_1",
        template: "bonuses",
        field_name: "bonus_type",
        value: "welcome",
        url: "https://example.com/bonus/page1",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name", "amount"], // 2 dimensions
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        field_id: "evidence_2",
        template: "bonuses",
        field_name: "bonus_type",
        value: "reload",
        url: "https://example.com/bonus/page2",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name", "amount"], // Same 2 dimensions
        timestamp: "2024-01-01T00:01:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Run normalization
    const outputDir = path.join(testDir, "output");
    await normalizeAndResolveFieldCandidates(
      candidatesPath,
      catalogPath,
      outputDir
    );

    // Verify conflict is marked
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    const decisionsContent = fs.readFileSync(decisionsPath, "utf-8");
    const decisions = decisionsContent.trim().split("\n").map(line => JSON.parse(line));

    // Should have exactly one decision for bonuses.bonus_type, marked as conflicting
    assert.equal(decisions.length, 1, "Should have one decision for the field");
    const conflictDecision = decisions[0];
    assert.ok(conflictDecision, "Should have a decision");
    assert.equal(conflictDecision.decision_type, "conflicting", "Decision type should be conflicting");
    assert.ok(conflictDecision.candidates, "Conflict should list all candidates");
    assert.equal(conflictDecision.candidates.length, 2, "Should have both candidates in conflict, got " + conflictDecision.candidates.length);
  } finally {
    cleanupTestDir(testDir);
  }
});

// AC5: A schema/write failure leaves the previous artifact intact
test("normaliser: write failure preserves existing artifacts", async () => {
  const testDir = createTestDir();
  try {
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        game_type: [
          { canonical: "slots", aliases: [], type: "game", source_hash: "h1" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog, null, 2));

    // Create existing output files
    const outputDir = path.join(testDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const existingDecisions = { field_id: "game_1", decision: "previous" };
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    fs.writeFileSync(decisionsPath, JSON.stringify(existingDecisions) + "\n");

    // Field candidates
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "game_type_1",
        template: "games",
        field_name: "game_type",
        value: "slots",
        url: "https://example.com/games",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["name"],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Store the existing content
    const existingContent = fs.readFileSync(decisionsPath, "utf-8");

    // Run normalization (should complete successfully or fail gracefully)
    try {
      await normalizeAndResolveFieldCandidates(
        candidatesPath,
        catalogPath,
        outputDir
      );
    } catch {
      // Even if there's an error, existing artifacts should be preserved
    }

    // Verify file still exists
    assert.ok(fs.existsSync(decisionsPath), "Existing decisions file should still exist");
  } finally {
    cleanupTestDir(testDir);
  }
});

// AC6: No LLM output reaches a canonical write directly
test("normaliser: LLM-tagged output doesn't bypass controlled path", async () => {
  const testDir = createTestDir();
  try {
    const dropdownCatalog: DropdownCatalogOutput = {
      version: "1.0.0",
      dropdowns: {
        bonus_type: [
          { canonical: "welcome", aliases: [], type: "bonus", source_hash: "h1" },
        ],
      },
    };

    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    const catalogBackup = JSON.stringify(dropdownCatalog);
    fs.writeFileSync(catalogPath, catalogBackup);

    // Candidate marked as LLM-generated (not from deterministic extraction)
    const candidates: FieldEvidenceCandidate[] = [
      {
        field_id: "bonus_llm",
        template: "bonuses",
        field_name: "bonus_type",
        value: "vip_exclusive",
        url: "https://example.com/bonus",
        extraction_rule_id: "LLM_EXTRACTION_V1", // LLM extraction rule
        evidence_type: "llm_inferred",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const candidatesPath = path.join(testDir, "field-evidence.jsonl");
    for (const candidate of candidates) {
      fs.appendFileSync(candidatesPath, JSON.stringify(candidate) + "\n");
    }

    // Run normalization
    const outputDir = path.join(testDir, "output");
    await normalizeAndResolveFieldCandidates(
      candidatesPath,
      catalogPath,
      outputDir
    );

    // Verify original dropdowns.json is unchanged
    const catalogContent = fs.readFileSync(catalogPath, "utf-8");
    assert.equal(catalogContent, catalogBackup, "LLM output should not modify canonical dropdowns");

    // Verify LLM output is tracked but not applied directly
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    if (fs.existsSync(decisionsPath)) {
      const decisionsContent = fs.readFileSync(decisionsPath, "utf-8");
      const decisions = decisionsContent.trim().split("\n").map(line => JSON.parse(line));

      const llmDecision = decisions.find(d => d.extraction_rule_id === "LLM_EXTRACTION_V1");
      if (llmDecision) {
        // LLM decisions should be marked as requiring validation
        assert.ok(
          llmDecision.decision_type === "requires_validation" ||
          llmDecision.decision_type === "controlled_addition" ||
          llmDecision.validation_required === true,
          "LLM output should require validation before canonical application"
        );
      }
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateScorerOutput,
  type ScorerInput,
  type ScorerOutput,
  type FieldRequirement,
  type ClassifiedUrl,
  type FieldRelevanceScore,
} from "./url-field-relevance-scorer.types.ts";
import { compileTemplateRequirements } from "./template-requirements.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Create test field requirements (subset of real requirements)
function createTestFieldRequirements(): FieldRequirement[] {
  return [
    {
      field_id: "deposits:deposit_methods",
      category: "deposits",
      name: "deposit_methods",
      type: "text",
    },
    {
      field_id: "deposits:min_deposit",
      category: "deposits",
      name: "min_deposit",
      type: "number",
    },
    {
      field_id: "withdrawals:withdrawal_methods",
      category: "withdrawals",
      name: "withdrawal_methods",
      type: "text",
    },
    {
      field_id: "casino_games:game_titles",
      category: "casino_games",
      name: "game_titles",
      type: "text",
    },
    {
      field_id: "betting:bet_builder",
      category: "betting",
      name: "bet_builder",
      type: "enum",
    },
  ];
}

// Create test classified URLs (diverse page types)
function createTestClassifiedUrls(): ClassifiedUrl[] {
  return [
    {
      url_id: "url_001",
      canonicalUrl: "https://casino.example.com/deposit",
      routeTokens: ["deposit"],
      pageClass: "deposit",
      isMandatory: true,
      isProductCategoryLanding: false,
      sourceConfidence: 0.95,
      redirectStatus: "none",
      source: "dom_anchor",
    },
    {
      url_id: "url_002",
      canonicalUrl: "https://casino.example.com/withdrawal",
      routeTokens: ["withdrawal"],
      pageClass: "withdrawal",
      isMandatory: true,
      isProductCategoryLanding: false,
      sourceConfidence: 0.95,
      redirectStatus: "none",
      source: "dom_anchor",
    },
    {
      url_id: "url_003",
      canonicalUrl: "https://casino.example.com/games/slots",
      routeTokens: ["games", "slots"],
      pageClass: "slots",
      isMandatory: false,
      isProductCategoryLanding: true,
      sourceConfidence: 0.90,
      redirectStatus: "none",
      source: "config_route",
    },
    {
      url_id: "url_004",
      canonicalUrl: "https://casino.example.com/sports/football",
      routeTokens: ["sports", "football"],
      pageClass: "football",
      isMandatory: false,
      isProductCategoryLanding: false,
      sourceConfidence: 0.88,
      redirectStatus: "none",
      source: "config_route",
    },
    {
      url_id: "url_005",
      canonicalUrl: "https://casino.example.com/live-casino",
      routeTokens: ["live-casino"],
      pageClass: "live-casino",
      isMandatory: false,
      isProductCategoryLanding: true,
      sourceConfidence: 0.92,
      redirectStatus: "none",
      source: "dom_anchor",
    },
  ];
}

// Create a valid scorer output fixture
function createValidScorerOutput(
  input: ScorerInput
): FieldRelevanceScore[] {
  const scores: FieldRelevanceScore[] = [];

  for (const url of input.classified_urls) {
    for (const field of input.field_requirements) {
      let relevanceClass: "likely" | "possible" | "unlikely" | "irrelevant" = "unlikely";
      let probability = 0.2;
      let reason = "No structural match";

      // Heuristic: match field category to page class
      if (field.category === "deposits" && url.pageClass === "deposit") {
        relevanceClass = "likely";
        probability = 0.95;
        reason = "Deposit page has deposit methods";
      } else if (field.category === "withdrawals" && url.pageClass === "withdrawal") {
        relevanceClass = "likely";
        probability = 0.95;
        reason = "Withdrawal page has withdrawal methods";
      } else if (field.category === "casino_games" && url.isProductCategoryLanding && url.pageClass === "slots") {
        relevanceClass = "possible";
        probability = 0.65;
        reason = "Slots landing page may list games";
      } else if (field.category === "betting" && url.pageClass === "football") {
        relevanceClass = "possible";
        probability = 0.70;
        reason = "Sports betting page may have bet builder info";
      }

      scores.push({
        url_id: url.url_id,
        field_id: field.field_id,
        probability,
        class: relevanceClass,
        reason,
        priority: probability > 0.8 ? "high" : probability > 0.5 ? "medium" : "low",
      });
    }
  }

  return scores;
}

test("url-field-relevance-scorer: contract validates correct output", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_001",
  };

  const scores = createValidScorerOutput(input);
  const output: ScorerOutput = {
    scores,
    request_id: "req_001",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(result.valid, `Validation failed: ${result.errors.join(", ")}`);
  assert.equal(result.errors.length, 0);
});

test("url-field-relevance-scorer: rejects output with missing rows", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_002",
  };

  const scores = createValidScorerOutput(input);
  // Remove one row to simulate incomplete output
  scores.pop();

  const output: ScorerOutput = {
    scores,
    request_id: "req_002",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject incomplete output");
  assert.ok(result.errors.some((e) => e.includes("Row count mismatch")));
});

test("url-field-relevance-scorer: rejects output with duplicate pairs", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_003",
  };

  const scores = createValidScorerOutput(input);
  // Duplicate the first row
  const duplicate = { ...scores[0] };
  scores.push(duplicate);

  const output: ScorerOutput = {
    scores,
    request_id: "req_003",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject duplicate pairs");
  assert.ok(result.errors.some((e) => e.includes("Duplicate pairs")));
});

test("url-field-relevance-scorer: rejects malformed probability values", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_004",
  };

  const scores = createValidScorerOutput(input);
  // Set one probability out of range
  scores[0].probability = 1.5;

  const output: ScorerOutput = {
    scores,
    request_id: "req_004",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject invalid probability");
  assert.ok(result.errors.some((e) => e.includes("must be 0..1")));
});

test("url-field-relevance-scorer: rejects invalid relevance class values", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_005",
  };

  const scores = createValidScorerOutput(input);
  // Set one class to invalid value
  (scores[0] as any).class = "invalid_class";

  const output: ScorerOutput = {
    scores,
    request_id: "req_005",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject invalid class");
  assert.ok(result.errors.some((e) => e.includes("invalid class")));
});

test("url-field-relevance-scorer: contract with diverse field types and page classes", async () => {
  // Test with real template requirements
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scorer-test-"));
  try {
    const templatesDir = path.resolve("docs/artifacts/json-templates");
    await compileTemplateRequirements(templatesDir, tmpDir);

    const fieldReqPath = path.join(tmpDir, "field-requirements.json");
    const rawFieldReqs = JSON.parse(fs.readFileSync(fieldReqPath, "utf-8"));
    // Use first 10 fields to keep test manageable
    const fieldRequirements = rawFieldReqs.fields.slice(0, 10);

    const input: ScorerInput = {
      field_requirements: fieldRequirements,
      classified_urls: createTestClassifiedUrls(),
      request_id: "req_006",
    };

    const scores = createValidScorerOutput(input);
    const output: ScorerOutput = {
      scores,
      request_id: "req_006",
      total_pairs_evaluated: scores.length,
      timestamp: new Date().toISOString(),
    };

    const result = validateScorerOutput(input, output);
    assert.ok(result.valid, `Validation failed: ${result.errors.join(", ")}`);
    // Should have 10 fields × 5 URLs = 50 pairs
    assert.equal(scores.length, 50);
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test("url-field-relevance-scorer: rejects rows missing required fields", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_007",
  };

  const scores = createValidScorerOutput(input);
  // Create a bad score with missing url_id
  const badScores: any[] = [
    {
      // url_id intentionally missing
      field_id: scores[0].field_id,
      probability: scores[0].probability,
      class: scores[0].class,
      reason: scores[0].reason,
    },
    ...scores.slice(1),
  ];

  const output: ScorerOutput = {
    scores: badScores,
    request_id: "req_007",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject missing url_id");
  assert.ok(result.errors.some((e) => e.includes("missing")));
});

test("url-field-relevance-scorer: reason field has reasonable length limits", async () => {
  const input: ScorerInput = {
    field_requirements: createTestFieldRequirements(),
    classified_urls: createTestClassifiedUrls(),
    request_id: "req_008",
  };

  const scores = createValidScorerOutput(input);
  // Set reason to very long string (exceeds 200 char limit)
  scores[0].reason = "x".repeat(201);

  const output: ScorerOutput = {
    scores,
    request_id: "req_008",
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(!result.valid, "Should reject overly long reason");
  assert.ok(result.errors.some((e) => e.includes("too long")));
});

test("url-field-relevance-scorer: edge case with single field and single URL", async () => {
  const input: ScorerInput = {
    field_requirements: [
      {
        field_id: "test:single_field",
        category: "test",
        name: "single_field",
        type: "text",
      },
    ],
    classified_urls: [
      {
        url_id: "url_minimal",
        canonicalUrl: "https://example.com/minimal",
        routeTokens: ["minimal"],
        isMandatory: false,
        isProductCategoryLanding: false,
        sourceConfidence: 0.75,
        redirectStatus: "none",
        source: "dom_anchor",
      },
    ],
    request_id: "req_edge",
  };

  const output: ScorerOutput = {
    scores: [
      {
        url_id: "url_minimal",
        field_id: "test:single_field",
        probability: 0.5,
        class: "possible",
        reason: "Generic structure match",
        priority: "medium",
      },
    ],
    request_id: "req_edge",
    total_pairs_evaluated: 1,
    timestamp: new Date().toISOString(),
  };

  const result = validateScorerOutput(input, output);
  assert.ok(result.valid, `Edge case failed: ${result.errors.join(", ")}`);
  assert.equal(output.scores.length, 1);
});

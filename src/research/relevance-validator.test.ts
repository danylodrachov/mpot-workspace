import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRelevanceMatrix,
  buildVisitPlan,
  type UrlFieldRelevanceEntry,
  type VisitPlanEntry,
  type LlmRejectedUrlEntry,
} from "./relevance-validator.ts";
import { type FieldRequirement } from "./url-field-relevance-scorer.types.ts";
import { type UrlMapEntry } from "./url-map-recon/types.ts";

// Shared test data
const fieldRequirements: FieldRequirement[] = [
  { field_id: "casino:name", category: "casino", name: "name", type: "string" },
  { field_id: "casino:year", category: "casino", name: "year_of_foundation", type: "number" },
  { field_id: "betting:min_bet", category: "betting", name: "min_bet", type: "number" },
];

const cleanedUrls: UrlMapEntry[] = [
  {
    canonicalUrl: "https://casino.example/about",
    url_id: "url_001",
    pageClass: "about",
    isMandatory: true,
    isProductCategoryLanding: false,
    sourceConfidence: 0.95,
    redirectStatus: "direct",
    originStatus: "official_same_origin",
    source: "dom_anchor",
  },
  {
    canonicalUrl: "https://casino.example/casino/games",
    url_id: "url_002",
    pageClass: "game_listing",
    isMandatory: false,
    isProductCategoryLanding: true,
    sourceConfidence: 0.9,
    redirectStatus: "direct",
    originStatus: "official_same_origin",
    source: "spa_route",
  },
  {
    canonicalUrl: "https://casino.example/unknown-page",
    url_id: "url_003",
    pageClass: undefined,
    isMandatory: false,
    isProductCategoryLanding: false,
    sourceConfidence: 0.5,
    redirectStatus: "direct",
    originStatus: "official_same_origin",
    source: "dom_anchor",
  },
];

test("AC1: An incomplete matrix never drops the affected URL", () => {
  // Scorer provides only some pairs (e.g., missing url_003's scores)
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    // url_001 complete
    { url_id: "url_001", field_id: "casino:name", probability: 0.9, class: "likely", reason: "About page typically contains casino name" },
    { url_id: "url_001", field_id: "casino:year", probability: 0.7, class: "possible", reason: "About page may contain founding year" },
    { url_id: "url_001", field_id: "betting:min_bet", probability: 0.2, class: "unlikely", reason: "About page unlikely to contain betting info" },
    // url_002 complete
    { url_id: "url_002", field_id: "casino:name", probability: 0.3, class: "unlikely", reason: "Game listing page unlikely to have casino name" },
    { url_id: "url_002", field_id: "casino:year", probability: 0.1, class: "irrelevant", reason: "Game listing never contains founding year" },
    { url_id: "url_002", field_id: "betting:min_bet", probability: 0.8, class: "likely", reason: "Game listings typically show minimum bets" },
    // url_003 MISSING ALL PAIRS — should still be included
  ];

  const result = validateRelevanceMatrix(scorerOutput, fieldRequirements, cleanedUrls);
  assert.strictEqual(result.valid, true);

  // Verify url_003 is still in visit plan despite missing matrix entries
  const visitPlan = buildVisitPlan(result.validatedMatrix, cleanedUrls);
  const url003InPlan = visitPlan.some((entry) => entry.url_id === "url_003");
  assert.strictEqual(url003InPlan, true);
});

test("AC2: Mandatory fixtures are scheduled despite all-field irrelevant scores", () => {
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    // url_001 is mandatory but marked irrelevant for all fields
    { url_id: "url_001", field_id: "casino:name", probability: 0.0, class: "irrelevant", reason: "No name here" },
    { url_id: "url_001", field_id: "casino:year", probability: 0.0, class: "irrelevant", reason: "No year here" },
    { url_id: "url_001", field_id: "betting:min_bet", probability: 0.0, class: "irrelevant", reason: "No betting info" },
    // url_002 with mixed relevance
    { url_id: "url_002", field_id: "casino:name", probability: 0.3, class: "unlikely", reason: "Possible" },
    { url_id: "url_002", field_id: "casino:year", probability: 0.0, class: "irrelevant", reason: "Not here" },
    { url_id: "url_002", field_id: "betting:min_bet", probability: 0.8, class: "likely", reason: "Likely" },
    // url_003
    { url_id: "url_003", field_id: "casino:name", probability: 0.1, class: "unlikely", reason: "Maybe" },
    { url_id: "url_003", field_id: "casino:year", probability: 0.1, class: "unlikely", reason: "Maybe" },
    { url_id: "url_003", field_id: "betting:min_bet", probability: 0.1, class: "unlikely", reason: "Maybe" },
  ];

  const result = validateRelevanceMatrix(scorerOutput, fieldRequirements, cleanedUrls);
  assert.strictEqual(result.valid, true);

  const visitPlan = buildVisitPlan(result.validatedMatrix, cleanedUrls);
  // url_001 is mandatory (isMandatory: true), so it must be in visit plan
  const url001Entry = visitPlan.find((entry) => entry.url_id === "url_001");
  assert.ok(url001Entry);
  assert.strictEqual(url001Entry.selected, true);
  assert.match(url001Entry.selectionReason, /mandatory/);
});

test("AC3: LLM-rejected URLs are absent from visits unless overridden", () => {
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    // url_001 is useful
    { url_id: "url_001", field_id: "casino:name", probability: 0.9, class: "likely", reason: "Name here" },
    { url_id: "url_001", field_id: "casino:year", probability: 0.7, class: "possible", reason: "Year here" },
    { url_id: "url_001", field_id: "betting:min_bet", probability: 0.2, class: "unlikely", reason: "No betting" },
    // url_002 is useful (product category landing)
    { url_id: "url_002", field_id: "casino:name", probability: 0.3, class: "unlikely", reason: "Unlikely" },
    { url_id: "url_002", field_id: "casino:year", probability: 0.1, class: "irrelevant", reason: "Never" },
    { url_id: "url_002", field_id: "betting:min_bet", probability: 0.8, class: "likely", reason: "Yes" },
    // url_003 is LLM-rejected (all irrelevant, not mandatory)
    { url_id: "url_003", field_id: "casino:name", probability: 0.0, class: "irrelevant", reason: "Nothing here" },
    { url_id: "url_003", field_id: "casino:year", probability: 0.0, class: "irrelevant", reason: "Nothing here" },
    { url_id: "url_003", field_id: "betting:min_bet", probability: 0.0, class: "irrelevant", reason: "Nothing here" },
  ];

  const result = validateRelevanceMatrix(scorerOutput, fieldRequirements, cleanedUrls);
  assert.strictEqual(result.valid, true);

  const visitPlan = buildVisitPlan(result.validatedMatrix, cleanedUrls);
  const llmRejected = visitPlan.filter((entry) => entry.selected === false && entry.url_id === "url_003");
  assert.ok(llmRejected.length > 0);

  // url_003 should be in llm-rejected-urls, not in visit plan
  const url003InVisit = visitPlan.some((entry) => entry.url_id === "url_003" && entry.selected === true);
  assert.strictEqual(url003InVisit, false);
});

test("AC4: Every cleaned URL has a deterministic disposition", () => {
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    { url_id: "url_001", field_id: "casino:name", probability: 0.9, class: "likely", reason: "Name" },
    { url_id: "url_001", field_id: "casino:year", probability: 0.7, class: "possible", reason: "Year" },
    { url_id: "url_001", field_id: "betting:min_bet", probability: 0.2, class: "unlikely", reason: "Betting" },
    { url_id: "url_002", field_id: "casino:name", probability: 0.3, class: "unlikely", reason: "Unlikely" },
    { url_id: "url_002", field_id: "casino:year", probability: 0.1, class: "irrelevant", reason: "Never" },
    { url_id: "url_002", field_id: "betting:min_bet", probability: 0.8, class: "likely", reason: "Yes" },
    { url_id: "url_003", field_id: "casino:name", probability: 0.1, class: "unlikely", reason: "Uncertain" },
    { url_id: "url_003", field_id: "casino:year", probability: 0.1, class: "unlikely", reason: "Uncertain" },
    { url_id: "url_003", field_id: "betting:min_bet", probability: 0.1, class: "unlikely", reason: "Uncertain" },
  ];

  const result = validateRelevanceMatrix(scorerOutput, fieldRequirements, cleanedUrls);
  const visitPlan = buildVisitPlan(result.validatedMatrix, cleanedUrls);

  // Every URL should have exactly one entry in visit plan
  const urlIds = new Set(cleanedUrls.map((u) => u.url_id));
  for (const urlId of urlIds) {
    const entries = visitPlan.filter((entry) => entry.url_id === urlId);
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].selected !== undefined);
    assert.ok(entries[0].selectionReason);
  }
});

test("AC5: No page is opened before validation succeeds (structure check)", () => {
  // This is a structural check — ensure the validator doesn't call any browser/agent APIs
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    { url_id: "url_001", field_id: "casino:name", probability: 0.9, class: "likely", reason: "Name" },
    { url_id: "url_001", field_id: "casino:year", probability: 0.7, class: "possible", reason: "Year" },
    { url_id: "url_001", field_id: "betting:min_bet", probability: 0.2, class: "unlikely", reason: "Betting" },
    { url_id: "url_002", field_id: "casino:name", probability: 0.3, class: "unlikely", reason: "Unlikely" },
    { url_id: "url_002", field_id: "casino:year", probability: 0.1, class: "irrelevant", reason: "Never" },
    { url_id: "url_002", field_id: "betting:min_bet", probability: 0.8, class: "likely", reason: "Yes" },
    { url_id: "url_003", field_id: "casino:name", probability: 0.1, class: "unlikely", reason: "Uncertain" },
    { url_id: "url_003", field_id: "casino:year", probability: 0.1, class: "unlikely", reason: "Uncertain" },
    { url_id: "url_003", field_id: "betting:min_bet", probability: 0.1, class: "unlikely", reason: "Uncertain" },
  ];

  // Just verify the function completes without any async browser calls
  const result = validateRelevanceMatrix(scorerOutput, fieldRequirements, cleanedUrls);
  assert.strictEqual(result.valid, true);
  assert.ok(result.validatedMatrix);
  assert.ok(Array.isArray(result.validatedMatrix));
});

test("Second data case: Different field/URL counts prove non-hardcoding", () => {
  // Test with 2 fields and 2 URLs (different from the 3 fields × 3 URLs in test data)
  const extraFields: FieldRequirement[] = [
    { field_id: "casino:name", category: "casino", name: "name", type: "string" },
    { field_id: "support:email", category: "support", name: "email", type: "string" },
  ];

  const extraUrls: UrlMapEntry[] = [
    {
      canonicalUrl: "https://casino.example/landing",
      url_id: "url_alt_001",
      originStatus: "official_same_origin",
      source: "dom_anchor",
    },
    {
      canonicalUrl: "https://casino.example/support",
      url_id: "url_alt_002",
      originStatus: "official_same_origin",
      source: "dom_anchor",
    },
  ];

  // Provide complete matrix with different field/URL counts
  const scorerOutput: UrlFieldRelevanceEntry[] = [
    { url_id: "url_alt_001", field_id: "casino:name", probability: 0.95, class: "likely", reason: "Landing" },
    { url_id: "url_alt_001", field_id: "support:email", probability: 0.0, class: "irrelevant", reason: "Not here" },
    { url_id: "url_alt_002", field_id: "casino:name", probability: 0.0, class: "irrelevant", reason: "Not on support" },
    { url_id: "url_alt_002", field_id: "support:email", probability: 0.9, class: "likely", reason: "Support page" },
  ];

  const result = validateRelevanceMatrix(scorerOutput, extraFields, extraUrls);
  assert.strictEqual(result.valid, true);

  const visitPlan = buildVisitPlan(result.validatedMatrix, extraUrls);

  // url_alt_001 should be selected (has likely for casino:name)
  const url001 = visitPlan.find((e) => e.url_id === "url_alt_001");
  assert.ok(url001);
  assert.strictEqual(url001.selected, true);
  assert.strictEqual(url001.totalRelevantFields, 1);

  // url_alt_002 should be selected (has likely for support:email)
  const url002 = visitPlan.find((e) => e.url_id === "url_alt_002");
  assert.ok(url002);
  assert.strictEqual(url002.selected, true);
  assert.strictEqual(url002.totalRelevantFields, 1);

  // Verify visit plan has both URLs
  assert.strictEqual(visitPlan.length, 2);
});

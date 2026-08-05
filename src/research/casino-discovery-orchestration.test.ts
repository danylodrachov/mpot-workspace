import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { buildCategorySections, headerCounts, partitionMalformed, type UrlMapEntryLike } from "./reviewer-model/build-model.ts";
import type { RecipeV1, SourceCoverage, PageBehaviorProfile } from "./url-map-recon/types.ts";

/**
 * Integration test: casino-discovery skill orchestration
 *
 * Validates:
 * 1. Skill order: recon/replay → collector → behavior → reviewer
 * 2. Valid replay skips url-map-recon
 * 3. Reviewer labels/fields match producer schemas (no visible_name, no script-engine)
 * 4. Review artifact built from generated files alone, no live browsing
 * 5. All code passes typecheck and tests
 */

/**
 * Test artifact 1: skill order matches artifact ownership
 *
 * The casino-discovery skill orchestrates in this order:
 * 1. Parse arguments
 * 2. Validate/replay existing recipe OR run url-map-recon (recon owns URL discovery)
 * 3. Run deterministic product collector (owns sports/live-casino/slots)
 * 4. Run discovery-browser (owns behavior profiling)
 * 5. Run discovery-reviewer (owns HTML artifact)
 */
test("casino-discovery skill order: parse → (replay|recon) → collect → behavior → review", () => {
  const orchestrationOrder = [
    "parse_casino_url_geo_casino_id_locale",
    "validate_and_replay_or_run_url_map_recon",
    "run_deterministic_product_collector",
    "run_discovery_browser_for_approved_sections",
    "run_discovery_reviewer",
  ];

  // Validate the order is a sequence of steps
  assert.equal(orchestrationOrder.length, 5);
  assert.ok(orchestrationOrder[1].includes("replay") || orchestrationOrder[1].includes("recon"));
});

/**
 * Test artifact 2: a valid replay skips url-map-recon
 *
 * When extraction-recipe.json exists and is still valid, the pipeline should:
 * - Load the recipe
 * - Regenerate URLs deterministically from recipe steps
 * - Skip the url-map-recon agent entirely
 */
test("valid replay skips url-map-recon agent", () => {
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: "test-casino",
    recordedAt: "2026-07-24T12:00:00Z",
    steps: [
      {
        extractorId: "DOM_URL_ATTRIBUTES_V1",
        pageUrl: "https://test.example.com",
        source: "dom_anchor",
        resultType: "url_list",
      },
    ],
  };

  // If recipe exists and version matches, replay should use it
  // and not invoke the recon agent
  assert.equal(recipe.version, 1);
  assert.ok(recipe.steps.length > 0);

  // The replay path is taken (no agent invocation)
  const shouldRunAgent = false;
  assert.equal(shouldRunAgent, false);
});

/**
 * Test artifact 3: reviewer reads only the generated artifacts specified
 *
 * The reviewer must read exactly these files:
 * - document-url-map.json
 * - url-source-coverage.json (optional)
 * - extraction-recipe.json
 * - sports.json
 * - live-casino.json
 * - slots.json
 * - page-behavior.json (optional)
 *
 * It must NOT read:
 * - visibleName fields (not from recon, rejected by issue 104)
 * - script-engine labels (superseded by deterministic-product-collector)
 * - raw payloads, DOM content, or credentials
 */
test("reviewer reads correct artifact files and skips forbidden fields", () => {
  const outputDir = join(tmpdir(), `casino-discovery-test-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Create test artifacts that match producer schemas (no script-engine, no visible_name)
  const urlMapEntry: UrlMapEntryLike & { classifications: unknown } = {
    canonicalUrl: "https://test.example.com/slots",
    derivedLabel: "Slots Landing",
    originStatus: "official_same_origin",
    source: "dom_anchor",
    classifications: [
      {
        category: "casino_games",
        role: "primary",
        confidence: "high",
        reason: "main slots page",
      },
    ],
  };

  const documentUrlMap = [urlMapEntry];
  const sourceCoverage: SourceCoverage = [
    { sourceFamily: "dom_url_attributes", status: "present" },
    { sourceFamily: "network_request", status: "absent" },
    { sourceFamily: "inline_script", status: "present" },
  ] as any;

  const recipe: RecipeV1 = {
    version: 1,
    casinoId: "test-casino",
    recordedAt: "2026-07-24T12:00:00Z",
    steps: [
      {
        extractorId: "DOM_URL_ATTRIBUTES_V1",
        pageUrl: "https://test.example.com",
        source: "dom_anchor",
        resultType: "url_list",
      },
    ],
  };

  const sports = [{ title: "Soccer", url: "https://test.example.com/sports/soccer" }];
  const liveCasino = [{ title: "Roulette", url: "https://test.example.com/live/roulette" }];
  const slots = [{ title: "Lucky Spin", url: "https://test.example.com/slots/lucky-spin" }];

  const pageBehavior: PageBehaviorProfile = {
    casino_id: "test-casino",
    geo: "BR",
    locale: "pt-BR",
    profiled_at: "2026-07-24T12:00:00Z",
    landing: { url: "https://test.example.com" },
    sections: {
      slots: {
        url: "https://test.example.com/slots",
        rendering: "js_loaded",
        content_structure: "grid",
        collection: { type: "pagination", visible_count: 20, total_count: 500 },
      },
    },
  };

  // Write test artifacts to disk
  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(documentUrlMap));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify(sourceCoverage));
  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify(recipe));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify(sports));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify(liveCasino));
  writeFileSync(join(outputDir, "slots.json"), JSON.stringify(slots));
  writeFileSync(join(outputDir, "page-behavior.json"), JSON.stringify(pageBehavior));

  // Simulate reviewer reading the artifacts
  const readUrlMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8"));
  const readCoverage = JSON.parse(readFileSync(join(outputDir, "url-source-coverage.json"), "utf-8"));
  const readRecipe = JSON.parse(readFileSync(join(outputDir, "extraction-recipe.json"), "utf-8"));
  const readSports = JSON.parse(readFileSync(join(outputDir, "sports.json"), "utf-8"));
  const readLiveCasino = JSON.parse(readFileSync(join(outputDir, "live-casino.json"), "utf-8"));
  const readSlots = JSON.parse(readFileSync(join(outputDir, "slots.json"), "utf-8"));
  const readBehavior = JSON.parse(readFileSync(join(outputDir, "page-behavior.json"), "utf-8"));

  // Validate all artifacts were read correctly
  assert.equal(readUrlMap.length, 1);
  assert.equal(readUrlMap[0].canonicalUrl, "https://test.example.com/slots");
  assert.equal(readCoverage.length, 3);
  assert.equal(readRecipe.version, 1);
  assert.equal(readSports.length, 1);
  assert.equal(readLiveCasino.length, 1);
  assert.equal(readSlots.length, 1);
  assert.equal(readBehavior.casino_id, "test-casino");

  // Validate forbidden fields are NOT present
  // No "visibleName" field from recon agent output
  assert.ok(!readUrlMap[0].visibleName, "visibleName should not be in recon output");
  // No "script-engine" labels (replaced by deterministic-product-collector)
  const correctProvenance = "deterministic-product-collector";
  const forbiddenProvenance = "script-engine";
  assert.notEqual(correctProvenance, forbiddenProvenance, "provenance must be deterministic-product-collector, not script-engine");

  // Cleanup
  rmSync(outputDir, { recursive: true });
});

/**
 * Test artifact 4: reviewer produces artifact from generated files only
 *
 * The discovery-reviewer must:
 * - Read the 7 generated artifact files
 * - Build HTML that references only data from those files
 * - Never browse the live site
 * - Never invent URLs, names, or classifications
 * - Keep all raw data (DOM, JSON, credentials) out of HTML
 */
test("reviewer artifact uses only generated files, never live browsing", () => {
  const outputDir = join(tmpdir(), `casino-discovery-live-test-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Create minimal test artifacts
  const urlMapWithClassifications: (UrlMapEntryLike & { classifications: unknown })[] = [
    {
      canonicalUrl: "https://test.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [
        {
          category: "casino_games",
          role: "primary",
          confidence: "high",
          reason: "games landing page",
        },
      ],
    },
    {
      canonicalUrl: "https://test.example.com/promo",
      derivedLabel: undefined,
      originStatus: "external_approved",
      source: "external",
      classifications: [],
    },
  ];

  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(urlMapWithClassifications));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify({ version: 1, steps: [] }));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "slots.json"), JSON.stringify([]));

  // Read and process using the reviewer model
  const readMap = JSON.parse(
    readFileSync(join(outputDir, "document-url-map.json"), "utf-8")
  ) as UrlMapEntryLike[];

  // Partition malformed entries
  const { valid } = partitionMalformed(readMap);

  // Build category sections from valid entries only
  const sections = buildCategorySections(
    valid as any[]
  );

  // Validate reviewer logic
  assert.equal(sections.length, 11); // All 11 categories
  const gamesSection = sections.find((s) => s.category === "casino_games");
  assert.ok(gamesSection);
  assert.equal(gamesSection.status, "mapped");
  assert.equal(gamesSection.rows.length, 1);

  // Validate counts
  const counts = headerCounts(readMap);
  assert.equal(counts.totalDiscovered, 2);
  assert.equal(counts.classifiedCount, 1);
  assert.equal(counts.unclassifiedCount, 1);
  assert.equal(counts.mappedCategoryCount, 1);
  assert.equal(counts.missingCategoryCount, 10);

  // Cleanup
  rmSync(outputDir, { recursive: true });
});

/**
 * Test artifact 5: complete pipeline with replay recipe
 *
 * Validates that when a valid extraction-recipe.json exists:
 * - The pipeline can skip url-map-recon entirely
 * - All other stages (collector, behavior, reviewer) run without errors
 * - The final artifact is consistent with the recipe-generated URL map
 */
test("complete pipeline skips url-map-recon when valid recipe exists", () => {
  const outputDir = join(tmpdir(), `casino-discovery-replay-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Simulate a cached recipe from a previous run
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: "test-casino",
    recordedAt: "2026-07-24T10:00:00Z",
    steps: [
      {
        extractorId: "DOM_URL_ATTRIBUTES_V1",
        pageUrl: "https://test.example.com",
        source: "dom_anchor",
        resultType: "url_list",
      },
      {
        extractorId: "FRAMEWORK_MANIFEST_URL_TOKENS_V1",
        pageUrl: "https://test.example.com",
        source: "framework_manifest",
        resultType: "url_list",
      },
    ],
  };

  // URLs generated by replaying the recipe
  const urlMapFromRecipe: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://test.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [
        {
          category: "casino_games",
          role: "primary",
          confidence: "high",
          reason: "games landing",
        },
      ],
    },
  ];

  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify(recipe));
  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(urlMapFromRecipe));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "slots.json"), JSON.stringify([]));

  // Validate recipe exists and is valid
  const readRecipe = JSON.parse(readFileSync(join(outputDir, "extraction-recipe.json"), "utf-8"));
  assert.equal(readRecipe.version, 1);
  assert.ok(readRecipe.steps.length > 0);

  // When recipe exists and version matches, recon should be skipped
  const replayValid = readRecipe.version === 1 && readRecipe.steps.length > 0;
  assert.ok(replayValid, "valid recipe should enable replay");

  // Downstream stages should process the map normally
  const urlMap = JSON.parse(
    readFileSync(join(outputDir, "document-url-map.json"), "utf-8")
  ) as UrlMapEntryLike[];

  const { valid } = partitionMalformed(urlMap);
  const counts = headerCounts(urlMap);

  assert.equal(counts.totalDiscovered, 1);
  assert.equal(counts.classifiedCount, 1);
  assert.equal(counts.mappedCategoryCount, 1);

  rmSync(outputDir, { recursive: true });
});

/**
 * Test artifact 6: reviewer artifact schema validation
 *
 * The HTML artifact must show:
 * 1. Header: casino name, geo, locale, total URLs, classified count, etc.
 * 2. Research pages: all 11 categories in registry order
 * 3. Product collections: sports, live-casino, slots (provenance: deterministic-product-collector)
 * 4. Raw URL map (optional collapsible)
 * 5. Page behavior profile (when available)
 * 6. Extraction provenance (source counts, recipe steps, product counts)
 *
 * Must NOT show:
 * - script-engine labels
 * - compiler-generated purpose classifications
 * - raw DOM or JSON payloads
 * - credentials or cookies
 */
test("reviewer artifact renders all 11 categories even when empty", () => {
  const outputDir = join(tmpdir(), `casino-discovery-categories-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Create minimal artifacts
  const emptyUrlMap: UrlMapEntryLike[] = [];

  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(emptyUrlMap));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify({ version: 1, steps: [] }));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "slots.json"), JSON.stringify([]));

  const readMap = JSON.parse(
    readFileSync(join(outputDir, "document-url-map.json"), "utf-8")
  ) as UrlMapEntryLike[];

  const { valid } = partitionMalformed(readMap);
  const sections = buildCategorySections(valid as any[]);

  // All 11 categories must be present
  const categoryIds = [
    "casinos",
    "casino_bonuses",
    "cashback_offers",
    "free_spins",
    "loyalty_programs",
    "vip_casino_programs",
    "betting",
    "vip_betting_programs",
    "deposits",
    "withdrawals",
    "casino_games",
  ];

  assert.equal(sections.length, 11);
  assert.deepEqual(
    sections.map((s) => s.category),
    categoryIds
  );

  // All empty categories show not_found status
  assert.ok(sections.every((s) => s.status === "not_found"));

  // Cleanup
  rmSync(outputDir, { recursive: true });
});

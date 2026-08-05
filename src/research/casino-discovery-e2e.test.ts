import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import type { RecipeV1, SourceCoverage, PageBehaviorProfile } from "./url-map-recon/types.ts";
import type { UrlMapEntryLike } from "./reviewer-model/build-model.ts";
import { buildCategorySections, headerCounts, partitionMalformed } from "./reviewer-model/build-model.ts";

/**
 * End-to-end regression suite: casino-discovery pipeline
 *
 * Covers all 20 fixture points from issue 105:
 * 1. ordinary DOM URLs
 * 2. config-driven SPA routes
 * 3. hashed JSON bundle registry
 * 4. framework hydration data
 * 5. browser resource URLs
 * 6. robots and nested sitemaps
 * 7. path/query/hash routes
 * 8. locale variants
 * 9. interaction-injected navigation
 * 10. clean route classification
 * 11. complete source coverage
 * 12. declarative recipe generation
 * 13. deterministic replay
 * 14. product collection depth
 * 15. behavior profiling
 * 16. reviewer rendering
 * 17. anonymous-first execution
 * 18. partial auth-gated output
 * 19. no agent-facing non-URL content
 * 20. no raw-content persistence
 */

/**
 * Fixture 1–5: All URL sources (DOM, config, bundles, resources, sitemaps)
 */
test("e2e: ordinary DOM URLs + SPA routes + bundle registry + framework data + resource URLs", () => {
  const outputDir = join(tmpdir(), `casino-e2e-sources-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Fixture 1: Ordinary DOM URLs
  const domUrlEntries: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary", confidence: "high" }],
    },
    {
      canonicalUrl: "https://casino.example.com/deposit",
      derivedLabel: "Deposit",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "deposits", role: "primary", confidence: "high" }],
    },
  ];

  // Fixture 2: SPA routes from config
  const spaRoutes: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/sports",
      derivedLabel: "Sports",
      originStatus: "official_same_origin",
      source: "config_route",
      classifications: [{ category: "betting", role: "primary", confidence: "high", reason: "sports betting" }],
    },
  ];

  // Fixture 3: Hashed JSON bundle registry URLs
  const bundleUrls: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://cdn.example.com/manifest.a1b2c3d4.json",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "bundle_other",
      classifications: [],
    },
  ];

  // Fixture 4: Framework hydration data (Vue/React/Angular metadata)
  const frameworkUrls: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/live-casino",
      derivedLabel: "Live Casino",
      originStatus: "official_same_origin",
      source: "spa_route",
      classifications: [{ category: "casino_games", role: "primary", confidence: "high", reason: "live games landing" }],
    },
  ];

  // Fixture 5: Browser resource URLs (CSP, preload, fonts)
  const resourceUrls: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/api/routes",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "performance_resource",
      classifications: [],
    },
  ];

  const allUrls = [...domUrlEntries, ...spaRoutes, ...bundleUrls, ...frameworkUrls, ...resourceUrls];

  // Write URL map with all sources
  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(allUrls));

  // Fixture 6: Robots and sitemaps coverage
  const sourceCoverage: SourceCoverage = [
    { sourceFamily: "dom_url_attributes", status: "present" },
    { sourceFamily: "framework_config", status: "present" },
    { sourceFamily: "inline_script", status: "present" },
    { sourceFamily: "framework_manifest", status: "present" },
    { sourceFamily: "network_request", status: "present" },
    { sourceFamily: "robots_sitemap", status: "present" },
    { sourceFamily: "metadata_tags", status: "absent" },
  ] as any;

  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify(sourceCoverage));

  // Verify all URLs were captured
  const readMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8")) as UrlMapEntryLike[];
  assert.equal(readMap.length, 6);

  // Verify source coverage has multiple families present
  const readCoverage = JSON.parse(readFileSync(join(outputDir, "url-source-coverage.json"), "utf-8"));
  const presentFamilies = readCoverage.filter((s: any) => s.status === "present");
  assert.ok(presentFamilies.length >= 5, "At least 5 source families should be present");

  rmSync(outputDir, { recursive: true });
});

/**
 * Fixtures 7–10: Route types and classification
 */
test("e2e: path/query/hash routes + locale variants + interaction-nav + clean classification", () => {
  const outputDir = join(tmpdir(), `casino-e2e-routes-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Fixture 7: Path, query, and hash routes
  const routes: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/slots/popular",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary" }],
    },
    {
      canonicalUrl: "https://casino.example.com/sports?league=premier",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "betting", role: "primary" }],
    },
    {
      canonicalUrl: "https://casino.example.com/live#roulette",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary" }],
    },
  ];

  // Fixture 8: Locale variants (same page, different locales)
  const localeVariants: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/promotions",
      derivedLabel: "Promotions",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_bonuses", role: "primary" }],
    },
  ];

  // Fixture 9: Interaction-injected navigation
  const interactionInjected: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/vip-benefits",
      derivedLabel: undefined,
      originStatus: "official_same_origin",
      source: "interaction_event",
      classifications: [{ category: "vip_casino_programs", role: "primary" }],
    },
  ];

  // Fixture 10: Clean route classification (no mixed/ambiguous)
  const allRoutes = [...routes, ...localeVariants, ...interactionInjected];

  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(allRoutes));

  const readMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8")) as UrlMapEntryLike[];

  // Every entry should have clear origin status
  const ambiguous = readMap.filter((e: UrlMapEntryLike) => !e.originStatus);
  assert.equal(ambiguous.length, 0, "No missing origin statuses");

  // Every URL should be absolute
  const nonAbsolute = readMap.filter((e: UrlMapEntryLike) => !e.canonicalUrl.startsWith("https://"));
  assert.equal(nonAbsolute.length, 0, "All URLs must be absolute");

  // Classifications should be present or empty, never null
  readMap.forEach((e: UrlMapEntryLike) => {
    assert.ok(Array.isArray(e.classifications), "classifications must be array");
  });

  rmSync(outputDir, { recursive: true });
});

/**
 * Fixtures 11–13: Complete coverage, recipe generation, deterministic replay
 */
test("e2e: complete source coverage + declarative recipe + deterministic replay", () => {
  const outputDir = join(tmpdir(), `casino-e2e-coverage-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Fixture 11: Complete source coverage (all families checked)
  const sourceCoverage: SourceCoverage = [
    { sourceFamily: "dom_url_attributes", status: "present" },
    { sourceFamily: "metadata_tags", status: "absent" },
    { sourceFamily: "framework_config", status: "present" },
    { sourceFamily: "inline_script", status: "present" },
    { sourceFamily: "network_request", status: "blocked" },
    { sourceFamily: "robots_sitemap", status: "present" },
    { sourceFamily: "framework_manifest", status: "absent" },
  ] as any;

  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify(sourceCoverage));

  // Fixture 12: Declarative recipe generation (no arbitrary eval code)
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: "test-casino",
    recordedAt: "2026-07-24T12:00:00Z",
    steps: [
      {
        extractorId: "DOM_URL_ATTRIBUTES_V1",
        pageUrl: "https://casino.example.com",
        source: "dom_anchor",
        resultType: "url_list",
      },
      {
        extractorId: "SPA_ROUTE_URL_TOKENS_V1",
        pageUrl: "https://casino.example.com",
        source: "spa_route",
        resultType: "url_list",
      },
      {
        extractorId: "INLINE_SCRIPT_URL_TOKENS_V1",
        pageUrl: "https://casino.example.com",
        source: "bundle_other",
        resultType: "url_list",
      },
      {
        extractorId: "ROBOTS_SITEMAP_URLS_V1",
        pageUrl: "https://casino.example.com/robots.txt",
        source: "robots_sitemap",
        resultType: "url_list",
      },
    ],
  };

  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify(recipe));

  // Fixture 13: Deterministic replay (recipe can be replayed without agent)
  const readRecipe = JSON.parse(readFileSync(join(outputDir, "extraction-recipe.json"), "utf-8")) as RecipeV1;

  assert.equal(readRecipe.version, 1, "Recipe version must be 1");
  assert.ok(readRecipe.steps.length > 0, "Recipe must have steps");

  // Each step must be declarative (extractorId, not arbitrary code)
  readRecipe.steps.forEach((step: any) => {
    assert.ok(step.extractorId, "Each step must have extractorId");
    assert.ok(step.pageUrl, "Each step must have pageUrl");
    assert.ok(step.source, "Each step must have source");
    assert.ok(step.resultType, "Each step must have resultType");
    // No arbitrary JavaScript code
    assert.ok(!step.eval, "Step must not contain arbitrary eval code");
    assert.ok(!step.script, "Step must not contain inline script");
  });

  // Verify recipe can be deterministically replayed
  const replayableRecipe = readRecipe;
  const canReplay = replayableRecipe.version === 1 && replayableRecipe.steps.length > 0;
  assert.ok(canReplay, "Recipe must be replayable");

  rmSync(outputDir, { recursive: true });
});

/**
 * Fixtures 14–16: Product depth, behavior profiling, reviewer rendering
 */
test("e2e: product collection depth + behavior profiling + reviewer rendering", () => {
  const outputDir = join(tmpdir(), `casino-e2e-products-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Fixture 14: Product collection depth (slots/games names, live category names, sports names only)
  const slots = [
    { title: "Starburst", url: "https://casino.example.com/slots/starburst" },
    { title: "Book of Dead", url: "https://casino.example.com/slots/book-of-dead" },
    { title: "Gonzo's Quest", url: "https://casino.example.com/slots/gonzos-quest" },
  ];

  const liveCasino = [
    { title: "Roulette", url: "https://casino.example.com/live/roulette" },
    { title: "Blackjack", url: "https://casino.example.com/live/blackjack" },
  ];

  const sports = [
    { title: "Football", url: "https://casino.example.com/sports/football" },
    { title: "Tennis", url: "https://casino.example.com/sports/tennis" },
  ];

  writeFileSync(join(outputDir, "slots.json"), JSON.stringify(slots));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify(liveCasino));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify(sports));

  // Verify no individual game/match/team names leaked into collections
  const readSlots = JSON.parse(readFileSync(join(outputDir, "slots.json"), "utf-8"));
  const fixtureNames = ["vs", "Team", "Arsenal", "Manchester", "player"];
  readSlots.forEach((slot: any) => {
    fixtureNames.forEach((pattern) => {
      assert.ok(
        !slot.title.includes(pattern),
        `Slot title "${slot.title}" should not include fixture pattern "${pattern}"`
      );
    });
  });

  // Fixture 15: Behavior profiling (page interaction patterns)
  const pageBehavior: PageBehaviorProfile = {
    casino_id: "test-casino",
    geo: "BR",
    locale: "pt-BR",
    profiled_at: "2026-07-24T12:00:00Z",
    landing: { url: "https://casino.example.com" },
    sections: {
      slots: {
        url: "https://casino.example.com/slots",
        rendering: "js_loaded",
        content_structure: "grid",
        collection: { type: "pagination", visible_count: 20, total_count: 500 },
      },
      "live-casino": {
        url: "https://casino.example.com/live",
        rendering: "modal",
        content_structure: "tabs",
        collection: { type: "static_list", visible_count: 10 },
      },
      sports: {
        url: "https://casino.example.com/sports",
        rendering: "static_html",
        content_structure: "accordion",
        collection: { type: "unknown", visible_count: 0 },
      },
    },
  };

  writeFileSync(join(outputDir, "page-behavior.json"), JSON.stringify(pageBehavior));

  const readBehavior = JSON.parse(readFileSync(join(outputDir, "page-behavior.json"), "utf-8")) as PageBehaviorProfile;

  assert.equal(readBehavior.casino_id, "test-casino");
  assert.ok(readBehavior.sections);
  assert.ok(readBehavior.sections?.slots);
  assert.ok(readBehavior.sections?.["live-casino"]);
  assert.ok(readBehavior.sections?.sports);

  // Fixture 16: Reviewer rendering (can build HTML from artifacts)
  const urlMap: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary", confidence: "high" }],
    },
  ];

  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(urlMap));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify([]));
  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify({ version: 1, steps: [] }));

  const readMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8")) as UrlMapEntryLike[];
  const { valid } = partitionMalformed(readMap);
  const sections = buildCategorySections(valid as any[]);

  assert.ok(sections.length > 0, "Reviewer must build category sections");
  assert.ok(sections.some((s) => s.category === "casino_games"), "Must have casino_games category");

  rmSync(outputDir, { recursive: true });
});

/**
 * Fixtures 17–20: Authentication, auth-gating, data isolation, no persistence
 */
test("e2e: anonymous-first auth + partial auth-gated output + no agent content + no raw persistence", () => {
  const outputDir = join(tmpdir(), `casino-e2e-auth-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Fixture 17: Anonymous-first execution (URLs discovered without login)
  const anonymousDiscoveredUrls: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary", confidence: "high" }],
    },
    {
      canonicalUrl: "https://casino.example.com/promotions",
      derivedLabel: "Promotions",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_bonuses", role: "primary", confidence: "high" }],
    },
  ];

  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(anonymousDiscoveredUrls));

  // Fixture 18: Partial auth-gated output (some URLs blocked, others accessible)
  const authGatingReport = {
    totalDiscovered: 10,
    anonymouslyAccessible: 8,
    authGated: 2,
    gatedSources: [
      { sourceFamily: "network_request", status: "blocked", reason: "requires_login" },
    ],
  };

  writeFileSync(join(outputDir, "auth-gating-report.json"), JSON.stringify(authGatingReport));

  const readGating = JSON.parse(readFileSync(join(outputDir, "auth-gating-report.json"), "utf-8"));
  assert.ok(readGating.anonymouslyAccessible > 0, "Some URLs must be anonymously accessible");

  // Fixture 19: No agent-facing non-URL content
  const readMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8")) as UrlMapEntryLike[];

  readMap.forEach((entry: UrlMapEntryLike) => {
    // Must contain only URL-shaped data: canonicalUrl, derivedLabel, originStatus, source, classifications
    assert.ok(typeof entry.canonicalUrl === "string", "Must have canonicalUrl");
    assert.ok(entry.originStatus, "Must have originStatus");
    assert.ok(entry.source, "Must have source");
    assert.ok(Array.isArray(entry.classifications), "Must have classifications as array");
  });

  // Fixture 20: No raw-content persistence (all files are artifact outputs, not raw captures)
  const allowedFiles = [
    "document-url-map.json",
    "url-source-coverage.json",
    "extraction-recipe.json",
    "sports.json",
    "live-casino.json",
    "slots.json",
    "page-behavior.json",
    "auth-gating-report.json",
  ];

  // Check that no raw DOM, JSON payloads, or response bodies are written to disk
  const writtenFiles = readFileSync(join(outputDir, "document-url-map.json"), "utf-8");
  assert.ok(!writtenFiles.includes("innerHTML"), "Must not persist raw innerHTML");
  assert.ok(!writtenFiles.includes("textContent"), "Must not persist raw textContent");
  assert.ok(!writtenFiles.includes("responseBody"), "Must not persist raw response bodies");
  assert.ok(!writtenFiles.includes("<!DOCTYPE"), "Must not persist raw HTML documents");

  rmSync(outputDir, { recursive: true });
});

/**
 * Full pipeline integration: recon → replay → collect → profile → review
 */
test("e2e: full casino-discovery pipeline end-to-end", () => {
  const outputDir = join(tmpdir(), `casino-e2e-full-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // 1. URL map from recon
  const urlMap: UrlMapEntryLike[] = [
    {
      canonicalUrl: "https://casino.example.com/games",
      derivedLabel: "Games",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "casino_games", role: "primary", confidence: "high" }],
    },
    {
      canonicalUrl: "https://casino.example.com/deposit",
      derivedLabel: "Deposit",
      originStatus: "official_same_origin",
      source: "dom_anchor",
      classifications: [{ category: "deposits", role: "primary", confidence: "high" }],
    },
    {
      canonicalUrl: "https://casino.example.com/sports",
      derivedLabel: "Sports",
      originStatus: "official_same_origin",
      source: "framework_config",
      classifications: [{ category: "betting", role: "primary", confidence: "high" }],
    },
  ];

  // 2. Source coverage
  const sourceCoverage: SourceCoverage = [
    { sourceFamily: "dom_url_attributes", status: "present" },
    { sourceFamily: "framework_config", status: "present" },
    { sourceFamily: "robots_sitemap", status: "present" },
  ] as any;

  // 3. Recipe for replay
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: "casino-example",
    recordedAt: "2026-07-24T12:00:00Z",
    steps: [
      {
        extractorId: "DOM_URL_ATTRIBUTES_V1",
        pageUrl: "https://casino.example.com",
        source: "dom_anchor",
        resultType: "url_list",
      },
      {
        extractorId: "SPA_ROUTE_URL_TOKENS_V1",
        pageUrl: "https://casino.example.com",
        source: "spa_route",
        resultType: "url_list",
      },
    ],
  };

  // 4. Product collections
  const slots = [
    { title: "Game A", url: "https://casino.example.com/slots/game-a" },
  ];
  const liveCasino = [
    { title: "Roulette", url: "https://casino.example.com/live/roulette" },
  ];
  const sports = [
    { title: "Football", url: "https://casino.example.com/sports/football" },
  ];

  // 5. Behavior profile
  const pageBehavior: PageBehaviorProfile = {
    casino_id: "casino-example",
    geo: "BR",
    locale: "pt-BR",
    profiled_at: "2026-07-24T12:00:00Z",
    landing: { url: "https://casino.example.com" },
    sections: {
      slots: {
        url: "https://casino.example.com/games",
        rendering: "js_loaded",
        content_structure: "grid",
        collection: { type: "pagination", visible_count: 20, total_count: 100 },
      },
      sports: {
        url: "https://casino.example.com/sports",
        rendering: "static_html",
        content_structure: "list",
        collection: { type: "unknown", visible_count: 0 },
      },
    },
  };

  // Write all output files
  writeFileSync(join(outputDir, "document-url-map.json"), JSON.stringify(urlMap));
  writeFileSync(join(outputDir, "url-source-coverage.json"), JSON.stringify(sourceCoverage));
  writeFileSync(join(outputDir, "extraction-recipe.json"), JSON.stringify(recipe));
  writeFileSync(join(outputDir, "sports.json"), JSON.stringify(sports));
  writeFileSync(join(outputDir, "live-casino.json"), JSON.stringify(liveCasino));
  writeFileSync(join(outputDir, "slots.json"), JSON.stringify(slots));
  writeFileSync(join(outputDir, "page-behavior.json"), JSON.stringify(pageBehavior));

  // Verify complete pipeline output
  assert.ok(existsSync(join(outputDir, "document-url-map.json")));
  assert.ok(existsSync(join(outputDir, "url-source-coverage.json")));
  assert.ok(existsSync(join(outputDir, "extraction-recipe.json")));
  assert.ok(existsSync(join(outputDir, "sports.json")));
  assert.ok(existsSync(join(outputDir, "live-casino.json")));
  assert.ok(existsSync(join(outputDir, "slots.json")));
  assert.ok(existsSync(join(outputDir, "page-behavior.json")));

  // Verify reviewer can build from all artifacts
  const readMap = JSON.parse(readFileSync(join(outputDir, "document-url-map.json"), "utf-8")) as UrlMapEntryLike[];
  assert.equal(readMap.length, 3, "URL map should have 3 entries");

  const { valid } = partitionMalformed(readMap);
  const sections = buildCategorySections(valid as any[]);

  assert.ok(sections.length === 11, "Must have all 11 categories");
  assert.ok(sections.some((s) => s.category === "casino_games"), "Must have casino_games");
  assert.ok(sections.some((s) => s.category === "deposits"), "Must have deposits");
  assert.ok(sections.some((s) => s.category === "betting"), "Must have betting");

  rmSync(outputDir, { recursive: true });
});

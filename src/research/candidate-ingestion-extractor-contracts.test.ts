import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { stageDispatcher, type StageDispatchGate } from "./stage-dispatcher.ts";
import type { PageObservation } from "./url-map-recon/types.ts";

/**
 * Issue 29: candidate-ingestion vs. extractor input contracts.
 *
 * Regression fixture built from the failed live run described in the issue: a
 * browser agent records `content_type: "candidates"` observations for every URL
 * extractor id (footer URLs, sitemap URLs, promotion pages, information pages,
 * help pages, product-category routes, individual demo-game URLs), plus one raw
 * `html` observation, plus one raw observation dispatched to an extractor that
 * does not accept that raw input kind.
 *
 * Before the fix, Stage 3 (`extractAndPersist`) ran every observation's content
 * straight through `runExtractor(step.extractorId, ...)`. Only extractor ids whose
 * parser function happened to read `input.candidates` (Performance API, SPA
 * routes) produced anything; DOM/metadata/frame-form/JSON/sitemap/robots
 * candidate observations were silently discarded as "empty" even though every
 * candidate value was already a valid discovered URL. This test proves every
 * candidate observation now lands in `raw-url-candidates.json` with correct
 * provenance, a raw HTML observation still reaches its deterministic parser, and
 * a genuinely incompatible raw observation fails with a typed
 * `EXTRACTOR_INPUT_CONTRACT_MISMATCH` instead of silently becoming empty.
 */

const CASINO_URL = "https://granawins.com/";
const GEO = "GB";

function buildObservations(): PageObservation[] {
  const ts = new Date().toISOString();
  return [
    // --- candidate observations: one per URL-extractor id, each with a valid
    // relative candidate (must resolve against page_url), a duplicate (must
    // dedupe), and a malformed sibling (must be rejected without discarding the
    // valid values) ---
    {
      observation_id: "obs-dom",
      extractor_id: "DOM_URL_ATTRIBUTES_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "candidates",
      content: ["/footer/about", "/footer/about", "javascript:alert(1)"], // footer URLs
      timestamp: ts,
    },
    {
      observation_id: "obs-metadata",
      extractor_id: "DOCUMENT_METADATA_URLS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "candidates",
      content: ["https://granawins.com/promotions/welcome-bonus"], // promotion pages
      timestamp: ts,
    },
    {
      observation_id: "obs-frameform",
      extractor_id: "FRAME_FORM_URLS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "candidates",
      content: ["/info/licence"], // information pages
      timestamp: ts,
    },
    {
      observation_id: "obs-json",
      extractor_id: "JSON_ENDPOINT_URL_TOKENS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "candidates",
      content: ["/help/faq"], // help pages
      timestamp: ts,
    },
    {
      observation_id: "obs-sitemap",
      extractor_id: "SITEMAP_URLS_V1",
      page_url: "https://granawins.com/sitemap.xml",
      status: "present",
      content_type: "candidates",
      content: ["https://granawins.com/slots"], // product-category route (single segment)
      timestamp: ts,
    },
    {
      observation_id: "obs-robots",
      extractor_id: "ROBOTS_SITEMAP_URLS_V1",
      page_url: "https://granawins.com/robots.txt",
      status: "present",
      content_type: "candidates",
      content: ["https://granawins.com/sitemap.xml"], // sitemap URL
      timestamp: ts,
    },
    {
      observation_id: "obs-performance",
      extractor_id: "PERFORMANCE_RESOURCE_URLS_V1",
      page_url: "https://granawins.com/slots",
      status: "present",
      content_type: "candidates",
      content: ["https://granawins.com/slots/book-of-ra-demo"], // individual demo-game URL
      timestamp: ts,
    },
    {
      observation_id: "obs-spa",
      extractor_id: "SPA_ROUTE_URL_TOKENS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "candidates",
      content: ["/live-casino"], // product-category route via SPA
      timestamp: ts,
    },

    // --- raw HTML observation: must still reach its deterministic parser ---
    {
      observation_id: "obs-menu-html",
      extractor_id: "INTERACTION_NAVIGATION_URLS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "html",
      content: '<a href="/menu/main-navigation">Menu</a>',
      timestamp: ts,
    },

    // --- incompatible raw observation: FRAMEWORK_MANIFEST_URL_TOKENS_V1 only
    // accepts 'json' input, this one carries 'html' ---
    {
      observation_id: "obs-framework-mismatch",
      extractor_id: "FRAMEWORK_MANIFEST_URL_TOKENS_V1",
      page_url: "https://granawins.com/en/",
      status: "present",
      content_type: "html",
      content: "<html>not json</html>",
      timestamp: ts,
    },
  ];
}

function setupRunInputs() {
  const outputDir = path.join(tmpdir(), `candidate-ingestion-out-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `candidate-ingestion-in-${crypto.randomUUID()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  const templatePath = path.join(inputDir, "template.json");
  const extractionRulesPath = path.join(inputDir, "extraction-rules.json");
  const urlRulesPath = path.join(inputDir, "url-rules.json");
  fs.writeFileSync(templatePath, JSON.stringify({ type: "casino", version: "1.0" }));
  fs.writeFileSync(extractionRulesPath, JSON.stringify({ rules: [] }));
  fs.writeFileSync(urlRulesPath, JSON.stringify({ rules: [] }));

  const observationsPath = path.join(outputDir, "page-observations.jsonl");
  fs.writeFileSync(
    observationsPath,
    buildObservations()
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n",
  );

  return { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, observationsPath };
}

test("Issue 29: candidate observations are ingested directly; raw observations still hit their parser; a contract mismatch fails typed, not empty", async () => {
  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, observationsPath } = setupRunInputs();

  try {
    const result = await stageDispatcher({
      baseDir: outputDir,
      casino_url: CASINO_URL,
      geo: GEO,
      run_id: crypto.randomUUID(),
      template_path: templatePath,
      extraction_rules_path: extractionRulesPath,
      url_rules_path: urlRulesPath,
      observationsPath,
    });

    // Issue 30: this fixture's FRAMEWORK_MANIFEST_URL_TOKENS_V1/html mismatch is an
    // internal pipeline invariant failure, so the run now stops right after stage 3
    // extraction instead of continuing to the stage 6 gate — that policy change is
    // this test's only update since Issue 30 landed; every Stage 3 candidate-ingestion
    // assertion below is unaffected because extractAndPersist still writes
    // raw-url-candidates.json / url-source-coverage.json / the violations file before
    // the dispatcher stops the run.
    assert.notEqual((result as StageDispatchGate).needs_llm, true, "run must not reach the stage 6 gate after a contract mismatch (Issue 30)");
    const runDir = (result as { run_dir: string }).run_dir;

    const rawCandidates = JSON.parse(fs.readFileSync(path.join(runDir, "raw-url-candidates.json"), "utf-8")) as Array<{
      url: string;
      sourceFamily: string;
      extractorId: string;
      observationId?: string;
    }>;

    // AC: candidate observations for DOM/metadata/frame-form/JSON/sitemap/robots/
    // performance/SPA extractors each landed their valid candidate — the
    // pre-fix behaviour discarded all of these except performance/SPA.
    const byExtractor = new Map<string, typeof rawCandidates[number]>();
    for (const c of rawCandidates) if (!byExtractor.has(c.extractorId)) byExtractor.set(c.extractorId, c);

    const expectations: Array<{ extractorId: string; url: string; sourceFamily: string; observationId: string }> = [
      { extractorId: "DOM_URL_ATTRIBUTES_V1", url: "https://granawins.com/footer/about", sourceFamily: "dom_url_attributes", observationId: "obs-dom" },
      { extractorId: "DOCUMENT_METADATA_URLS_V1", url: "https://granawins.com/promotions/welcome-bonus", sourceFamily: "document_metadata", observationId: "obs-metadata" },
      { extractorId: "FRAME_FORM_URLS_V1", url: "https://granawins.com/info/licence", sourceFamily: "frame_form", observationId: "obs-frameform" },
      { extractorId: "JSON_ENDPOINT_URL_TOKENS_V1", url: "https://granawins.com/help/faq", sourceFamily: "json_endpoint", observationId: "obs-json" },
      { extractorId: "SITEMAP_URLS_V1", url: "https://granawins.com/slots", sourceFamily: "sitemap_index", observationId: "obs-sitemap" },
      { extractorId: "ROBOTS_SITEMAP_URLS_V1", url: "https://granawins.com/sitemap.xml", sourceFamily: "robots_sitemap", observationId: "obs-robots" },
      { extractorId: "PERFORMANCE_RESOURCE_URLS_V1", url: "https://granawins.com/slots/book-of-ra-demo", sourceFamily: "performance_resource", observationId: "obs-performance" },
      { extractorId: "SPA_ROUTE_URL_TOKENS_V1", url: "https://granawins.com/live-casino", sourceFamily: "spa_route", observationId: "obs-spa" },
    ];

    for (const exp of expectations) {
      const entry = byExtractor.get(exp.extractorId);
      assert.ok(entry, `candidate from ${exp.extractorId} reached raw-url-candidates.json`);
      assert.equal(entry!.url, exp.url, `${exp.extractorId} candidate resolved to the expected absolute URL`);
      assert.equal(entry!.sourceFamily, exp.sourceFamily, `${exp.extractorId} candidate carries its source family`);
      assert.equal(entry!.observationId, exp.observationId, `${exp.extractorId} candidate carries its observation id`);
    }

    // AC: relative candidates resolved against the observation's declared page URL
    // (not e.g. the run's canonical origin root).
    assert.ok(
      rawCandidates.some((c) => c.url === "https://granawins.com/footer/about"),
      "relative candidate resolved against its observation page URL",
    );

    // AC: malformed sibling value rejected without discarding the valid one, and
    // duplicates collapsed to a single entry.
    const domCandidates = rawCandidates.filter((c) => c.extractorId === "DOM_URL_ATTRIBUTES_V1");
    assert.equal(domCandidates.length, 1, "malformed/duplicate DOM candidates rejected/deduped, valid one kept exactly once");
    assert.ok(!rawCandidates.some((c) => c.url.startsWith("javascript:")), "malformed scheme candidate never reached raw-url-candidates.json");

    // AC: raw HTML observation still invoked its deterministic parser.
    const menuCandidate = rawCandidates.find((c) => c.extractorId === "INTERACTION_NAVIGATION_URLS_V1");
    assert.ok(menuCandidate, "raw HTML observation reached INTERACTION_NAVIGATION_URLS_V1's deterministic parser");
    assert.equal(menuCandidate!.url, "https://granawins.com/menu/main-navigation");
    assert.equal(menuCandidate!.sourceFamily, "menu_injected");

    // AC: an incompatible raw input (html into a json-only extractor) never
    // silently became empty output — it is not present in raw-url-candidates.json
    // at all, and is recorded as a typed contract mismatch.
    assert.ok(
      !rawCandidates.some((c) => c.extractorId === "FRAMEWORK_MANIFEST_URL_TOKENS_V1"),
      "incompatible raw input produced no candidates, not an empty success masquerading as a real result",
    );

    const violationsPath = path.join(runDir, "extractor-input-contract-violations.json");
    assert.ok(fs.existsSync(violationsPath), "extractor-input-contract-violations.json written for the mismatch");
    const violations = JSON.parse(fs.readFileSync(violationsPath, "utf-8"));
    assert.equal(violations.length, 1, "exactly one contract violation recorded");
    assert.deepEqual(violations[0], {
      code: "EXTRACTOR_INPUT_CONTRACT_MISMATCH",
      extractorId: "FRAMEWORK_MANIFEST_URL_TOKENS_V1",
      observationId: "obs-framework-mismatch",
      expectedInputTypes: ["json"],
      receivedInputType: "html",
      sourceFamily: "framework_manifest",
    });

    // AC: candidate counts in url-source-coverage.json match accepted Stage 3
    // candidates, per family.
    const coverage = JSON.parse(fs.readFileSync(path.join(runDir, "url-source-coverage.json"), "utf-8")) as Array<{
      sourceFamily: string;
      status: string;
      count?: number;
    }>;
    for (const exp of expectations) {
      const entry = coverage.find((c) => c.sourceFamily === exp.sourceFamily);
      assert.ok(entry, `coverage entry exists for ${exp.sourceFamily}`);
      assert.equal(entry!.count, 1, `coverage count for ${exp.sourceFamily} matches its one accepted Stage 3 candidate`);
    }
    const frameworkCoverage = coverage.find((c) => c.sourceFamily === "framework_manifest");
    assert.equal(frameworkCoverage!.status, "error", "framework_manifest source family reports error status from the contract mismatch");
    assert.equal(frameworkCoverage!.count, 0, "no candidates counted for the mismatched family");

    // AC: individual demo-game URL reached Stage 3 output (extraction never drops
    // it) — the pre-existing URL-cleaning-drops-it behaviour is exercised by a
    // dedicated fixture without a contract mismatch (see url-discovery-stages.test.ts /
    // Issue 07's own suite); this fixture deliberately mixes in a contract mismatch,
    // and per Issue 30 that mismatch now stops the run before Stage 2 (URL cleaning)
    // ever runs, so clean-url-inventory.json must not exist here.
    assert.ok(
      rawCandidates.some((c) => c.url === "https://granawins.com/slots/book-of-ra-demo"),
      "individual demo-game URL present in Stage 3 output",
    );
    assert.ok(
      !fs.existsSync(path.join(runDir, "clean-url-inventory.json")),
      "Issue 30: URL cleaning (stage 2) never ran after the Stage 3 contract mismatch, so clean-url-inventory.json was not created",
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

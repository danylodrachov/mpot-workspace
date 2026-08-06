import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageDispatcher, type StageDispatchGate } from "./stage-dispatcher.ts";
import type { RunContext } from "./discovery-orchestrator.ts";
import type { PageObservation } from "./url-map-recon/types.ts";

/**
 * Issue 27: live observation routing, no fixture URLs.
 *
 * Black-box tests against the real `stageDispatcher`/`bin/run-research.ts` seam,
 * using a `page-observations.jsonl` fixture recorded for `https://granawins.com/`
 * — a domain the previous hardcoded recipe (`DOM_URL_ATTRIBUTES_V1` @
 * `https://example-casino.com/en/lobby`, cleaning origin
 * `https://example-casino.com`) would have silently ignored or rejected as
 * off-origin. Nothing here hand-builds a pipeline artifact; every assertion
 * reads what the run itself wrote.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

const CASINO_URL = "https://granawins.com/";
const GEO = "GB";

const domHtml =
  '<a href="/deposit">Deposit</a><a href="/bonuses">Bonuses</a>' +
  '<a href="/terms-and-conditions">Terms</a>' +
  '<a href="https://external-partner.example/aff?id=1">External partner</a>';

function buildObservations(): PageObservation[] {
  return [
    {
      observation_id: "obs-dom-1",
      extractor_id: "DOM_URL_ATTRIBUTES_V1",
      page_url: "https://granawins.com/en/lobby",
      status: "present",
      content_type: "html",
      content: domHtml,
      timestamp: new Date().toISOString(),
    },
    // A second observation for the SAME extractor id must not produce a second
    // extraction step — only the first-seen observation per extractor id wins.
    {
      observation_id: "obs-dom-2-duplicate",
      extractor_id: "DOM_URL_ATTRIBUTES_V1",
      page_url: "https://granawins.com/en/lobby-2",
      status: "present",
      content_type: "html",
      content: '<a href="/should-not-be-requested">Ignored</a>',
      timestamp: new Date().toISOString(),
    },
    {
      observation_id: "obs-robots-1",
      extractor_id: "ROBOTS_SITEMAP_URLS_V1",
      page_url: "https://granawins.com/robots.txt",
      status: "present",
      content_type: "text",
      content: "Sitemap: https://granawins.com/sitemap.xml\n",
      timestamp: new Date().toISOString(),
    },
    {
      observation_id: "obs-json-absent",
      extractor_id: "JSON_ENDPOINT_URL_TOKENS_V1",
      page_url: "https://granawins.com/api/config",
      status: "absent",
      content_type: "json",
      reason: "endpoint_not_found",
      timestamp: new Date().toISOString(),
    },
  ];
}

function setupRunInputs() {
  const outputDir = path.join(tmpdir(), `live-obs-routing-out-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `live-obs-routing-in-${crypto.randomUUID()}`);
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

function readTraceEvents(runDir: string): any[] {
  const p = path.join(runDir, "trace-events.jsonl");
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("Issue 27: live observations drive extraction — real extractor ids, real origin, no fixture URLs", async () => {
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

    assert.equal((result as StageDispatchGate).needs_llm, true, "run should reach the stage 6 gate");
    const gate = result as StageDispatchGate;
    const runDir = gate.run_dir;

    // AC: run-context.json carries the resolved observations path and never a
    // fixture literal for canonical_origin.
    const runContext = JSON.parse(fs.readFileSync(path.join(runDir, "run-context.json"), "utf-8")) as RunContext;
    assert.equal(runContext.canonical_origin, "https://granawins.com", "canonical_origin derived from the real casino_url");
    assert.equal(runContext.observation_provider?.observations_path, observationsPath);

    // AC: raw-url-candidates.json is a flat candidate collection, not nested [[]].
    // Issue 29: each entry is a RawUrlCandidate object carrying provenance
    // (sourceFamily, extractorId) alongside the URL, not a bare string.
    const rawCandidatesRaw = fs.readFileSync(path.join(runDir, "raw-url-candidates.json"), "utf-8");
    const rawCandidates = JSON.parse(rawCandidatesRaw);
    assert.ok(Array.isArray(rawCandidates), "raw-url-candidates.json is an array");
    assert.ok(rawCandidates.length > 0, "raw-url-candidates.json is non-empty");
    for (const entry of rawCandidates) {
      assert.equal(typeof entry, "object", "every raw-url-candidates.json entry is a candidate record, not a nested array");
      assert.equal(typeof entry.url, "string", "every candidate record carries a URL string");
      assert.ok(entry.sourceFamily, "every candidate record carries its source family");
      assert.ok(entry.extractorId, "every candidate record carries its extractor id");
    }
    assert.ok(!JSON.stringify(rawCandidates).includes("example-casino.com"), "no fixture URL leaked into raw candidates");

    // AC: same-origin Granawins candidates were extracted; the external candidate
    // never reached extraction output at all (filtered as off-origin at source).
    assert.ok(
      rawCandidates.some((c: { url: string }) => c.url.startsWith("https://granawins.com/")),
      "same-origin candidates present"
    );
    assert.ok(
      !rawCandidates.some((c: { url: string }) => c.url.includes("external-partner.example")),
      "external candidate excluded from raw candidates"
    );
    assert.ok(
      rawCandidates.some((c: { url: string }) => c.url === "https://granawins.com/sitemap.xml"),
      "sitemap URL from ROBOTS_SITEMAP_URLS_V1 present"
    );

    // AC: same-origin candidates reach clean-url-inventory.json; external ones are not visitable.
    const cleanInventory = JSON.parse(fs.readFileSync(path.join(runDir, "clean-url-inventory.json"), "utf-8"));
    assert.ok(Array.isArray(cleanInventory) && cleanInventory.length > 0, "clean-url-inventory.json non-empty");
    assert.ok(
      cleanInventory.some((e: any) => e.canonicalUrl === "https://granawins.com/deposit"),
      "kept same-origin URL reaches clean-url-inventory.json",
    );
    assert.ok(
      !cleanInventory.some((e: any) => String(e.canonicalUrl).includes("external-partner.example")),
      "external candidate never becomes a visitable clean-url-inventory.json entry",
    );

    // AC: recorded source families are not marked unsupported; the duplicate
    // DOM_URL_ATTRIBUTES_V1 observation did not trigger a second step; the
    // observed-but-empty JSON endpoint keeps its terminal 'absent' status.
    const coverage = JSON.parse(fs.readFileSync(path.join(runDir, "url-source-coverage.json"), "utf-8"));
    const byFamily = new Map(coverage.map((c: any) => [c.sourceFamily, c.status]));
    assert.equal(byFamily.get("dom_url_attributes"), "present", "dom_url_attributes recorded as present, not unsupported");
    assert.equal(byFamily.get("robots_sitemap"), "present", "robots_sitemap recorded as present, not unsupported");
    assert.equal(byFamily.get("json_endpoint"), "absent", "json_endpoint keeps its terminal absent status, not unsupported");
    // Families never recorded in the observations file legitimately stay unsupported.
    assert.equal(byFamily.get("frame_form"), "unsupported", "un-recorded family stays unsupported");
    assert.ok(
      !rawCandidates.some((c: { url: string }) => c.url.includes("should-not-be-requested")),
      "duplicate extractor id observation was never dispatched as a second step"
    );

    // AC: Stage 6 gate carries a non-zero URL count for this live-like fixture.
    assert.ok(gate.gate.classified_urls.length > 0, "stage 6 gate has classified URLs");

    // AC: artifact counts reconcile with trace-event counts — stages 1-5 each
    // produced exactly one 'completed' visit, matching the 5 stage-1..5 artifacts
    // this run actually wrote (raw candidates, coverage, clean inventory, field
    // requirements, dropdown catalog).
    const events = readTraceEvents(runDir);
    const stage1to5 = events.filter((e) => e.stage >= 1 && e.stage <= 5 && e.action === "stage_visited");
    assert.equal(stage1to5.length, 5, "exactly one trace event per stage 1-5");
    assert.ok(stage1to5.every((e) => e.status === "completed"), "stages 1-5 all completed");
    for (const artifact of ["raw-url-candidates.json", "url-source-coverage.json", "clean-url-inventory.json", "field-requirements.json", "dropdown-catalog.json"]) {
      assert.ok(fs.existsSync(path.join(runDir, artifact)), `${artifact} exists, reconciling with the 5 completed stage events`);
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

test("Issue 27: an unknown recorded extractor id fails explicitly instead of being silently replaced", async () => {
  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath } = setupRunInputs();
  const observationsPath = path.join(outputDir, "page-observations-bogus.jsonl");
  const badObservations: PageObservation[] = [
    {
      observation_id: "obs-bogus",
      extractor_id: "BOGUS_EXTRACTOR_V1" as any,
      page_url: "https://granawins.com/en/lobby",
      status: "present",
      content_type: "html",
      content: "<a href=\"/deposit\">Deposit</a>",
      timestamp: new Date().toISOString(),
    },
  ];
  fs.writeFileSync(observationsPath, badObservations.map((o) => JSON.stringify(o)).join("\n") + "\n");

  const originalConsoleError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };

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

    const runDir = (result as any).run_dir;
    const events = readTraceEvents(runDir);
    const stage1Event = events.find((e) => e.stage === 1 && e.action === "stage_visited");
    assert.ok(stage1Event, "stage 1 trace event exists");
    assert.equal(stage1Event.status, "error", "stage 1 fails explicitly on an unknown extractor id");
    assert.ok(!fs.existsSync(path.join(runDir, "raw-url-candidates.json")), "no candidates artifact written when extraction fails");
    assert.ok(
      captured.some((line) => line.includes("BOGUS_EXTRACTOR_V1")),
      "the unknown extractor id is named in the failure, never silently substituted",
    );
    assert.ok(
      !captured.some((line) => line.includes("DOM_URL_ATTRIBUTES_V1") && line.includes("substitut")),
      "no silent substitution with DOM_URL_ATTRIBUTES_V1 is reported",
    );
  } finally {
    console.error = originalConsoleError;
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

test("Issue 27: bin/run-research.ts CLI resolves and passes --observations-path through to stageDispatcher", async () => {
  const runsBaseDir = path.join(projectRoot, "data", "runs");
  const beforeRunDirs = fs.existsSync(path.join(runsBaseDir, "granawins_com", GEO))
    ? new Set(fs.readdirSync(path.join(runsBaseDir, "granawins_com", GEO)))
    : new Set<string>();

  const fixtureDir = path.join(tmpdir(), `cli-observations-${crypto.randomUUID()}`);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const observationsPath = path.join(fixtureDir, "page-observations.jsonl");
  fs.writeFileSync(
    observationsPath,
    buildObservations()
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n",
  );

  let createdRunId: string | undefined;
  try {
    const cliPath = path.join(projectRoot, "bin", "run-research.ts");
    const proc = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, CASINO_URL, GEO, "--observations-path", observationsPath],
      { encoding: "utf-8", cwd: projectRoot },
    );

    assert.equal(proc.status, 0, `CLI should exit 0; stderr: ${proc.stderr}`);
    const runIdMatch = proc.stdout.match(/Run ID:\s*(\S+)/);
    assert.ok(runIdMatch, `CLI stdout should report a Run ID; got: ${proc.stdout}`);
    createdRunId = runIdMatch![1];

    const runDir = path.join(runsBaseDir, "granawins_com", GEO, createdRunId);
    assert.ok(fs.existsSync(runDir), "CLI-created run directory exists");

    const runContext = JSON.parse(fs.readFileSync(path.join(runDir, "run-context.json"), "utf-8")) as RunContext;
    // Only stageDispatcher's resolveObservationProviders writes observation_provider —
    // this proves the CLI's --observations-path reached stageDispatcher, not a
    // reimplementation of the CLI's argument parsing.
    assert.equal(runContext.observation_provider?.provider_type, "live_browser");
    assert.equal(
      runContext.observation_provider?.observations_path,
      observationsPath,
      "the exact resolved --observations-path value reached stageDispatcher",
    );

    // AC: fail with a machine-readable error when the file does not exist.
    const missingPath = path.join(fixtureDir, "does-not-exist.jsonl");
    const failProc = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, CASINO_URL, GEO, "--observations-path", missingPath],
      { encoding: "utf-8", cwd: projectRoot },
    );
    assert.notEqual(failProc.status, 0, "CLI exits non-zero for a missing observations file");
    const errLine = failProc.stderr.trim().split("\n").pop() ?? "";
    const parsedErr = JSON.parse(errLine);
    assert.equal(parsedErr.error, "observations_path_unreadable");
    assert.equal(parsedErr.path, missingPath);
  } finally {
    if (createdRunId) {
      fs.rmSync(path.join(runsBaseDir, "granawins_com", GEO, createdRunId), { recursive: true, force: true });
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

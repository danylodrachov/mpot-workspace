import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { stageDispatcher, type StageDispatchGate, type StageDispatchResult } from "./stage-dispatcher.ts";
import type { PageObservation } from "./url-map-recon/types.ts";

/**
 * Issue 30: EXTRACTOR_INPUT_CONTRACT_MISMATCH is an internal pipeline invariant
 * failure, not a source-family error. It must stop the run outright rather than
 * be folded into partial-run semantics the way an ordinary blocked/absent/
 * unsupported external source is. This test proves:
 *
 * 1. When Stage 3 extraction hits a contract mismatch, the run stops before any
 *    downstream stage (URL cleaning, metadata classification, the Stage 6 gate,
 *    the scorer) does any work, and reports that the run must be repeated.
 * 2. Ordinary external `blocked` source states still produce a partial run and
 *    reach the Stage 6 gate exactly as before this change.
 */

const CASINO_URL = "https://contractviolation-example.test/";
const GEO = "GB";

function setupRunInputs(observations: PageObservation[]) {
  const outputDir = path.join(tmpdir(), `stop-on-contract-out-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `stop-on-contract-in-${crypto.randomUUID()}`);
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
    observations.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );

  return { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, observationsPath };
}

test("Issue 30: an extractor input contract mismatch stops the pipeline before downstream stages run", async () => {
  const ts = new Date().toISOString();
  const observations: PageObservation[] = [
    // FRAMEWORK_MANIFEST_URL_TOKENS_V1 only accepts 'json'; this observation
    // carries 'html', producing a typed EXTRACTOR_INPUT_CONTRACT_MISMATCH.
    {
      observation_id: "obs-mismatch",
      extractor_id: "FRAMEWORK_MANIFEST_URL_TOKENS_V1",
      page_url: "https://contractviolation-example.test/en/",
      status: "present",
      content_type: "html",
      content: "<html>not json</html>",
      timestamp: ts,
    },
  ];

  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, observationsPath } =
    setupRunInputs(observations);

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

    // AC: the run never reaches the Stage 6 gate (scorer is never invoked).
    assert.notEqual(
      (result as StageDispatchGate).needs_llm,
      true,
      "run must not reach the stage 6 relevance-scorer gate after a contract mismatch",
    );
    const runResult = result as StageDispatchResult;
    const runDir = path.join(outputDir, ...runResultRunDirParts(runResult, outputDir));

    // AC: the run result reports that it must be repeated after the extractor
    // contract is fixed.
    assert.match(
      runResult.final_report ?? "",
      /repeat/i,
      "final report tells the caller the run must be repeated",
    );
    assert.match(
      runResult.final_report ?? "",
      /extractor.*contract|contract.*extractor/i,
      "final report names the extractor contract as the reason",
    );

    // AC: Stage 3 status is `error`; no successful stage_visited event for stage 1
    // (extraction) exists, and a structured event carries the mismatch detail.
    const traceEventsPath = path.join(runDir, "trace-events.jsonl");
    assert.ok(fs.existsSync(traceEventsPath), "trace-events.jsonl exists");
    const events = fs
      .readFileSync(traceEventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    const stage1Events = events.filter((e) => e.stage === 1 && e.action === "stage_visited");
    assert.ok(stage1Events.length > 0, "a stage_visited event was recorded for stage 1 (extraction)");
    assert.ok(
      stage1Events.every((e) => e.status !== "completed"),
      "no stage_visited event for stage 1 reports a successful completion",
    );
    assert.ok(
      stage1Events.some((e) => e.status === "error"),
      "stage 1 is reported as error",
    );

    const mismatchEvents = events.filter(
      (e) => typeof e.error === "string" && e.error.includes("EXTRACTOR_INPUT_CONTRACT_MISMATCH"),
    );
    assert.ok(mismatchEvents.length > 0, "a structured run event carries the mismatch detail");
    assert.ok(
      mismatchEvents.some((e) => e.error.includes("FRAMEWORK_MANIFEST_URL_TOKENS_V1")),
      "mismatch event names the offending extractor id",
    );
    assert.ok(
      mismatchEvents.some((e) => e.error.includes("obs-mismatch")),
      "mismatch event names the offending observation id",
    );

    // AC: downstream artifacts are not created and not updated on disk.
    const cleanInventoryPath = path.join(runDir, "clean-url-inventory.json");
    const decisionsLogPath = path.join(runDir, "url-clean-decisions.jsonl");
    const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
    assert.ok(!fs.existsSync(cleanInventoryPath), "clean-url-inventory.json (URL cleaning / metadata classification) not created");
    assert.ok(!fs.existsSync(decisionsLogPath), "url-clean-decisions.jsonl (decision log) not created");
    assert.ok(!fs.existsSync(fieldRequirementsPath), "field-requirements.json (feeds the stage 6 gate) not created");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

test("Issue 30: an ordinary blocked external source still produces a partial run and reaches the stage 6 gate", async () => {
  const ts = new Date().toISOString();
  const observations: PageObservation[] = [
    {
      observation_id: "obs-blocked",
      extractor_id: "DOM_URL_ATTRIBUTES_V1",
      page_url: "https://contractviolation-example.test/en/",
      status: "blocked",
      content_type: "candidates",
      content: [],
      timestamp: ts,
    },
  ];

  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, observationsPath } =
    setupRunInputs(observations);

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

    // AC: ordinary blocked/absent/unsupported source states keep existing
    // partial-run semantics — the run still reaches the stage 6 gate.
    assert.equal(
      (result as StageDispatchGate).needs_llm,
      true,
      "a blocked source (no contract mismatch) still lets the run reach the stage 6 gate",
    );
    const runDir = (result as StageDispatchGate).run_dir;

    const coverage = JSON.parse(
      fs.readFileSync(path.join(runDir, "url-source-coverage.json"), "utf-8"),
    ) as Array<{ sourceFamily: string; status: string }>;
    const domCoverage = coverage.find((c) => c.sourceFamily === "dom_url_attributes");
    assert.equal(domCoverage?.status, "blocked", "blocked source family status is preserved, unchanged by this issue");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

/** Recovers the run's directory path segments (casino_id/geo/run_id) relative to baseDir from run-context artifacts written under it. */
function runResultRunDirParts(result: { run_id?: string; casino_id?: string }, outputDir: string): string[] {
  const casinoId = result.casino_id;
  if (!casinoId) throw new Error("Expected casino_id on stage dispatch result");
  const geoDir = path.join(outputDir, casinoId, GEO);
  const runFolders = fs.readdirSync(geoDir);
  assert.equal(runFolders.length, 1, "exactly one run directory under casino/geo");
  return [casinoId, GEO, runFolders[0]];
}

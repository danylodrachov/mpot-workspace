import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { stageDispatcher, resumeAfterRelevanceScoring, type StageDispatchGate } from "./stage-dispatcher.ts";
import type { ScorerOutput, FieldRelevanceScore } from "./url-field-relevance-scorer.types.ts";

/**
 * Full pipeline end-to-end tests (Issue 25).
 *
 * Two previous "e2e" suites (`casino-discovery-e2e.test.ts`, `casino-discovery-orchestration.test.ts`)
 * hand-built the artifacts they then asserted on and never actually ran the pipeline — they
 * stayed green through the entire period the pipeline was unrunnable. This suite starts a real
 * run through `stageDispatcher`/`resumeAfterRelevanceScoring` and reads only what the run itself
 * wrote into its own run directory. No test in this file constructs a pipeline artifact by hand.
 */

const TEMPLATE = {
  betting: { name: "Betting", operator_fields: [], fields: { casino_name: { type: "text" } } },
  casinos: { name: "Casinos", operator_fields: [], fields: { url: { type: "url" } } },
  sports: { name: "Sports", operator_fields: [], fields: { url: { type: "url" } } },
  slots: { name: "Slots", operator_fields: [], fields: { url: { type: "url" } } },
  "live-casino": { name: "Live Casino", operator_fields: [], fields: { url: { type: "url" } } },
  bonuses: { name: "Bonuses", operator_fields: [], fields: { bonus_type: { type: "text" } } },
  deposits: { name: "Deposits", operator_fields: [], fields: { method: { type: "text" } } },
  withdrawals: { name: "Withdrawals", operator_fields: [], fields: { method: { type: "text" } } },
  "responsible-gaming": { name: "Responsible Gaming", operator_fields: [], fields: { url: { type: "url" } } },
  support: { name: "Support", operator_fields: [], fields: { email: { type: "email" } } },
  legal: { name: "Legal", operator_fields: [], fields: { license_number: { type: "text" } } },
};

function setupRunInputs(baseDir?: string) {
  const outputDir = baseDir ?? path.join(tmpdir(), `full-run-e2e-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `full-run-e2e-inputs-${crypto.randomUUID()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  const templatePath = path.join(inputDir, "template.json");
  const extractionRulesPath = path.join(inputDir, "extraction-rules.json");
  const urlRulesPath = path.join(inputDir, "url-rules.json");
  fs.writeFileSync(templatePath, JSON.stringify(TEMPLATE));
  fs.writeFileSync(extractionRulesPath, JSON.stringify({ rules: [] }));
  fs.writeFileSync(urlRulesPath, JSON.stringify({ rules: [] }));

  return { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath };
}

const fixtureHtml =
  '<a href="/deposit">Deposit</a><a href="/withdrawal">Withdrawal</a>' +
  '<a href="/slots">Slots</a><a href="/sports">Sports</a><a href="/rules">Rules</a>';

async function reachStage6(opts: {
  casinoUrl: string;
  geo: string;
  baseDir?: string;
  blockedDom?: boolean;
}): Promise<{ gate: StageDispatchGate; outputDir: string; inputDir: string; cleanup: () => void }> {
  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath } = setupRunInputs(opts.baseDir);

  const inputProvider = opts.blockedDom
    ? (step: any) =>
        step.extractorId === "DOM_URL_ATTRIBUTES_V1"
          ? { pageUrl: step.pageUrl, html: "<html><body></body></html>", sourceStatus: "blocked" as const }
          : { pageUrl: step.pageUrl, json: "{}", sourceStatus: "absent" as const }
    : (step: any) =>
        step.extractorId === "DOM_URL_ATTRIBUTES_V1"
          ? { pageUrl: step.pageUrl, html: fixtureHtml }
          : { pageUrl: step.pageUrl, json: "{}" };

  const result = await stageDispatcher({
    baseDir: outputDir,
    casino_url: opts.casinoUrl,
    geo: opts.geo,
    run_id: crypto.randomUUID(),
    template_path: templatePath,
    extraction_rules_path: extractionRulesPath,
    url_rules_path: urlRulesPath,
    inputProvider,
  });

  assert.equal((result as StageDispatchGate).needs_llm, true, "run should stop at stage 6 gate");
  const gate = result as StageDispatchGate;

  return {
    gate,
    outputDir,
    inputDir,
    cleanup: () => {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.rmSync(inputDir, { recursive: true, force: true });
    },
  };
}

function scoreAllRelevant(gate: StageDispatchGate): ScorerOutput {
  const scores: FieldRelevanceScore[] = [];
  for (const url of gate.gate.classified_urls) {
    for (const field of gate.gate.field_requirements) {
      scores.push({
        url_id: url.url_id,
        field_id: field.field_id,
        probability: 0.8,
        class: "likely",
        reason: "URL structure suggests relevance",
      });
    }
  }
  return {
    scores,
    request_id: gate.gate.request_id,
    total_pairs_evaluated: scores.length,
    timestamp: new Date().toISOString(),
  };
}

function readEvents(runDir: string): any[] {
  const p = path.join(runDir, "trace-events.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("e2e: clean full run reaches the terminal stage and emits the review artifact", async () => {
  const { gate, cleanup } = await reachStage6({ casinoUrl: "https://example-casino.com", geo: "US" });
  try {
    const outcome = await resumeAfterRelevanceScoring(gate, scoreAllRelevant(gate), {});
    assert.ok("final_report" in outcome, "run should complete rather than stop at another gate");
    assert.ok(!("needs_llm" in outcome) || (outcome as any).needs_llm !== true, "run must not re-gate");

    const runDir = gate.run_dir;
    const reportPath = path.join(runDir, "discovery-review.json");
    assert.ok(fs.existsSync(reportPath), "discovery-review.json must exist");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    assert.ok(report.run_id, "review artifact must carry a run_id");
    assert.ok(["complete", "partial"].includes(report.completion_status));

    // No stage handler recorded a failure — the pipeline actually ran, not just "stayed green".
    const events = readEvents(runDir);
    assert.ok(events.length > 0, "run must produce trace events");
    for (const e of events) {
      assert.notEqual(e.status, "failed", `stage ${e.stage} reported a failure: ${e.error}`);
    }
  } finally {
    cleanup();
  }
});

test("e2e: a second run against the same casino and geo produces a delta referencing the first", async () => {
  const baseDir = path.join(tmpdir(), `full-run-e2e-delta-${crypto.randomUUID()}`);
  fs.mkdirSync(baseDir, { recursive: true });
  try {
    const first = await reachStage6({ casinoUrl: "https://delta-casino.com", geo: "US", baseDir });
    const firstOutcome = await resumeAfterRelevanceScoring(first.gate, scoreAllRelevant(first.gate), {});
    assert.ok("final_report" in firstOutcome);
    const firstDelta = JSON.parse(fs.readFileSync(path.join(first.gate.run_dir, "discovery-delta.json"), "utf-8"));
    assert.ok(firstDelta.gaps.every((g: any) => g.change_type === "new"), "first run against this casino/geo has no history");

    const second = await reachStage6({ casinoUrl: "https://delta-casino.com", geo: "US", baseDir });
    assert.notEqual(second.gate.run_id, first.gate.run_id, "second run must be a distinct run");
    const secondOutcome = await resumeAfterRelevanceScoring(second.gate, scoreAllRelevant(second.gate), {});
    assert.ok("final_report" in secondOutcome);
    const secondDelta = JSON.parse(fs.readFileSync(path.join(second.gate.run_dir, "discovery-delta.json"), "utf-8"));

    // The second run found the same gaps the first run already recorded — they must
    // reference that history ('unresolved') rather than reporting as brand 'new' again.
    if (secondDelta.gaps.length > 0) {
      assert.ok(
        secondDelta.gaps.some((g: any) => g.change_type === "unresolved"),
        "second run's delta must reference the first run's coverage, not treat every gap as new",
      );
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("e2e: blocked-source run continues with reduced inventory and still reaches the terminal stage", async () => {
  const { gate, cleanup } = await reachStage6({ casinoUrl: "https://blocked-casino.com", geo: "GB", blockedDom: true });
  try {
    // The blocked DOM source means fewer (possibly zero) discovered URLs, but the run
    // must still walk every remaining stage rather than halting.
    const outcome = await resumeAfterRelevanceScoring(gate, scoreAllRelevant(gate), {});
    assert.ok("final_report" in outcome, "run must complete despite the blocked source");
    assert.ok(fs.existsSync(path.join(gate.run_dir, "discovery-review.json")), "review artifact must still be produced");

    const coverage = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "url-source-coverage.json"), "utf-8"));
    const domCoverage = coverage.find((c: any) => c.sourceFamily === "dom_url_attributes");
    assert.ok(domCoverage, "coverage must record the DOM source family");
    assert.equal(domCoverage.status, "blocked", "blocked source must be recorded as blocked, not silently dropped");
  } finally {
    cleanup();
  }
});

test("e2e: malformed relevance-scorer output fails open and the run still completes", async () => {
  const { gate, cleanup } = await reachStage6({ casinoUrl: "https://malformed-scorer.com", geo: "US" });
  try {
    // Deliberately malformed: field_id/url_id references nothing the gate ever offered.
    const malformedReply: ScorerOutput = {
      scores: [
        { url_id: "does-not-exist", field_id: "does-not-exist", probability: 2, class: "likely" as any, reason: "malformed" },
      ],
      request_id: gate.gate.request_id,
      total_pairs_evaluated: 1,
      timestamp: new Date().toISOString(),
    };

    const outcome = await resumeAfterRelevanceScoring(gate, malformedReply, {});
    assert.ok("final_report" in outcome, "run must complete even when the scorer's reply is malformed");

    const events = readEvents(gate.run_dir);
    assert.ok(
      events.some((e) => e.action === "validation_failed"),
      "malformed scorer output must be recorded as a validation failure",
    );
    assert.ok(
      events.some((e) => e.action === "fail_open"),
      "stage 7 must fail open when validation failed",
    );

    // Fail-open means every discovered URL stays in the visit plan.
    const visitPlan = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "visit-plan.json"), "utf-8"));
    assert.ok(visitPlan.length > 0, "visit plan must not be empty after a malformed reply");
    assert.ok(visitPlan.every((v: any) => v.selected), "fail-open must keep every URL selected");
  } finally {
    cleanup();
  }
});

test("e2e: a mandatory page scored irrelevant by the scorer is still visited", async () => {
  const { gate, cleanup } = await reachStage6({ casinoUrl: "https://mandatory-override.com", geo: "US" });
  try {
    const depositUrl = gate.gate.classified_urls.find((u: any) => u.canonicalUrl.includes("/deposit"));
    assert.ok(depositUrl, "fixture must discover the /deposit page");
    assert.equal((depositUrl as any).isMandatory, true, "the /deposit page must be classified mandatory");

    const scores: FieldRelevanceScore[] = [];
    for (const url of gate.gate.classified_urls) {
      for (const field of gate.gate.field_requirements) {
        const isDeposit = url.canonicalUrl === depositUrl!.canonicalUrl;
        scores.push({
          url_id: url.url_id,
          field_id: field.field_id,
          probability: isDeposit ? 0.0 : 0.8,
          class: isDeposit ? "irrelevant" : "likely",
          reason: isDeposit ? "scored irrelevant by the LLM" : "URL structure suggests relevance",
        });
      }
    }
    const scorerReply: ScorerOutput = {
      scores,
      request_id: gate.gate.request_id,
      total_pairs_evaluated: scores.length,
      timestamp: new Date().toISOString(),
    };

    const outcome = await resumeAfterRelevanceScoring(gate, scorerReply, {});
    assert.ok("final_report" in outcome);

    const visitPlan = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "visit-plan.json"), "utf-8"));
    const depositEntry = visitPlan.find((v: any) => v.canonicalUrl === depositUrl!.canonicalUrl);
    assert.ok(depositEntry, "deposit page must be in the visit plan");
    assert.equal(depositEntry.selected, true, "mandatory page must be visited despite an irrelevant score");
    assert.equal(depositEntry.selectionReason, "mandatory page");

    const matrix = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "url-field-relevance.json"), "utf-8"));
    const depositScores = matrix.filter((m: any) => m.url_id === depositUrl!.url_id);
    assert.ok(depositScores.length > 0, "deposit page must have validated relevance entries");
    assert.ok(depositScores.every((s: any) => s.overridden === true), "irrelevant score must be recorded as overridden");
  } finally {
    cleanup();
  }
});

test("e2e: no deterministic module reaches a browser or the network", () => {
  const researchDir = path.join(import.meta.dirname, ".");
  const files = fs.readdirSync(researchDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) {
    const text = fs.readFileSync(path.join(researchDir, file), "utf-8");
    assert.ok(!/from\s+["']playwright/i.test(text), `${file} must not import playwright`);
    assert.ok(!/mcp__playwright/i.test(text), `${file} must not reference an MCP browser tool`);
    assert.ok(!/\bfetch\(/i.test(text) || file === "observation-provider.ts", `${file} must not call fetch() directly`);
  }
});

test("e2e: the launcher skill documents bootstrap -> observe -> dispatch and invokes the browser agents only as observation producers", () => {
  const skillPath = path.join(import.meta.dirname, "..", "..", ".claude", "skills", "casino-discovery", "SKILL.md");
  const text = fs.readFileSync(skillPath, "utf-8");

  assert.ok(/url-field-relevance-scorer/i.test(text), "skill must reference the relevance scorer");

  // The three phases must be documented in order: bootstrap the run dir, record
  // observations into it, then dispatch the stages against that same run.
  const bootstrapAt = text.search(/initializeRun\(\)/);
  const observeAt = text.search(/url-map-recon/i);
  const dispatchAt = text.search(/stageDispatcher\(\)/);
  assert.ok(bootstrapAt >= 0, "skill must name initializeRun() as the bootstrap step");
  assert.ok(observeAt >= 0, "skill must name url-map-recon as an observation producer");
  assert.ok(dispatchAt >= 0, "skill must name stageDispatcher() as the dispatch step");
  assert.ok(bootstrapAt < observeAt, "bootstrap must be documented before the observe phase");
  assert.ok(observeAt < dispatchAt, "observe phase must be documented before dispatch");

  // Both browser agents are invoked, and both are pointed at the bootstrapped run dir.
  assert.ok(/discovery-browser/i.test(text), "skill must name discovery-browser as an observation producer");
  assert.ok(/output_dir/.test(text), "skill must set output_dir for the browser agents");
  assert.ok(/existingRunDir/.test(text), "skill must attach dispatch to the bootstrapped run dir");

  // The blanket prohibition is gone; the narrower rule replaces it.
  assert.ok(!/do not invoke[^\n]*url-map-recon/i.test(text), "skill must no longer forbid url-map-recon outright");
  assert.ok(
    /only as observation producers/i.test(text),
    "skill must state the browser agents are invoked only as observation producers",
  );
  assert.ok(
    /never produce a canonical pipeline artifact/i.test(text),
    "skill must state the browser agents never produce a canonical artifact",
  );

  // discovery-reviewer stays forbidden outright.
  assert.ok(/do not invoke[^\n]*discovery-reviewer/i.test(text), "skill must explicitly forbid discovery-reviewer");
});

test("e2e: every hook command registered in settings.json resolves to an existing file", () => {
  const settingsPath = path.join(import.meta.dirname, "..", "..", ".claude", "settings.json");
  const projectRoot = path.join(import.meta.dirname, "..", "..");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
    hooks?: Record<string, { hooks: { command: string }[] }[]>;
  };

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const match = /(?:\$\{CLAUDE_PROJECT_DIR\}|"?\$CLAUDE_PROJECT_DIR"?)(\/[^\s"]+)/.exec(hook.command);
        if (!match) continue;
        const scriptPath = path.join(projectRoot, match[1]);
        assert.ok(fs.existsSync(scriptPath), `${event} hook points at a missing script: ${match[1]}`);
      }
    }
  }
});

test("e2e: no run writes a retired legacy artifact", async () => {
  const { gate, cleanup } = await reachStage6({ casinoUrl: "https://legacy-check.com", geo: "US" });
  try {
    const outcome = await resumeAfterRelevanceScoring(gate, scoreAllRelevant(gate), {});
    assert.ok("final_report" in outcome);

    const legacyArtifacts = [
      "document-url-map.json", // superseded by raw-url-candidates.json / clean-url-inventory.json
      "sports.json",
      "live-casino.json",
      "slots.json",
      "regex-clean-decisions.jsonl",
    ];
    const runDirFiles = fs.readdirSync(gate.run_dir);
    for (const legacy of legacyArtifacts) {
      assert.ok(!runDirFiles.includes(legacy), `retired legacy artifact ${legacy} must not be written`);
    }
  } finally {
    cleanup();
  }
});

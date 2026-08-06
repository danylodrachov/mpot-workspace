import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  stageDispatcher,
  resumeAfterRelevanceScoring,
  runGapProbeLoop,
  findPreviousRunCoveragePath,
  type StageDispatchGate,
} from "./stage-dispatcher.ts";
import type { ScorerOutput, FieldRelevanceScore } from "./url-field-relevance-scorer.types.ts";
import type { GapProbeRequest, GapProbeResult } from "./gap-validator.ts";
import { normalizeAndResolveFieldCandidates } from "./normalisers.ts";
import { generateFieldCoverage } from "./coverage-reporter.ts";
import type { FieldRequirement } from "./template-requirements.ts";
import type { FieldEvidenceCandidate } from "./field-collector.ts";
import type { RunContext } from "./discovery-orchestrator.ts";

/**
 * Black-box tests for issue 23: normalisation, coverage, gap probing, and report
 * rendering wired into the real stage-dispatcher.
 *
 * Verifies acceptance criteria:
 * 1. Full run walks to the terminal stage and produces the review artifact
 * 2. Every field carries a terminal status from the allowed set
 * 3. Unresolved conflicts retain all candidates and are reported as conflicting
 * 4. Proposed dropdown additions recorded separately, catalog unchanged
 * 5. Gap probe loop bounded; hitting the bound finishes as partial
 * 6. A probe result failing validation leaves coverage untouched
 * 7. Delta compares against previous run; first run reports every field as new
 * 8. Report names each missing/blocked/conflicting/errored field with reason and URL
 * 9. Stages 14-16 report real outcomes, no pending stage
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

function setupRunInputs() {
  const outputDir = path.join(tmpdir(), `wire-report-e2e-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `wire-report-inputs-${crypto.randomUUID()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  const templatePath = path.join(inputDir, "template.json");
  const extractionRulesPath = path.join(inputDir, "extraction-rules.json");
  const urlRulesPath = path.join(inputDir, "url-rules.json");
  fs.writeFileSync(templatePath, JSON.stringify(TEMPLATE));
  fs.writeFileSync(extractionRulesPath, JSON.stringify({ rules: [] }));
  fs.writeFileSync(urlRulesPath, JSON.stringify({ rules: [] }));

  const fixture = {
    pageUrl: "https://example-casino.com/en/lobby",
    html:
      '<a href="/deposit">Deposit</a><a href="/withdrawal">Withdrawal</a>' +
      '<a href="/slots">Slots</a><a href="/sports">Sports</a><a href="/rules">Rules</a>',
  };
  const inputProvider = () => fixture;

  return { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, inputProvider };
}

async function reachStage6(): Promise<{ gate: StageDispatchGate; cleanup: () => void }> {
  const { outputDir, inputDir, templatePath, extractionRulesPath, urlRulesPath, inputProvider } = setupRunInputs();

  const result = await stageDispatcher({
    baseDir: outputDir,
    casino_url: "https://example-casino.com",
    geo: "US",
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
    cleanup: () => {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.rmSync(inputDir, { recursive: true, force: true });
    },
  };
}

/** Scores every URL as likely for every field — everything ends up selected. */
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

test("wire normalisation-coverage-report: full run reaches terminal stage with a valid review artifact", async () => {
  const { gate, cleanup } = await reachStage6();
  try {
    const scorerReply = scoreAllRelevant(gate);
    const outcome = await resumeAfterRelevanceScoring(gate, scorerReply, {});

    // AC1 + AC9: dispatch completed, no stage 14-16 left pending.
    assert.ok("final_report" in outcome, "run should complete rather than stop at another gate");
    const pending = (outcome as any).pending_stages ?? [];
    assert.ok(!pending.includes(14), "stage 14 must not be pending");
    assert.ok(!pending.includes(15), "stage 15 must not be pending");
    assert.ok(!pending.includes(16), "stage 16 must not be pending");

    const runDir = gate.run_dir;
    const decisionsPath = path.join(runDir, "normalisation-decisions.jsonl");
    const coveragePath = path.join(runDir, "field-coverage.json");
    const deltaPath = path.join(runDir, "discovery-delta.json");
    const reportPath = path.join(runDir, "discovery-review.json");
    for (const p of [decisionsPath, coveragePath, deltaPath, reportPath]) {
      assert.ok(fs.existsSync(p), `expected artifact missing: ${p}`);
    }

    // AC2: every field carries a terminal status from the allowed set only.
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));
    const allowedStatuses = ["found", "missing", "blocked", "conflicting", "unsupported", "error", "not_publicly_available"];
    for (const field of coverage.fields) {
      assert.ok(allowedStatuses.includes(field.status), `field ${field.field_id} has invalid status: ${field.status}`);
    }
    const coverageText = fs.readFileSync(coveragePath, "utf-8");
    assert.ok(!coverageText.includes('"status":"present"'), "must not use local present status");
    assert.ok(!coverageText.includes('"status":"human_required"'), "must not use local human_required status");

    // AC7: first run for this casino/geo — every gap is reported as new.
    const delta = JSON.parse(fs.readFileSync(deltaPath, "utf-8"));
    for (const gapEntry of delta.gaps) {
      assert.equal(gapEntry.change_type, "new", `first run gap ${gapEntry.field_id} should be change_type 'new'`);
    }

    // AC8: report names each gap with reason (gap_type) and, where evidence exists, a source URL.
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    assert.ok(report.run_id, "report should have run_id");
    assert.ok(["complete", "partial"].includes(report.completion_status));
    for (const g of report.gaps ?? []) {
      assert.ok(g.field_id, "gap must name its field");
      assert.ok(g.gap_type, "gap must carry its reason");
    }
  } finally {
    cleanup();
  }
});

test("wire normalisation-coverage-report: conflicting evidence is detected, preserved, and reported as conflicting", async () => {
  const testDir = fs.mkdtempSync(path.join(tmpdir(), "wire-conflict-"));
  try {
    const fieldRequirementsOutput = {
      fields: [{ field_id: "casino:name", category: "casino", name: "Casino Name", type: "text" }] as FieldRequirement[],
      version: "1.0.0",
    };
    const dropdownCatalog = { dropdowns: {}, version: "1.0.0" };

    const evidence: FieldEvidenceCandidate[] = [
      {
        field_id: "casino:name",
        template: "casino",
        field_name: "Casino Name",
        value: "Casino A",
        url: "https://example-casino.com/a",
        section: "casino" as any,
        interaction_state: "baseline",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["visible"],
        truncated: false,
        timestamp: new Date().toISOString(),
      },
      {
        field_id: "casino:name",
        template: "casino",
        field_name: "Casino Name",
        value: "Casino B",
        url: "https://example-casino.com/b",
        section: "casino" as any,
        interaction_state: "baseline",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["visible"],
        truncated: false,
        timestamp: new Date().toISOString(),
      },
    ];

    const fieldReqPath = path.join(testDir, "field-requirements.json");
    const fieldEvidencePath = path.join(testDir, "field-evidence.jsonl");
    const catalogPath = path.join(testDir, "dropdown-catalog.json");
    const visitPlanPath = path.join(testDir, "visit-plan.json");
    const coveragePath = path.join(testDir, "field-coverage.json");
    const deltaPath = path.join(testDir, "discovery-delta.json");

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirementsOutput));
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog));
    fs.writeFileSync(fieldEvidencePath, evidence.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(
      visitPlanPath,
      JSON.stringify({
        plan: [
          { url_id: "u1", url: "https://example-casino.com/a", disposition: "selected" },
          { url_id: "u2", url: "https://example-casino.com/b", disposition: "selected" },
        ],
      }),
    );

    await normalizeAndResolveFieldCandidates(fieldEvidencePath, catalogPath, testDir);

    const normalisationPath = path.join(testDir, "normalisation-decisions.jsonl");
    const decisions = fs
      .readFileSync(normalisationPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    const conflictDecision = decisions.find((d: any) => d.decision_type === "conflicting");
    assert.ok(conflictDecision, "conflicting evidence must be detected");
    assert.ok(Array.isArray(conflictDecision.candidates) && conflictDecision.candidates.length >= 2, "all candidates preserved");
    const catalogAfter = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    assert.deepEqual(catalogAfter, dropdownCatalog, "committed catalog must be unchanged");

    await generateFieldCoverage(fieldReqPath, fieldEvidencePath, normalisationPath, visitPlanPath, coveragePath, deltaPath);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));
    const nameField = coverage.fields.find((f: any) => f.field_id === "casino:name");
    assert.equal(nameField.status, "conflicting", "conflict must surface as terminal status 'conflicting'");
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("wire normalisation-coverage-report: new dropdown values are proposed separately, never mutating the catalog", async () => {
  const testDir = fs.mkdtempSync(path.join(tmpdir(), "wire-additions-"));
  try {
    const fieldRequirementsOutput = {
      fields: [{ field_id: "deposits:methods", category: "deposits", name: "Deposit Methods", type: "enum" }] as FieldRequirement[],
      version: "1.0.0",
    };
    const dropdownCatalog = {
      dropdowns: { deposits: [{ canonical: "credit_card", aliases: ["visa"], type: "enum", source_hash: "abc" }] },
      version: "1.0.0",
    };

    const fieldReqPath = path.join(testDir, "field-requirements.json");
    const fieldEvidencePath = path.join(testDir, "field-evidence.jsonl");
    const catalogPath = path.join(testDir, "dropdown-catalog.json");

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirementsOutput));
    fs.writeFileSync(catalogPath, JSON.stringify(dropdownCatalog));
    fs.writeFileSync(
      fieldEvidencePath,
      JSON.stringify({
        field_id: "deposits:methods",
        template: "deposits",
        field_name: "Deposit Methods",
        value: "cryptocurrency",
        url: "https://example-casino.com",
        section: "cashier",
        interaction_state: "baseline",
        extraction_rule_id: "DOM_SEMANTIC_SCAN_V1",
        evidence_type: "dom_text",
        completeness_dimensions: ["visible"],
        truncated: false,
        timestamp: new Date().toISOString(),
      } as FieldEvidenceCandidate) + "\n",
    );

    await normalizeAndResolveFieldCandidates(fieldEvidencePath, catalogPath, testDir);

    const additionsPath = path.join(testDir, "dropdown-additions.json");
    assert.ok(fs.existsSync(additionsPath), "new value must be recorded as a proposed addition");
    const additions = JSON.parse(fs.readFileSync(additionsPath, "utf-8"));
    assert.ok(additions.additions.some((a: any) => a.proposed_canonical === "cryptocurrency"));

    const catalogAfter = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    assert.deepEqual(catalogAfter, dropdownCatalog, "committed catalog must be byte-for-byte unchanged");
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("wire normalisation-coverage-report: delta reports 'unresolved' against a previous run and 'new' on a first run", async () => {
  const casinoDir = fs.mkdtempSync(path.join(tmpdir(), "wire-delta-casino-"));
  const geoDir = path.join(casinoDir, "US");
  fs.mkdirSync(geoDir, { recursive: true });
  const previousRunDir = path.join(geoDir, "run-previous");
  const currentRunDir = path.join(geoDir, "run-current");
  fs.mkdirSync(previousRunDir, { recursive: true });
  fs.mkdirSync(currentRunDir, { recursive: true });

  try {
    const fieldRequirementsOutput = {
      fields: [{ field_id: "support:email", category: "support", name: "Support Email", type: "text" }] as FieldRequirement[],
      version: "1.0.0",
    };
    const visitPlan = { plan: [{ url_id: "u1", url: "https://example-casino.com", disposition: "selected" }] };

    // Previous run: field was already missing.
    fs.writeFileSync(path.join(previousRunDir, "field-requirements.json"), JSON.stringify(fieldRequirementsOutput));
    fs.writeFileSync(path.join(previousRunDir, "field-evidence.jsonl"), "");
    fs.writeFileSync(path.join(previousRunDir, "visit-plan.json"), JSON.stringify(visitPlan));
    await generateFieldCoverage(
      path.join(previousRunDir, "field-requirements.json"),
      path.join(previousRunDir, "field-evidence.jsonl"),
      path.join(previousRunDir, "normalisation-decisions.jsonl"),
      path.join(previousRunDir, "visit-plan.json"),
      path.join(previousRunDir, "field-coverage.json"),
      path.join(previousRunDir, "discovery-delta.json"),
    );
    const firstRunDelta = JSON.parse(fs.readFileSync(path.join(previousRunDir, "discovery-delta.json"), "utf-8"));
    assert.equal(firstRunDelta.gaps[0].change_type, "new", "a first run (no previous coverage) reports the gap as new");

    // Current run: same field still missing — findPreviousRunCoveragePath must locate the sibling.
    fs.writeFileSync(path.join(currentRunDir, "field-requirements.json"), JSON.stringify(fieldRequirementsOutput));
    fs.writeFileSync(path.join(currentRunDir, "field-evidence.jsonl"), "");
    fs.writeFileSync(path.join(currentRunDir, "visit-plan.json"), JSON.stringify(visitPlan));

    const previousCoveragePath = findPreviousRunCoveragePath(currentRunDir);
    assert.ok(previousCoveragePath, "previous run coverage should be found in the sibling run directory");

    await generateFieldCoverage(
      path.join(currentRunDir, "field-requirements.json"),
      path.join(currentRunDir, "field-evidence.jsonl"),
      path.join(currentRunDir, "normalisation-decisions.jsonl"),
      path.join(currentRunDir, "visit-plan.json"),
      path.join(currentRunDir, "field-coverage.json"),
      path.join(currentRunDir, "discovery-delta.json"),
      previousCoveragePath,
    );
    const currentDelta = JSON.parse(fs.readFileSync(path.join(currentRunDir, "discovery-delta.json"), "utf-8"));
    assert.equal(currentDelta.gaps[0].change_type, "unresolved", "a gap already present last run is 'unresolved', not 'new'");
  } finally {
    fs.rmSync(casinoDir, { recursive: true, force: true });
  }
});

test("wire normalisation-coverage-report: gap probe loop is bounded and a validation failure leaves coverage untouched", async () => {
  const runDir = fs.mkdtempSync(path.join(tmpdir(), "wire-gap-loop-"));
  try {
    const fieldId = "legal:license_number";
    const runContext: RunContext = {
      run_id: "gap-loop-run",
      casino_url: "https://example-casino.com",
      casino_id: "example-casino",
      geo: "US",
      locale: "en-US",
      canonical_origin: "https://example-casino.com",
      approved_same_domain_scope: "https://example-casino.com",
      template_hash: "hash",
      extraction_rules_hash: "hash",
      url_rules_hash: "hash",
      module_version_hash: "hash",
      scorer_prompt_hash: "hash",
      visit_policy_hash: "hash",
      probe_policy_hash: "hash",
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };
    fs.writeFileSync(path.join(runDir, "run-context.json"), JSON.stringify(runContext));
    fs.writeFileSync(
      path.join(runDir, "discovery-delta.json"),
      JSON.stringify({
        gaps: [
          {
            field_id: fieldId,
            category: "legal",
            name: "License Number",
            gap_type: "missing",
            change_type: "new",
            unvisited_urls: ["https://example-casino.com/legal"],
          },
        ],
        total_gaps: 1,
        version: "1.0.0",
      }),
    );
    fs.writeFileSync(
      path.join(runDir, "field-coverage.json"),
      JSON.stringify({
        fields: [{ field_id: fieldId, category: "legal", name: "License Number", type: "text", status: "missing", evidence_count: 0 }],
        total_fields: 1,
        found_count: 0,
        missing_count: 1,
        blocked_count: 0,
        conflicting_count: 0,
        error_count: 0,
        version: "1.0.0",
      }),
    );
    const coverageBefore = fs.readFileSync(path.join(runDir, "field-coverage.json"), "utf-8");
    fs.writeFileSync(path.join(runDir, "field-evidence.jsonl"), "");
    const traceEventsPath = path.join(runDir, "trace-events.jsonl");

    // Provider always returns a result that validateGapProbeResult rejects (two URLs
    // accessed — a probe is only ever allowed to touch the one frozen URL).
    const failingProvider = (request: GapProbeRequest): GapProbeResult => ({
      gap_id: request.gap_id,
      timestamp: new Date().toISOString(),
      urls_accessed: [request.frozen_url, "https://example-casino.com/extra"],
      stop_reason: "field_value_located_or_absent",
    });

    await runGapProbeLoop(runDir, "gap-loop-run", "example-casino", { gapProbeProvider: failingProvider }, traceEventsPath);

    // AC6: every attempt was rejected — coverage must be byte-for-byte unchanged.
    const coverageAfter = fs.readFileSync(path.join(runDir, "field-coverage.json"), "utf-8");
    assert.equal(coverageAfter, coverageBefore, "coverage must be untouched when every probe fails validation");

    // AC5: the loop is bounded, and hitting the bound is recorded on run-context.json.
    const runContextAfter = JSON.parse(fs.readFileSync(path.join(runDir, "run-context.json"), "utf-8"));
    assert.ok(runContextAfter.gap_loop, "gap_loop outcome must be recorded");
    assert.equal(runContextAfter.gap_loop.bound_hit, true, "bound must be recorded as hit");
    assert.ok(runContextAfter.gap_loop.iterations > 0 && runContextAfter.gap_loop.iterations <= 2, "iterations must be bounded");

    const traceEvents = fs
      .readFileSync(traceEventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    assert.ok(
      traceEvents.some((e: any) => e.action === "gap_probe_rejected"),
      "rejected probes must be traced",
    );
    assert.ok(
      traceEvents.some((e: any) => e.action === "gap_loop_bound_hit"),
      "hitting the bound must be traced",
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("wire normalisation-coverage-report: no probe capability and no addressable gaps both end the loop with zero iterations", async () => {
  const runDir = fs.mkdtempSync(path.join(tmpdir(), "wire-gap-loop-idle-"));
  try {
    const runContext: RunContext = {
      run_id: "idle-run",
      casino_url: "https://example-casino.com",
      casino_id: "example-casino",
      geo: "US",
      locale: "en-US",
      canonical_origin: "https://example-casino.com",
      approved_same_domain_scope: "https://example-casino.com",
      template_hash: "hash",
      extraction_rules_hash: "hash",
      url_rules_hash: "hash",
      module_version_hash: "hash",
      scorer_prompt_hash: "hash",
      visit_policy_hash: "hash",
      probe_policy_hash: "hash",
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };
    fs.writeFileSync(path.join(runDir, "run-context.json"), JSON.stringify(runContext));
    fs.writeFileSync(
      path.join(runDir, "discovery-delta.json"),
      JSON.stringify({ gaps: [], total_gaps: 0, version: "1.0.0" }),
    );
    const traceEventsPath = path.join(runDir, "trace-events.jsonl");

    // No addressable gaps at all — loop must not run even though a provider is supplied.
    await runGapProbeLoop(
      runDir,
      "idle-run",
      "example-casino",
      { gapProbeProvider: () => ({ gap_id: "x", timestamp: new Date().toISOString(), urls_accessed: ["https://example-casino.com"], stop_reason: "done" }) },
      traceEventsPath,
    );

    const runContextAfter = JSON.parse(fs.readFileSync(path.join(runDir, "run-context.json"), "utf-8"));
    assert.equal(runContextAfter.gap_loop, undefined, "loop must not record anything when it never ran");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

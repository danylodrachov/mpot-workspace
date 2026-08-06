import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { stageDispatcher, resumeAfterRelevanceScoring, type StageDispatchGate } from "./stage-dispatcher.ts";
import type { ScorerOutput, FieldRequirement, ClassifiedUrl, FieldRelevanceScore } from "./url-field-relevance-scorer.types.ts";

/**
 * Black-box test: runs the real dispatcher through stages 1-5 with recorded
 * fixture HTML, reaches the stage 6 gate, and drives it through
 * `resumeAfterRelevanceScoring` exactly as the thin launcher skill would.
 *
 * Verifies acceptance criteria against real artifacts written to disk by the
 * dispatcher and coordinator — never by asserting fixtures the test wrote itself.
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
  const outputDir = path.join(tmpdir(), `relevance-gate-e2e-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `relevance-gate-inputs-${crypto.randomUUID()}`);
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
      '<a href="/slots">Slots</a><a href="/sports">Sports</a><a href="/terms">Terms</a>',
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

function scoreAllLikely(gate: StageDispatchGate): ScorerOutput {
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

test("stage 6 gate carries only field requirements, classified URLs, provenance/mandatory flags", async () => {
  const { gate, cleanup } = await reachStage6();
  try {
    assert.ok(Array.isArray(gate.gate.field_requirements) && gate.gate.field_requirements.length > 0);
    assert.ok(Array.isArray(gate.gate.classified_urls) && gate.gate.classified_urls.length > 0);

    const allowedKeys = new Set(["run_id", "stage", "field_requirements", "classified_urls", "request_id", "timestamp"]);
    for (const key of Object.keys(gate.gate)) {
      assert.ok(allowedKeys.has(key), `gate payload leaked an unexpected key: ${key}`);
    }

    for (const url of gate.gate.classified_urls) {
      assert.ok("isMandatory" in url, "each classified URL should carry mandatory flag");
      assert.ok("source" in url, "each classified URL should carry provenance/source");
    }
  } finally {
    cleanup();
  }
});

test("valid scorer reply: persisted verbatim, validated, and produces a real visit plan through stage 8", async () => {
  const { gate, cleanup } = await reachStage6();
  try {
    const scorerReply = scoreAllLikely(gate);

    const outcome = await resumeAfterRelevanceScoring(gate, scorerReply);

    const rawPath = path.join(gate.run_dir, "url-field-relevance.raw.json");
    assert.ok(fs.existsSync(rawPath), "raw scorer reply must be persisted");
    assert.deepEqual(JSON.parse(fs.readFileSync(rawPath, "utf-8")), scorerReply, "raw artifact must match reply verbatim");

    const validatedMatrix = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "url-field-relevance.json"), "utf-8"));
    assert.equal(validatedMatrix.length, gate.gate.classified_urls.length * gate.gate.field_requirements.length);

    const visitPlan = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "visit-plan.json"), "utf-8"));
    assert.equal(visitPlan.length, gate.gate.classified_urls.length, "every classified URL appears in the visit plan");
    assert.ok(visitPlan.every((v: any) => v.selected === true), "all-likely scores should select every URL");

    // Dispatcher continued through the ordinary transition rules, not a special-cased resume.
    assert.ok(!("needs_llm" in outcome) || (outcome as any).needs_llm === false);
    assert.ok(!(outcome as any).pending_stages?.includes(6), "stage 6 no longer pending after resume");
    assert.ok(!(outcome as any).pending_stages?.includes(7), "stage 7 no longer pending after resume");
  } finally {
    cleanup();
  }
});

test("malformed scorer reply is retained for audit and the run fails open", async () => {
  const { gate, cleanup } = await reachStage6();
  try {
    // Missing pairs, duplicate pair, out-of-range probability, unknown class.
    const firstUrl = gate.gate.classified_urls[0];
    const firstField = gate.gate.field_requirements[0];
    const malformedReply: ScorerOutput = {
      scores: [
        { url_id: firstUrl.url_id, field_id: firstField.field_id, probability: 1.5, class: "likely", reason: "bad probability" },
        { url_id: firstUrl.url_id, field_id: firstField.field_id, probability: 0.5, class: "made_up_class" as any, reason: "duplicate + unknown class" },
      ],
      request_id: gate.gate.request_id,
      total_pairs_evaluated: 2,
      timestamp: new Date().toISOString(),
    };

    await resumeAfterRelevanceScoring(gate, malformedReply);

    const rawPath = path.join(gate.run_dir, "url-field-relevance.raw.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(rawPath, "utf-8")), malformedReply, "malformed reply retained verbatim for audit");

    const visitPlan = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "visit-plan.json"), "utf-8"));
    assert.equal(visitPlan.length, gate.gate.classified_urls.length, "fail-open keeps every candidate URL eligible");
    assert.ok(visitPlan.every((v: any) => v.selected === true), "fail-open selects every URL");

    const events = fs
      .readFileSync(path.join(gate.run_dir, "trace-events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.ok(
      events.some((e) => e.action === "validation_failed" || e.action === "fail_open"),
      "trace must record the fail-open"
    );
  } finally {
    cleanup();
  }
});

test("mandatory pages appear in the visit plan regardless of scorer verdict", async () => {
  const { gate, cleanup } = await reachStage6();
  try {
    const mandatoryUrl = gate.gate.classified_urls.find((u) => u.isMandatory);
    assert.ok(mandatoryUrl, "fixture must contain at least one mandatory URL (deposit/withdrawal)");

    // Scorer marks every URL, including the mandatory one, as irrelevant.
    const scores: FieldRelevanceScore[] = [];
    for (const url of gate.gate.classified_urls) {
      for (const field of gate.gate.field_requirements) {
        scores.push({
          url_id: url.url_id,
          field_id: field.field_id,
          probability: 0.0,
          class: "irrelevant",
          reason: "scorer considers this URL irrelevant to every field",
        });
      }
    }
    const scorerReply: ScorerOutput = {
      scores,
      request_id: gate.gate.request_id,
      total_pairs_evaluated: scores.length,
      timestamp: new Date().toISOString(),
    };

    await resumeAfterRelevanceScoring(gate, scorerReply);

    const visitPlan = JSON.parse(fs.readFileSync(path.join(gate.run_dir, "visit-plan.json"), "utf-8"));
    const mandatoryEntry = visitPlan.find((v: any) => v.url_id === mandatoryUrl!.url_id);
    assert.ok(mandatoryEntry, "mandatory URL must be present in the visit plan");
    assert.equal(mandatoryEntry.selected, true, "mandatory URL must be selected despite an all-irrelevant scorer verdict");
  } finally {
    cleanup();
  }
});

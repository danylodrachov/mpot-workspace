import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { stageDispatcher, resumeAfterRelevanceScoring, type StageDispatchGate } from "./stage-dispatcher.ts";
import type { ScorerOutput, FieldRelevanceScore } from "./url-field-relevance-scorer.types.ts";
import type { PageObservationProvider } from "./page-interactivity-profiler.ts";
import type { InteractionObservationProvider, InteractionRecord } from "./interaction-delta-profiler.ts";
import type { ProductObservationProvider } from "./url-map-recon/product-collector.ts";

/**
 * Black-box test for stages 8-13 (collection segment): drives the real dispatcher
 * from stage 1 through the stage 6 gate, resumes it exactly as the thin launcher
 * would, and lets the real behaviour profiler / interaction profiler / field
 * collector / product collector write their own artifacts to disk. Assertions
 * read only what the pipeline itself produced — nothing here is fabricated by
 * the test.
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
  const outputDir = path.join(tmpdir(), `wire-collection-e2e-${crypto.randomUUID()}`);
  const inputDir = path.join(tmpdir(), `wire-collection-inputs-${crypto.randomUUID()}`);
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

/** Scores every URL as likely for every field except /rules, which is marked irrelevant. */
function scoreExcludingTerms(gate: StageDispatchGate): ScorerOutput {
  const scores: FieldRelevanceScore[] = [];
  for (const url of gate.gate.classified_urls) {
    const isRules = url.canonicalUrl.includes("/rules");
    for (const field of gate.gate.field_requirements) {
      scores.push({
        url_id: url.url_id,
        field_id: field.field_id,
        probability: isRules ? 0.0 : 0.8,
        class: isRules ? "irrelevant" : "likely",
        reason: isRules ? "terms page is not field-relevant" : "URL structure suggests relevance",
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

// Fixture page-observation provider: real, distinctive data the URL-only detector
// would never invent (custom content structure, a filter control, a declared
// total_count that exceeds visible_count to exercise the truncation marker).
const pageObservationProvider: PageObservationProvider = (url: string) => {
  if (url.includes("/slots")) {
    return {
      url,
      rendering: "js_loaded",
      content_structure: "custom",
      collection: { type: "pagination", visible_count: 20, total_count: 500 },
      interactive_elements: [{ type: "filter", selector: ".slot-filter", effect: "filters game list" }],
    } as any;
  }
  if (url.includes("/sports")) {
    return {
      url,
      rendering: "static_html",
      content_structure: "custom",
      collection: { type: "static_list", visible_count: 12, total_count: 12 },
    } as any;
  }
  return {
    url,
    rendering: "static_html",
    content_structure: "custom",
    collection: { type: "static_list", visible_count: 3, total_count: 3 },
  } as any;
};

// Fixture interaction-observation provider: one record carries a secret header
// and a secret form field to prove redaction actually strips them, alongside a
// benign field that must survive redaction untouched.
const interactionObservationProvider: InteractionObservationProvider = (url: string): InteractionRecord =>
  ({
    url_id: url,
    canonical_url: url,
    baseline_state: { note: "fixture-baseline", visible_elements_count: 4 },
    probes: [
      { type: "playwright", detector_id: "PLAYWRIGHT_PROBE_V1", timestamp: new Date().toISOString(), result: "completed" },
    ],
    stop_reason: "evidence_sufficient",
    timestamp: new Date().toISOString(),
    headers: { Authorization: "Bearer super-secret-token-value", "X-Request-Id": "keep-me" },
    form_data: { password: "hunter2-secret", search_query: "keep-me-too" },
  }) as any;

const productObservationProvider: ProductObservationProvider = (section, _url) => {
  if (section === "slots") {
    return [
      { name: "Book of Aztec", url: null },
      { name: "Starburst", url: null },
      { name: "Team A vs Team B", url: null }, // fixture-shaped — must be excluded (AC8)
    ];
  }
  if (section === "sports") {
    return [
      { name: "Football", url: null },
      { name: "Tennis", url: null },
    ];
  }
  return [];
};

async function driveToCollectionSegment() {
  const { gate, cleanup } = await reachStage6();
  const scorerReply = scoreExcludingTerms(gate);
  const outcome = await resumeAfterRelevanceScoring(gate, scorerReply, {
    pageObservationProvider,
    interactionObservationProvider,
    productObservationProvider,
  });
  return { gate, outcome, cleanup };
}

test("stages 8-13 produce real behaviour profile, interaction records, field evidence, and product candidates", async () => {
  const { gate, cleanup } = await driveToCollectionSegment();
  try {
    const runDir = gate.run_dir;

    // AC1: none of these are hand-written by the test — the dispatcher wrote them.
    const behaviorPath = path.join(runDir, "page-behavior.json");
    const interactionsPath = path.join(runDir, "interaction-records.json");
    const evidencePath = path.join(runDir, "field-evidence.jsonl");
    const productsPath = path.join(runDir, "product-candidates.json");
    for (const p of [behaviorPath, interactionsPath, evidencePath, productsPath]) {
      assert.ok(fs.existsSync(p), `expected artifact missing: ${p}`);
    }

    // AC2: behaviour reflects the injected provider's distinctive value, not a
    // URL-derived default (the URL-only fallback always produces content_structure 'list').
    const behavior = JSON.parse(fs.readFileSync(behaviorPath, "utf-8"));
    const slotsSection = behavior.sections.slots;
    assert.equal(slotsSection.content_structure, "custom", "behaviour must come from the injected provider");
    assert.equal(slotsSection.rendering, "js_loaded");

    // AC6: truncated collection (500 total vs 20 visible) is explicitly marked, and a
    // complete collection (sports: 12 vs 12) is distinguishable from it.
    const evidenceRows = fs
      .readFileSync(evidencePath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const slotsRows = evidenceRows.filter((r: any) => r.url.includes("/slots"));
    const sportsRows = evidenceRows.filter((r: any) => r.url.includes("/sports"));
    assert.ok(slotsRows.length > 0, "slots page should produce evidence rows");
    assert.ok(sportsRows.length > 0, "sports page should produce evidence rows");
    assert.ok(slotsRows.every((r: any) => r.truncated === true), "slots collection is truncated (500 total / 20 visible)");
    assert.ok(sportsRows.every((r: any) => r.truncated === false), "sports collection is complete (12 total / 12 visible)");

    // AC4: every evidence row maps to an existing field id, an exact URL inside
    // approved scope, and carries an extraction rule id.
    const validFieldIds = new Set(gate.gate.field_requirements.map((f) => f.field_id));
    const validUrls = new Set(gate.gate.classified_urls.map((u) => u.canonicalUrl));
    for (const row of evidenceRows) {
      assert.ok(validFieldIds.has(row.field_id), `unknown field_id ${row.field_id}`);
      assert.ok(validUrls.has(row.url), `URL ${row.url} outside approved scope`);
      assert.ok(row.extraction_rule_id, "row missing extraction_rule_id");
    }

    // AC5: /rules was scored irrelevant and therefore never selected in the visit
    // plan — it must produce no evidence and no behaviour section at all.
    const visitPlan = JSON.parse(fs.readFileSync(path.join(runDir, "visit-plan.json"), "utf-8"));
    const rulesEntry = visitPlan.find((v: any) => v.canonicalUrl.includes("/rules"));
    assert.ok(rulesEntry && rulesEntry.selected === false, "terms page should not be selected");
    const rulesEvidence = evidenceRows.filter((r: any) => r.url.includes("/rules"));
    assert.equal(rulesEvidence.length, 0, "unselected page must produce no evidence");
    assert.ok(!JSON.stringify(behavior).includes("/rules"), "unselected page must have no behaviour section");

    // AC7: redaction ran before persistence — secret values are gone, benign ones survive.
    const interactionsRaw = fs.readFileSync(interactionsPath, "utf-8");
    assert.ok(!interactionsRaw.includes("super-secret-token-value"), "auth token must be redacted");
    assert.ok(!interactionsRaw.includes("hunter2-secret"), "password must be redacted");
    assert.ok(interactionsRaw.includes("keep-me"), "non-sensitive header value must survive redaction");
    assert.ok(interactionsRaw.includes("keep-me-too"), "non-sensitive form value must survive redaction");

    // AC8: product output stops at titles; the fixture-shaped "Team A vs Team B"
    // entry must never appear, and only sports/live-casino/slots sections exist.
    const products = JSON.parse(fs.readFileSync(productsPath, "utf-8"));
    assert.ok(!JSON.stringify(products).includes("Team A vs Team B"), "individual fixture must be excluded");
    const slotsProducts = products.sections.find((s: any) => s.section === "slots");
    assert.ok(slotsProducts.items.some((i: any) => i.title === "Book of Aztec"));
    assert.ok(slotsProducts.items.every((i: any) => !i.title.includes(" vs ")));

    // AC9: stages 8-13 report real completed outcomes, not pending.
    const traceEvents = fs
      .readFileSync(path.join(runDir, "trace-events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    for (const stage of [8, 9, 10, 11, 12, 13]) {
      const events = traceEvents.filter((e: any) => e.stage === stage);
      assert.ok(events.length > 0, `no trace event for stage ${stage}`);
      assert.ok(events.every((e: any) => e.status === "completed"), `stage ${stage} did not complete`);
    }
  } finally {
    cleanup();
  }
});

test("field and product collection refuse to run before behaviour instructions exist", async () => {
  const { collectFieldEvidence } = await import("./field-collector.ts");
  const { collectAndPersistProductCandidates } = await import("./url-map-recon/product-collector.ts");

  const runDir = fs.mkdtempSync(path.join(tmpdir(), "wire-collection-no-behavior-"));
  try {
    const fieldRequirementsPath = path.join(runDir, "field-requirements.json");
    const visitPlanPath = path.join(runDir, "visit-plan.json");
    fs.writeFileSync(
      fieldRequirementsPath,
      JSON.stringify({
        fields: [{ field_id: "casino_games:game_titles", category: "casino_games", name: "game_titles", type: "text" }],
      })
    );
    fs.writeFileSync(
      visitPlanPath,
      JSON.stringify([
        {
          url_id: "u1",
          canonicalUrl: "https://example-casino.com/slots",
          selected: true,
          selectionReason: "t",
          totalRelevantFields: 1,
          totalIrrelevantFields: 0,
        },
      ])
    );

    const missingBehaviorPath = path.join(runDir, "page-behavior.json");
    assert.ok(!fs.existsSync(missingBehaviorPath));

    await assert.rejects(
      () =>
        collectFieldEvidence(fieldRequirementsPath, missingBehaviorPath, path.join(runDir, "field-evidence.jsonl"), visitPlanPath),
      /behaviour instructions/i,
      "field collection must fail with a clear reason"
    );

    await assert.rejects(
      () => collectAndPersistProductCandidates(missingBehaviorPath, visitPlanPath, path.join(runDir, "product-candidates.json")),
      /behaviour instructions/i,
      "product collection must fail with a clear reason"
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

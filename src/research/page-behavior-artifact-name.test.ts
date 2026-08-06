// Issue 28 — canonical page-behavior artifact name.
//
// Locks down that ONE shared constant resolves to "page-behavior.json", that the
// artifact-ownership registry and every direct consumer resolve the SAME path a real
// producer run writes to, and that a missing artifact produces the existing typed
// missing-artifact error rather than a wrong-filename mismatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PAGE_BEHAVIOR_ARTIFACT, ARTIFACT_OWNERS } from './discovery-types.ts';
import { profilePages, type PageObservationProvider } from './page-interactivity-profiler.ts';
import { executeInteractions } from './interaction-delta-profiler.ts';
import { collectFieldEvidence } from './field-collector.ts';
import { collectAndPersistProductCandidates } from './url-map-recon/product-collector.ts';
import type { RunContext } from './discovery-orchestrator.ts';
import type { VisitPlanEntry } from './relevance-validator.ts';
import type { SectionBehavior } from './url-map-recon/types.ts';
import type { FieldRequirementsOutput } from './template-requirements.ts';

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'page-behavior-artifact-name-test-'));
}

function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const runContext: RunContext = {
  run_id: 'run-1',
  casino_url: 'https://test.example.com/',
  casino_id: 'test-casino',
  geo: 'BR',
  locale: 'pt-BR',
  canonical_origin: 'https://test.example.com',
  approved_same_domain_scope: 'https://test.example.com',
  template_hash: 'hash-template',
  extraction_rules_hash: 'hash-rules',
  url_rules_hash: 'hash-url',
  module_version_hash: 'hash-module',
  scorer_prompt_hash: 'hash-scorer',
  visit_policy_hash: 'hash-visit',
  probe_policy_hash: 'hash-probe',
  timestamp: new Date().toISOString(),
  authentication_disabled: true,
};

const visitPlan: VisitPlanEntry[] = [
  {
    url_id: 'sports-1',
    canonicalUrl: 'https://test.example.com/sports',
    pageClass: 'sports',
    selected: true,
    selectionReason: 'mandatory',
    totalRelevantFields: 3,
    totalIrrelevantFields: 0,
  },
];

const sportsBehavior: SectionBehavior = {
  url: 'https://test.example.com/sports',
  rendering: 'js_loaded',
  content_structure: 'tabs',
  collection: { type: 'static_list', visible_count: 10 },
};

const fieldRequirements: FieldRequirementsOutput = {
  version: '1.0.0',
  fields: [
    {
      field_id: 'live_dealer_games',
      category: 'casino_games',
      name: 'Live Dealer Games',
      type: 'text',
      extraction_rule_ids: ['COLLECTION_PRODUCTS_V1'],
    },
  ],
};

test('AC: one shared constant resolves to page-behavior.json and the registry uses it exclusively', () => {
  assert.equal(PAGE_BEHAVIOR_ARTIFACT, 'page-behavior.json');

  const matching = ARTIFACT_OWNERS.filter((entry) => entry.artifact === PAGE_BEHAVIOR_ARTIFACT);
  assert.equal(matching.length, 1, 'registry must declare exactly one page-behavior.json entry');

  const stale = ARTIFACT_OWNERS.filter((entry) => entry.artifact === 'page-behavior-profile.json');
  assert.equal(stale.length, 0, 'registry must not retain the old page-behavior-profile.json name');
});

test('AC: producer writes page-behavior.json and every direct consumer reads that same path', async () => {
  const runDir = createTestDir();
  try {
    // Producer path: real profilePages() run (Stage 11).
    const provider: PageObservationProvider = (url) =>
      url === 'https://test.example.com/sports' ? sportsBehavior : null;
    await profilePages(visitPlan, runContext, runDir, provider);

    const canonicalPath = path.join(runDir, PAGE_BEHAVIOR_ARTIFACT);
    assert.ok(fs.existsSync(canonicalPath), 'producer must write to the canonical page-behavior.json path');
    assert.ok(!fs.existsSync(path.join(runDir, 'page-behavior-profile.json')), 'producer must not also write the stale name');

    // Consumer 1: interaction-delta-profiler (Stage 12) — must find the file the producer wrote.
    const interactionResult = await executeInteractions(visitPlan, runContext, runDir, (url) =>
      url === 'https://test.example.com/sports'
        ? { url_id: 'sports-1', canonical_url: url, timestamp: new Date().toISOString() }
        : null
    );
    assert.equal(interactionResult.interactions.length, 1);

    // Consumer 2: field-collector (Stage 13) — reads canonicalPath directly.
    const fieldReqPath = path.join(runDir, 'field-requirements.json');
    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements));
    const fieldEvidencePath = path.join(runDir, 'field-evidence.jsonl');
    await collectFieldEvidence(fieldReqPath, canonicalPath, fieldEvidencePath);
    assert.ok(fs.existsSync(fieldEvidencePath), 'field-collector must have run against the producer-written file');

    // Consumer 3: product-collector (Stage 13) — reads canonicalPath directly.
    const visitPlanPath = path.join(runDir, 'visit-plan.json');
    fs.writeFileSync(visitPlanPath, JSON.stringify(visitPlan));
    const productCandidatesPath = path.join(runDir, 'product-candidates.json');
    await collectAndPersistProductCandidates(canonicalPath, visitPlanPath, productCandidatesPath, (section, url) =>
      section === 'sports' && url === 'https://test.example.com/sports'
        ? [{ name: 'Football' }, { name: 'Basketball' }]
        : []
    );
    assert.ok(fs.existsSync(productCandidatesPath), 'product-collector must have run against the producer-written file');
    const products = JSON.parse(fs.readFileSync(productCandidatesPath, 'utf-8'));
    assert.ok(JSON.stringify(products).includes('Football'));
  } finally {
    cleanupTestDir(runDir);
  }
});

test('AC: missing page-behavior.json produces the existing typed missing-artifact error, not a wrong-name mismatch', async () => {
  const runDir = createTestDir();
  try {
    const missingPath = path.join(runDir, PAGE_BEHAVIOR_ARTIFACT);
    assert.ok(!fs.existsSync(missingPath));

    // field-collector's typed guard (AC3 of issue 13) must still fire against the canonical name.
    const fieldReqPath = path.join(runDir, 'field-requirements.json');
    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements));
    await assert.rejects(
      () => collectFieldEvidence(fieldReqPath, missingPath, path.join(runDir, 'field-evidence.jsonl')),
      (err: Error) => {
        assert.match(err.message, /page-behavior\.json not found/);
        assert.doesNotMatch(err.message, /page-behavior-profile\.json/);
        return true;
      }
    );

    // executeInteractions' typed guard (Stage 12) must also fire against the canonical name.
    await assert.rejects(
      () => executeInteractions(visitPlan, runContext, runDir),
      (err: Error) => {
        assert.match(err.message, /page-behavior\.json not found/);
        return true;
      }
    );
  } finally {
    cleanupTestDir(runDir);
  }
});

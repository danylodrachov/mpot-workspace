import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeReviewInput } from './review-input.ts';
import { PostRunReviewGateError } from './post-run-review.ts';
import type {
  ExecutedCandidateRow,
  InteractionCandidateRecord,
  NetworkEvidenceRecord,
  ObservationCandidateRow,
  VisitedPageRecord,
} from './types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-input-test-'));
}

function makeVisitedPage(overrides: Partial<VisitedPageRecord> = {}, dir: string): VisitedPageRecord {
  const htmlPath = path.join(dir, 'promotions.html');
  const tracePath = path.join(dir, 'promotions.trace.json');
  fs.writeFileSync(htmlPath, '<html><body>Promotions</body></html>');
  fs.writeFileSync(tracePath, '{}');
  return {
    requestedUrl: 'https://example.test/promotions',
    finalUrl: 'https://example.test/promotions',
    status: 'visited',
    htmlPath,
    tracePath,
    discoveredBy: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 10,
    errorPageClassification: 'ok',
    ...overrides,
  };
}

// FIX-06 acceptance (a): a fact that exists only in captured network JSON, never in the visible
// baseline HTML/trace text, must still be visible to the post-run reviewer via pageEvidence.
test('FIX-06: a fact only present in captured network JSON is exposed on the per-page evidence graph', async () => {
  const dir = tmpDir();
  const page = makeVisitedPage({}, dir);
  const bodyPath = path.join(dir, 'promo-body.json');
  fs.writeFileSync(bodyPath, JSON.stringify({ welcomeBonus: '100% up to $500' }));

  const networkEvidenceRecords: NetworkEvidenceRecord[] = [
    {
      schemaVersion: '1.0',
      observedOnPageUrl: page.requestedUrl,
      requestUrl: 'https://example.test/api/v3/promotion/list',
      requestMethod: 'GET',
      resourceType: 'xhr',
      status: 200,
      contentType: 'application/json',
      capturedAt: new Date().toISOString(),
      bodyPath,
      bodySha256: 'abc',
      bodyBytes: 40,
      outcome: 'captured',
    },
  ];

  const reviewInputPath = path.join(dir, 'review-input.json');
  await writeReviewInput(reviewInputPath, {
    runId: 'run-1',
    entryUrl: 'https://example.test/',
    visited: [page],
    decisions: [],
    networkEvidenceRecords,
  });

  const written = JSON.parse(fs.readFileSync(reviewInputPath, 'utf-8'));
  assert.equal(written.schemaVersion, '1.4');
  assert.equal(written.pageEvidence.length, 1);
  const pageEvidence = written.pageEvidence[0];
  assert.equal(pageEvidence.requestedUrl, page.requestedUrl);
  assert.deepEqual(pageEvidence.evidenceSources.sort(), ['html', 'network']);
  assert.equal(pageEvidence.networkEvidenceRecords[0].bodyPath, bodyPath);
  assert.equal(pageEvidence.networkEvidenceRecords[0].requestUrl, 'https://example.test/api/v3/promotion/list');
});

// FIX-06 acceptance (b) + (c): a fact revealed only by an approved bounded_reveal interaction is
// linked to that action record via interactionStateRecords, and a passive observation candidate
// can never appear there tagged as executed/interaction_state evidence.
test('FIX-06: interactionStateRecords only ever contains a real executed bounded_reveal record, never a passive candidate', async () => {
  const dir = tmpDir();
  const page = makeVisitedPage({}, dir);

  const executedCandidate: ExecutedCandidateRow = {
    tag: 'button',
    role: 'tab',
    name: 'Bonuses',
    domPath: 'body > div > button:nth-child(1)',
    label: 'revealed_evidence',
    actionClass: 'tab',
  };
  const observationCandidate: ObservationCandidateRow = {
    tag: 'button',
    role: 'button',
    name: 'Show more',
    domPath: 'body > div > button:nth-child(2)',
    label: 'detected_candidate_only',
  };

  const interactionRecords: InteractionCandidateRecord[] = [
    {
      schemaVersion: '1.0',
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      capturedAt: new Date().toISOString(),
      interactionMode: 'bounded_reveal',
      candidateCount: 2,
      candidates: [executedCandidate, observationCandidate],
    },
  ];

  const reviewInputPath = path.join(dir, 'review-input.json');
  await writeReviewInput(reviewInputPath, {
    runId: 'run-2',
    entryUrl: 'https://example.test/',
    visited: [page],
    decisions: [],
    interactionRecords,
  });

  const written = JSON.parse(fs.readFileSync(reviewInputPath, 'utf-8'));
  const pageEvidence = written.pageEvidence[0];
  assert.equal(pageEvidence.interactionStateRecords.length, 1);
  assert.equal(pageEvidence.interactionStateRecords[0].label, 'revealed_evidence');
  assert.equal(pageEvidence.interactionStateRecords[0].actionClass, 'tab');
  assert.ok(pageEvidence.evidenceSources.includes('interaction_state'));

  // The passive observation candidate (detected_candidate_only, no actionClass) never leaks in.
  const leaked = pageEvidence.interactionStateRecords.some((row: { name?: string }) => row.name === 'Show more');
  assert.equal(leaked, false, 'a passive candidate must never appear as an interaction_state evidence row');
});

// FIX-06 acceptance (d): a missing referenced evidence file must fail the review gate, not be
// silently dropped/ignored.
test('FIX-06: a missing htmlSnapshotPath file fails the review gate instead of being silently skipped', async () => {
  const dir = tmpDir();
  const page = makeVisitedPage({}, dir);
  fs.unlinkSync(page.htmlPath!);

  const reviewInputPath = path.join(dir, 'review-input.json');
  await assert.rejects(
    async () =>
      writeReviewInput(reviewInputPath, {
        runId: 'run-3',
        entryUrl: 'https://example.test/',
        visited: [page],
        decisions: [],
      }),
    PostRunReviewGateError,
  );
  assert.equal(fs.existsSync(reviewInputPath), false, 'review-input.json must never be written when a referenced evidence file is dangling');
});

// FIX-06 acceptance (e): absent/blocked/unsupported evidence stays distinct from positive facts —
// representable in the schema itself (errorPageClassification / label vocabulary), not just prose.
test('FIX-06: blocked/unsupported executed outcomes remain distinct from positive (revealed_evidence) facts', async () => {
  const dir = tmpDir();
  const page = makeVisitedPage({ errorPageClassification: 'suspected_error_page', errorPageSignals: ['title_matches_generic_error_marker:Not Found'], errorPageReason: 'ambiguous content-only error markers' }, dir);

  const blockedCandidate: ExecutedCandidateRow = {
    tag: 'select',
    role: 'listbox',
    name: 'Currency',
    domPath: 'body > select',
    label: 'blocked',
    actionClass: 'native_select_enumeration',
  };
  const interactionRecords: InteractionCandidateRecord[] = [
    {
      schemaVersion: '1.0',
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      capturedAt: new Date().toISOString(),
      interactionMode: 'bounded_reveal',
      candidateCount: 1,
      candidates: [blockedCandidate],
    },
  ];

  const reviewInputPath = path.join(dir, 'review-input.json');
  await writeReviewInput(reviewInputPath, {
    runId: 'run-4',
    entryUrl: 'https://example.test/',
    visited: [page],
    decisions: [],
    interactionRecords,
  });

  const written = JSON.parse(fs.readFileSync(reviewInputPath, 'utf-8'));
  const pageEvidence = written.pageEvidence[0];
  assert.equal(pageEvidence.errorPageClassification, 'suspected_error_page');
  assert.ok(pageEvidence.errorPageSignals.length > 0);
  assert.equal(pageEvidence.interactionStateRecords[0].label, 'blocked');
  assert.notEqual(pageEvidence.interactionStateRecords[0].label, 'revealed_evidence');
});

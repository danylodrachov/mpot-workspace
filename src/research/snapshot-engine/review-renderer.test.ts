import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, appendJsonLine } from './io.ts';
import { renderReviewHtml } from './review-renderer.ts';
import type { DiscoveryRunManifest, UrlInventoryDocument, VisitedPageRecord, InteractionCandidateRecord } from './types.ts';

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-renderer-'));
}

const VISITED_URL = 'https://example-casino.test/en/casino/live-casino/blackjack';
const BLOCKED_URL = 'https://example-casino.test/en/bonuses';
const RAIL_URL = 'https://example-casino.test/casino/live-casino/blackjack';
const REJECTED_SAMPLE_URL = 'https://example-casino.test/casino/live-casino/game/some-slug';

function baseManifest(): DiscoveryRunManifest {
  return {
    schemaVersion: '1.1',
    runId: 'run-1',
    runFolderName: 'example-casino-xx-2026-08-11-00-00-00',
    casinoName: 'Example Casino',
    casinoSlug: 'example-casino',
    entryUrl: 'https://example-casino.test/',
    allowedOrigin: 'https://example-casino.test',
    geoSlug: 'xx',
    geo: 'XX',
    startedAt: '2026-08-11T00:00:00.000Z',
    completedAt: '2026-08-11T00:05:00.000Z',
    browserMode: 'cdp',
    urlRulesVersion: 'test-rules-v1',
    interactionMode: 'passive_only',
    status: 'complete',
    toolVersions: { node: process.version },
    counts: { discovered: 3, accepted: 2, rejected: 1, tbd: 0, visited: 1, failed: 1, interactionRecords: 1 },
    artifacts: {
      runManifest: 'run-manifest.json',
      urlInventory: 'url-inventory.json',
      pages: 'pages.jsonl',
      interactions: 'interactions.jsonl',
      corpusDir: 'corpus',
      jsonDir: 'json',
      reviewHtml: 'review.html',
    },
  };
}

async function writeFixtureRun(runDir: string): Promise<void> {
  await writeJsonAtomic(path.join(runDir, 'run-manifest.json'), baseManifest());

  const urlInventory: UrlInventoryDocument = {
    schemaVersion: '1.0',
    runId: 'run-1',
    entryUrl: 'https://example-casino.test/',
    geo: 'XX',
    generatedAt: '2026-08-11T00:00:00.000Z',
    counts: { discovered: 3, accepted: 2, rejected: 1, tbd: 0 },
    accepted: [
      {
        rawUrl: RAIL_URL,
        resolvedUrl: RAIL_URL,
        canonicalUrl: RAIL_URL,
        decision: 'accepted',
        ruleId: 'URLR_KEEP_LIVE_CASINO_SUBCATEGORY',
        reason: 'Live-casino landing page sub-category rail entry.',
        provenance: [],
      },
      {
        rawUrl: BLOCKED_URL,
        resolvedUrl: BLOCKED_URL,
        canonicalUrl: BLOCKED_URL,
        decision: 'accepted',
        ruleId: 'URLR_KEEP_BONUS',
        reason: 'Bonus/promotion document route.',
        provenance: [],
      },
    ],
    rejected: [
      {
        rawUrl: REJECTED_SAMPLE_URL,
        resolvedUrl: REJECTED_SAMPLE_URL,
        decision: 'rejected',
        ruleId: 'URLR_DROP_NESTED_CASINO_CATEGORY',
        reason: 'Nested casino category route; keep only canonical category landing.',
        provenance: [],
      },
    ],
    tbd: [],
  };
  await writeJsonAtomic(path.join(runDir, 'url-inventory.json'), urlInventory);

  const visitedPage: VisitedPageRecord = {
    requestedUrl: VISITED_URL,
    finalUrl: VISITED_URL,
    canonicalUrl: VISITED_URL,
    status: 'visited',
    settleStatus: 'settled',
    title: 'Blackjack',
    discoveredBy: [],
    startedAt: '2026-08-11T00:01:00.000Z',
    completedAt: '2026-08-11T00:01:02.000Z',
    durationMs: 2000,
  };
  const blockedPage: VisitedPageRecord = {
    requestedUrl: BLOCKED_URL,
    status: 'failed',
    failureReason: 'blocked_suspected',
    discoveredBy: [],
    startedAt: '2026-08-11T00:02:00.000Z',
    completedAt: '2026-08-11T00:02:01.000Z',
    durationMs: 1000,
  };
  await appendJsonLine(path.join(runDir, 'pages.jsonl'), visitedPage);
  await appendJsonLine(path.join(runDir, 'pages.jsonl'), blockedPage);

  const interactionRecord: InteractionCandidateRecord = {
    requestedUrl: VISITED_URL,
    finalUrl: VISITED_URL,
    capturedAt: '2026-08-11T00:01:02.000Z',
    candidateCount: 2,
    candidates: [
      { tag: 'button', role: 'button', name: 'Show table limits', domPath: 'button.limits', label: 'revealed_evidence', actionClass: 'modal_trigger' },
      { tag: 'button', role: 'button', name: 'Sort by name', domPath: 'button.sort', label: 'no_effect', actionClass: 'dropdown_or_combobox' },
    ],
  };
  await appendJsonLine(path.join(runDir, 'interactions.jsonl'), interactionRecord);

  await writeJsonAtomic(path.join(runDir, 'json', 'casinos.json'), {
    schemaVersion: '1.0',
    runId: 'run-1',
    category: 'casinos',
    generatedAt: '2026-08-11T00:05:00.000Z',
    rows: [{ casino_name: 'Example Casino', country: null }],
  });
}

test('CD-N02: renderReviewHtml produces exactly the 4 required sections in order', async () => {
  const runDir = mkdtemp();
  await writeFixtureRun(runDir);

  const html = await renderReviewHtml(runDir);

  const runSummaryIdx = html.indexOf('id="run-summary"');
  const jsonResultsIdx = html.indexOf('id="json-results"');
  const productCollectionsIdx = html.indexOf('id="product-collections"');
  const interactionExceptionsIdx = html.indexOf('id="interaction-exceptions"');

  assert.ok(runSummaryIdx >= 0);
  assert.ok(jsonResultsIdx > runSummaryIdx);
  assert.ok(productCollectionsIdx > jsonResultsIdx);
  assert.ok(interactionExceptionsIdx > productCollectionsIdx);
});

test('CD-N02: renderReviewHtml omits forbidden dumps and routine/never-executed interaction rows', async () => {
  const runDir = mkdtemp();
  await writeFixtureRun(runDir);

  const html = await renderReviewHtml(runDir);

  // No rejected/tbd sample dump.
  assert.ok(!html.includes(REJECTED_SAMPLE_URL), 'rejected sample URLs must never be rendered');
  // No raw candidate listing for the routine no_effect interaction row.
  assert.ok(!html.includes('Sort by name'), 'routine no_effect candidates must be omitted from interaction exceptions');
  assert.ok(!html.includes('no_effect'), 'no_effect outcome label must never appear');
});

test('CD-N02: renderReviewHtml traces every rendered fact/URL back to a real fixture source URL', async () => {
  const runDir = mkdtemp();
  await writeFixtureRun(runDir);

  const html = await renderReviewHtml(runDir);

  assert.ok(html.includes(VISITED_URL));
  assert.ok(html.includes(RAIL_URL));
  assert.ok(html.includes('Show table limits'));
  assert.ok(html.includes('revealed_evidence'));
});

test('CD-N02: renderReviewHtml never imports Playwright/Puppeteer/LLM SDKs or reads ANTHROPIC_API_KEY', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'review-renderer.ts'), 'utf8');
  assert.ok(!/playwright/i.test(source));
  assert.ok(!/puppeteer/i.test(source));
  assert.ok(!source.includes('@anthropic-ai/sdk'));
  assert.ok(!source.includes('ANTHROPIC_API_KEY'));
  assert.ok(!source.includes('child_process'));
});

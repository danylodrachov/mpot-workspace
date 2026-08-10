import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadTerminalRunManifest,
  assemblePostRunReviewEvidence,
  runPostRunReview,
  PostRunReviewGateError,
} from './post-run-review.ts';
import { writeJsonAtomic, appendJsonLine } from './io.ts';
import type { DiscoveryRunManifest, VisitedPageRecord, PageSnapshotRecord } from './types.ts';

function makeRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'post-run-review-'));
}

function baseManifest(overrides: Partial<DiscoveryRunManifest> = {}): DiscoveryRunManifest {
  return {
    schemaVersion: '1.0',
    runId: 'run-1',
    entryUrl: 'https://example-casino.test/',
    allowedOrigin: 'https://example-casino.test',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    browserMode: 'cdp',
    urlRulesVersion: '1.0',
    interactionMode: 'passive_only',
    status: 'complete',
    counts: { discovered: 1, accepted: 1, rejected: 0, tbd: 0, visited: 1, failed: 0 },
    artifacts: {
      runContext: 'run-context.json',
      rawUrlCandidates: 'raw-url-candidates.json',
      urlSourceCoverage: 'url-source-coverage.json',
      acceptedUrlInventory: 'accepted-url-inventory.json',
      deterministicRejectedUrls: 'deterministic-rejected-urls.json',
      urlCleanDecisions: 'url-clean-decisions.jsonl',
      pageVisits: 'page-visits.jsonl',
      pageSnapshots: 'page-snapshots.jsonl',
      pageBehavior: 'page-behavior.jsonl',
      runEvents: 'run-events.jsonl',
      reviewInput: 'review-input.json',
      postVisitObservations: 'post-visit-observations.json',
      pagesDirectory: 'pages',
    },
    ...overrides,
  };
}

async function writeFixtureRun(runDir: string, manifestOverrides: Partial<DiscoveryRunManifest> = {}) {
  const manifest = baseManifest(manifestOverrides);
  await writeJsonAtomic(path.join(runDir, 'run-manifest.json'), manifest);
  await writeJsonAtomic(path.join(runDir, 'run-context.json'), {
    schemaVersion: '1.0',
    runId: manifest.runId,
    entryUrl: manifest.entryUrl,
    allowedOrigin: manifest.allowedOrigin,
    startedAt: manifest.startedAt,
    urlRulesVersion: manifest.urlRulesVersion,
    browserMode: 'cdp',
    interactionMode: 'passive_only',
  });

  const pagesDir = path.join(runDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const htmlPath = path.join(pagesDir, '0001-page.html');
  const tracePath = path.join(pagesDir, '0001-page.trace.json');
  fs.writeFileSync(htmlPath, '<html></html>', 'utf8');
  fs.writeFileSync(
    tracePath,
    JSON.stringify({
      schemaVersion: '1.0',
      requestedUrl: 'https://example-casino.test/bonuses',
      finalUrl: 'https://example-casino.test/bonuses',
      capturedAt: new Date().toISOString(),
      interactiveElements: [],
      visibleOverlays: [],
      frames: [],
      automaticDialogs: [],
      network: {
        requests: 0,
        responses: 0,
        failedRequests: 0,
        xhrOrFetchResponses: 0,
        scriptResponses: 0,
        jsonResponses: 0,
        websocketConnections: 0,
      },
      runtimeSignals: {
        scriptCount: 0,
        moduleScriptCount: 0,
        iframeCount: 0,
        lazyImageCount: 0,
        lazySourceCount: 0,
        loadingIndicatorCandidates: 0,
        paginationCandidates: 0,
        loadMoreCandidates: 0,
        frameworkMarkers: [],
      },
      notes: [],
    }),
    'utf8',
  );

  const visitedRecord: VisitedPageRecord = {
    requestedUrl: 'https://example-casino.test/bonuses',
    finalUrl: 'https://example-casino.test/bonuses',
    status: 'visited',
    httpStatus: 200,
    title: 'Bonuses',
    htmlPath,
    tracePath,
    htmlSha256: 'deadbeef',
    discoveredBy: [{ sourceFamily: 'entry', discoveredOn: manifest.entryUrl }],
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    durationMs: 10,
  };
  await appendJsonLine(path.join(runDir, 'page-visits.jsonl'), visitedRecord);

  const snapshotRecord: PageSnapshotRecord = {
    requestedUrl: visitedRecord.requestedUrl,
    finalUrl: visitedRecord.finalUrl!,
    httpStatus: 200,
    title: 'Bonuses',
    htmlPath,
    tracePath,
    htmlSha256: 'deadbeef',
    capturedAt: manifest.completedAt,
  };
  await appendJsonLine(path.join(runDir, 'page-snapshots.jsonl'), snapshotRecord);
  await appendJsonLine(path.join(runDir, 'page-behavior.jsonl'), JSON.parse(fs.readFileSync(tracePath, 'utf8')));
  await appendJsonLine(path.join(runDir, 'url-clean-decisions.jsonl'), {
    rawUrl: visitedRecord.requestedUrl,
    resolvedUrl: visitedRecord.requestedUrl,
    canonicalUrl: visitedRecord.requestedUrl,
    decision: 'accepted',
    ruleId: 'URLR_KEEP',
    reason: 'document keep pattern',
    provenance: [{ sourceFamily: 'entry', discoveredOn: manifest.entryUrl }],
  });

  return { manifest, htmlPath, tracePath };
}

test('refuses to run when run-manifest.json is missing', async () => {
  const runDir = makeRunDir();
  await assert.rejects(() => loadTerminalRunManifest(runDir), PostRunReviewGateError);
  await assert.rejects(() => assemblePostRunReviewEvidence(runDir), PostRunReviewGateError);
});

test('refuses to run when run-manifest.json status is non-terminal', async () => {
  const runDir = makeRunDir();
  await writeJsonAtomic(path.join(runDir, 'run-manifest.json'), baseManifest({ status: 'running' as never }));
  await assert.rejects(() => loadTerminalRunManifest(runDir), PostRunReviewGateError);
  await assert.rejects(() => runPostRunReview(runDir), PostRunReviewGateError);
});

for (const status of ['complete', 'partial', 'error'] as const) {
  test(`succeeds when run-manifest.json status is terminal (${status})`, async () => {
    const runDir = makeRunDir();
    await writeFixtureRun(runDir, { status });
    const manifest = await loadTerminalRunManifest(runDir);
    assert.equal(manifest.status, status);
    const { bundle, handoff } = await runPostRunReview(runDir);
    assert.equal(bundle.manifest.status, status);
    assert.ok(fs.existsSync(bundle.reviewInputPath));
    assert.equal(handoff.agentName, 'discovery-reviewer');
    assert.equal(handoff.discoveryReviewOutputPath, path.join(runDir, 'discovery-review.json'));
    assert.ok(!fs.existsSync(handoff.discoveryReviewOutputPath), 'the LLM output must not be written by this module');
  });
}

test('every assembled page traces back to a visited record and a saved HTML snapshot', async () => {
  const runDir = makeRunDir();
  await writeFixtureRun(runDir);
  const { bundle } = await runPostRunReview(runDir);
  for (const snapshot of bundle.snapshots) {
    const visitedRecord = bundle.visited.find((row) => row.requestedUrl === snapshot.requestedUrl);
    assert.ok(visitedRecord, `expected a visited record for ${snapshot.requestedUrl}`);
    assert.equal(visitedRecord?.status, 'visited');
    assert.ok(fs.existsSync(snapshot.htmlPath), `expected saved HTML for ${snapshot.requestedUrl}`);
  }
});

test('refuses when a page-snapshots.jsonl row has no matching visited record', async () => {
  const runDir = makeRunDir();
  await writeFixtureRun(runDir);
  await appendJsonLine(path.join(runDir, 'page-snapshots.jsonl'), {
    requestedUrl: 'https://example-casino.test/orphan',
    finalUrl: 'https://example-casino.test/orphan',
    title: 'Orphan',
    htmlPath: path.join(runDir, 'pages', 'missing.html'),
    tracePath: path.join(runDir, 'pages', 'missing.trace.json'),
    htmlSha256: 'x',
    capturedAt: new Date().toISOString(),
  });
  await assert.rejects(() => assemblePostRunReviewEvidence(runDir), PostRunReviewGateError);
});

test('FIX-05: review-input.json stays bounded even when thousands of technical URLs are discovered, and url-inventory.json carries the full set', async () => {
  const runDir = makeRunDir();
  const { manifest } = await writeFixtureRun(runDir);

  // Simulate a real casino run: thousands of asset/API rejected+tbd rows spread across a
  // handful of rule IDs, on top of the one accepted/visited document page already written by
  // writeFixtureRun.
  const rejectedRuleIds = ['URLR_DROP_GAME', 'URLR_DROP_EVENT'];
  const tbdRuleIds = ['URLR_TBD_ASSET', 'URLR_TBD_API'];
  const extraRowCount = 2400;
  for (let i = 0; i < extraRowCount; i += 1) {
    const isRejected = i % 2 === 0;
    const ruleId = isRejected ? rejectedRuleIds[i % rejectedRuleIds.length] : tbdRuleIds[i % tbdRuleIds.length];
    await appendJsonLine(path.join(runDir, 'url-clean-decisions.jsonl'), {
      rawUrl: `https://example-casino.test/asset-${i}.js`,
      resolvedUrl: `https://example-casino.test/asset-${i}.js`,
      decision: isRejected ? 'rejected' : 'tbd',
      ruleId,
      reason: isRejected ? 'individual game/event page' : 'technical asset, not a document route',
      provenance: [{ sourceFamily: 'external_script_url_token', discoveredOn: manifest.entryUrl }],
    });
  }

  const { bundle } = await runPostRunReview(runDir);

  const reviewInputRaw = fs.readFileSync(bundle.reviewInputPath, 'utf8');
  const reviewInput = JSON.parse(reviewInputRaw);

  // The bounded payload must not inline the thousands of technical rows.
  assert.equal(reviewInput.urlInventory, undefined, 'legacy inline urlInventory field must be gone');
  assert.ok(Array.isArray(reviewInput.rejectedByRule));
  assert.ok(Array.isArray(reviewInput.tbdByRule));
  const totalRejectedSampleRows = reviewInput.rejectedSamples.reduce((sum: number, group: { samples: unknown[] }) => sum + group.samples.length, 0);
  const totalTbdSampleRows = reviewInput.tbdSamples.reduce((sum: number, group: { samples: unknown[] }) => sum + group.samples.length, 0);
  assert.ok(totalRejectedSampleRows <= rejectedRuleIds.length * 5, 'rejected samples must be capped per rule');
  assert.ok(totalTbdSampleRows <= tbdRuleIds.length * 5, 'tbd samples must be capped per rule');
  assert.ok(reviewInputRaw.length < 20000, `review-input.json must stay small even with ${extraRowCount} technical rows discovered, was ${reviewInputRaw.length} bytes`);

  // Counts must still reconcile against the full inventory.
  const totalRejected = reviewInput.rejectedByRule.reduce((sum: number, group: { count: number }) => sum + group.count, 0);
  const totalTbd = reviewInput.tbdByRule.reduce((sum: number, group: { count: number }) => sum + group.count, 0);
  assert.equal(reviewInput.urlCounts.rejected, totalRejected);
  assert.equal(reviewInput.urlCounts.tbd, totalTbd);
  assert.equal(reviewInput.urlCounts.rejected + reviewInput.urlCounts.tbd, extraRowCount);
  assert.equal(reviewInput.urlCounts.accepted, 1);

  // Accepted canonical targets stay inline in full (they are real document pages, not noise).
  assert.equal(reviewInput.acceptedTargets.length, 1);

  // Source-family coverage summary is present.
  assert.ok(Array.isArray(reviewInput.sourceFamilyCoverage));
  assert.ok(reviewInput.sourceFamilyCoverage.some((row: { sourceFamily: string }) => row.sourceFamily === 'external_script_url_token'));

  // Full provenance is on disk, unbounded, referenced by path.
  assert.ok(typeof reviewInput.fullUrlInventoryPath === 'string');
  assert.ok(fs.existsSync(reviewInput.fullUrlInventoryPath));
  const fullInventory = JSON.parse(fs.readFileSync(reviewInput.fullUrlInventoryPath, 'utf8'));
  assert.equal(fullInventory.rejected.length + fullInventory.tbd.length, extraRowCount);
  assert.equal(fullInventory.accepted.length, 1);
});

test('does not import Playwright or any browser-automation library', async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'post-run-review.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"]playwright['"]/);
  assert.doesNotMatch(source, /playwright-core/);
  assert.doesNotMatch(source, /puppeteer/i);
});

test('does not call any raw model/API SDK', async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'post-run-review.ts'), 'utf8');
  assert.doesNotMatch(source, /@anthropic-ai\/sdk/);
  assert.doesNotMatch(source, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(source, /api\.anthropic\.com/);
});

test('never writes to any deterministic acquisition artifact file', async () => {
  const runDir = makeRunDir();
  await writeFixtureRun(runDir);

  const acquisitionArtifacts = [
    'run-context.json',
    'page-visits.jsonl',
    'page-snapshots.jsonl',
    'page-behavior.jsonl',
    'run-events.jsonl',
    'run-manifest.json',
    'url-clean-decisions.jsonl',
    'raw-url-candidates.json',
    'url-source-coverage.json',
    'accepted-url-inventory.json',
    'deterministic-rejected-urls.json',
  ].map((name) => path.join(runDir, name));

  const before = new Map(
    acquisitionArtifacts
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')]),
  );

  await runPostRunReview(runDir);

  for (const [filePath, contents] of before) {
    assert.equal(fs.readFileSync(filePath, 'utf8'), contents, `expected no change to acquisition artifact: ${filePath}`);
  }
});

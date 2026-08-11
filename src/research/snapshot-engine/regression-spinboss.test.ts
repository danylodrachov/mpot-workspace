import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import type { BrowserContext, Page } from 'playwright';
import type { SourceCoverageRecord, UrlDecisionRecord } from './types.ts';

// FIX-09: deterministic local regression fixture reproducing the shape of a real SpinBoss
// crawl failure — a run that hung indefinitely because one network response body never
// resolved, blocking the whole crawl. FIX-01 (bounded body-scan timeout), FIX-02 (HTTP status
// classification), FIX-03 (locale-aware URL rules) and FIX-07 (run-level watchdog) each fix a
// piece of the underlying bug; this test proves the combination works end-to-end against a
// fully local fixture (no live casino site involved).
//
// Fixture site shape (all same-origin, locale-prefixed under /en/):
//   /en/casino/slots   -> accepted research page (canonical product-category landing)
//   /en/bonuses        -> accepted research page (document keep pattern)
//   /en/404            -> same-origin but unclassified by URL Rules; must never be navigated
//   /en/some-random-page -> ordinary same-origin route, also unclassified/rejected
//   /en/api/session    -> explicit TBD technical URL (URLR_TBD_API)
// A network 'response' event fired during the very first accepted-page visit has a body()
// that never resolves, simulating the real stuck-response-body failure.

interface FakeFrame {
  url(): string;
  name(): string;
  parentFrame(): undefined;
  evaluate: (fn: (...args: unknown[]) => unknown, arg?: unknown) => Promise<unknown>;
}

function passiveInteractivityResult() {
  return {
    interactive: [],
    overlays: [],
    runtime: {
      documentReadyState: 'complete',
      scriptCount: 0,
      moduleScriptCount: 0,
      lazyImageCount: 0,
      lazySourceCount: 0,
      loadingIndicatorCandidates: 0,
      paginationCandidates: 0,
      loadMoreCandidates: 0,
      frameworkMarkers: [],
    },
  };
}

function makeFixtureEnvironment(options: { entryUrl: string; bootstrapLinks: string[]; callLog: string[] }) {
  const { entryUrl, bootstrapLinks, callLog } = options;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = entryUrl;
  let navigationCount = 0;

  const evaluateFor = (isBootstrapFrame: () => boolean) =>
    async (fn: (...args: unknown[]) => unknown): Promise<unknown> => {
      const src = fn.toString();
      if (src.includes('candidateSet')) return passiveInteractivityResult();
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      // FIX-04: the bounded deterministic settle routine in page-capture.ts probes
      // document.readyState and a visible-loading-indicator selector on every poll tick. This
      // fixture's pages are already fully rendered by the time goto() resolves (no real SPA
      // delayed render is being exercised here — that is FIX-04's own dedicated fixture in
      // page-capture.test.ts), so both probes settle immediately/deterministically.
      if (src.includes('getBoundingClientRect')) return false; // no visible loading indicator
      if (src.includes('document.readyState')) return 'complete';
      if (isBootstrapFrame() && navigationCount === 0) {
        return bootstrapLinks.map((href) => ({ value: href, attribute: 'href' }));
      }
      return [];
    };

  const frame: FakeFrame = {
    url: () => currentUrl,
    name: () => '',
    parentFrame: () => undefined,
    evaluate: evaluateFor(() => true),
  };

  const page = {
    url: () => currentUrl,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    goto: async (url: string) => {
      callLog.push(`navigate:${url}`);
      navigationCount += 1;
      currentUrl = url;
      return { status: () => 200 };
    },
    waitForTimeout: async () => {},
    title: async () => 'Title',
    content: async () => '<html><body>ok</body></html>',
    frames: () => [frame],
    mainFrame: () => frame,
    evaluate: evaluateFor(() => false),
  };

  const context = {
    request: {
      // No robots.txt / sitemap.xml in this fixture — genuinely absent, not errored.
      get: async () => ({
        status: () => 404,
        headers: () => ({}),
        body: async () => Buffer.from(''),
      }),
    },
  };

  return {
    page: page as unknown as Page,
    context: context as unknown as BrowserContext,
    listeners,
  };
}

function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-engine-regression-spinboss-'));
}

test('FIX-09: local SpinBoss-shaped fixture — stuck response body + 404 + unmatched routes + TBD route all resolve deterministically', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/en/';
  const { page, context, listeners } = makeFixtureEnvironment({
    entryUrl,
    bootstrapLinks: [
      '/en/casino/slots',
      '/en/bonuses',
      '/en/404',
      '/en/some-random-page',
      '/en/api/session',
    ],
    callLog,
  });

  // Fire a 'response' event with a body() that never resolves during the very first
  // navigation, reproducing the real hung-response-body failure shape. FIX-01's bounded
  // RESPONSE_BODY_TIMEOUT_MS deadline (inside scanResponseBody) must still bound this.
  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let stuckResponseFired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!stuckResponseFired) {
      stuckResponseFired = true;
      listeners.get('response')?.({
        url: () => 'https://example.test/en/stuck-endpoint.json',
        headers: () => ({ 'content-type': 'application/json' }),
        body: () => new Promise<Buffer>(() => {
          /* stuck forever, simulating a hung network response body */
        }),
        request: () => ({ resourceType: () => 'xhr' }),
        frame: () => ({ url: () => 'https://example.test/en/' }),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const startedAt = Date.now();

  // The test itself terminating (not hanging at the node:test runner level) is the primary
  // acceptance assertion: crawlSite must resolve.
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Spinboss',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    debugArtifacts: true,
  });

  const elapsedMs = Date.now() - startedAt;
  // Bounded by FIX-01's RESPONSE_BODY_TIMEOUT_MS (5s) plus normal fast in-memory work; well
  // under the node:test default timeout, proving this is a bounded wait, not a hang.
  assert.ok(elapsedMs < 15_000, `expected the run to terminate well within a bounded window, took ${elapsedMs}ms`);

  const runDir = path.join(outputDir, manifest.runFolderName);
  const debugDir = path.join(runDir, 'debug');

  // --- /en/404 must never be navigated to. ---
  const navigations = callLog.filter((entry) => entry.startsWith('navigate:'));
  assert.ok(
    navigations.every((entry) => !entry.includes('/404')),
    `expected /en/404 to never be navigated to, got: ${JSON.stringify(navigations)}`,
  );

  // --- Arbitrary unmatched paths are not accepted. ---
  const urlInventory = JSON.parse(
    fs.readFileSync(path.join(runDir, 'url-inventory.json'), 'utf-8'),
  ) as { accepted: UrlDecisionRecord[]; rejected: UrlDecisionRecord[]; tbd: UrlDecisionRecord[] };
  const acceptedInventory = urlInventory.accepted;
  const acceptedRawUrls = acceptedInventory.map((row) => row.rawUrl);
  assert.ok(!acceptedRawUrls.includes('/en/404'), 'expected /en/404 to not be in the accepted inventory');
  assert.ok(
    !acceptedRawUrls.includes('/en/some-random-page'),
    'expected the ordinary unmatched route to not be in the accepted inventory',
  );

  const rejectedAndTbd = [...urlInventory.rejected, ...urlInventory.tbd];
  const notFoundDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/404');
  assert.equal(notFoundDecision?.decision, 'rejected', 'expected /en/404 to resolve to an explicit rejected decision');
  assert.equal(notFoundDecision?.ruleId, 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN');

  const randomPageDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/some-random-page');
  assert.equal(randomPageDecision?.decision, 'rejected');
  assert.equal(randomPageDecision?.ruleId, 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN');

  // --- The explicit TBD technical URL remains tbd, never accepted. ---
  const tbdDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/api/session');
  assert.equal(tbdDecision?.decision, 'tbd', 'expected /en/api/session to resolve to an explicit tbd decision');
  assert.equal(tbdDecision?.ruleId, 'URLR_TBD_API');
  assert.ok(!acceptedRawUrls.includes('/en/api/session'));

  // --- Every frozen accepted URL is visited exactly once. ---
  assert.equal(acceptedInventory.length, 2, 'expected exactly the 2 valid research pages to be accepted');
  const acceptedCanonicalUrls = acceptedInventory
    .map((row) => row.canonicalUrl)
    .filter((url): url is string => Boolean(url))
    .sort();

  const pageVisits = fs
    .readFileSync(path.join(runDir, 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{
      requestedUrl: string;
      canonicalUrl?: string;
      status: string;
      failureReason?: string;
    }>;
  assert.equal(pageVisits.length, 2, 'expected exactly one terminal visit record per accepted URL');
  // FIX-03: canonicalUrl (route identity) matches the frozen accepted inventory exactly, while
  // requestedUrl is the localized URL actually navigated to (this fixture's bootstrap links are
  // all already /en/-prefixed, so the localized form is the sole/representative alias here).
  assert.deepEqual(
    pageVisits.map((row) => row.canonicalUrl).sort(),
    acceptedCanonicalUrls,
  );
  assert.deepEqual(
    pageVisits.map((row) => row.requestedUrl).sort(),
    ['https://example.test/en/bonuses', 'https://example.test/en/casino/slots'],
  );
  assert.ok(pageVisits.every((row) => row.status === 'visited'), 'expected both accepted pages to succeed in this fixture');

  const requestedUrlCounts = new Map<string, number>();
  for (const row of pageVisits) {
    requestedUrlCounts.set(row.requestedUrl, (requestedUrlCounts.get(row.requestedUrl) ?? 0) + 1);
  }
  for (const [url, count] of requestedUrlCounts) {
    assert.equal(count, 1, `expected exactly one terminal visit record for ${url}, got ${count}`);
  }

  // --- The timed-out body scan is recorded as a source error (FIX-06 vocabulary). ---
  const coverage = JSON.parse(
    fs.readFileSync(path.join(debugDir, 'url-source-coverage.json'), 'utf-8'),
  ) as SourceCoverageRecord[];
  const bodyTokenCoverage = coverage.find((row) => row.sourceFamily === 'network_body_url_token');
  assert.equal(bodyTokenCoverage?.status, 'error', 'expected the stuck body scan to surface as an explicit error status');
  assert.ok(
    bodyTokenCoverage?.errorDetails.some((detail) => /exceeded/i.test(detail.message)),
    'expected the timeout message to be captured in errorDetails',
  );

  // --- HTML and passive traces exist for successful pages. ---
  const pageSnapshots = fs
    .readFileSync(path.join(debugDir, 'page-snapshots.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{ requestedUrl: string; htmlPath: string; tracePath: string }>;
  assert.equal(pageSnapshots.length, 2);
  for (const snapshot of pageSnapshots) {
    assert.ok(fs.existsSync(snapshot.htmlPath), `expected HTML file to exist: ${snapshot.htmlPath}`);
    assert.ok(fs.existsSync(snapshot.tracePath), `expected trace file to exist: ${snapshot.tracePath}`);
  }
  const pageBehavior = fs
    .readFileSync(path.join(debugDir, 'page-behavior.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(pageBehavior.length, 2, 'expected a passive-behavior trace row per successful page');

  // --- The 7-item CD-N01 retained artifact contract is written at the run folder root. ---
  const retainedArtifacts = ['run-manifest.json', 'url-inventory.json', 'pages.jsonl', 'interactions.jsonl', 'corpus', 'json', 'review.html'];
  for (const name of retainedArtifacts) {
    assert.ok(fs.existsSync(path.join(runDir, name)), `expected retained artifact to exist: ${name}`);
  }
  // --- Debug-only diagnostics (kept here because debugArtifacts: true was requested). ---
  const debugArtifactNames = [
    'run-context.json',
    'raw-url-candidates.json',
    'url-source-coverage.json',
    'accepted-url-inventory.json',
    'deterministic-rejected-urls.json',
    'url-clean-decisions.jsonl',
    'page-visits.jsonl',
    'page-snapshots.jsonl',
    'page-behavior.jsonl',
    'run-events.jsonl',
  ];
  for (const name of debugArtifactNames) {
    assert.ok(fs.existsSync(path.join(debugDir, name)), `expected debug artifact to exist: ${name}`);
  }

  // --- The manifest produces reconciled counts and a terminal run status. ---
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.counts.accepted, 2);
  assert.equal(manifest.counts.visited, 2);
  assert.equal(manifest.counts.failed, 0);
  assert.equal(manifest.counts.tbd >= 1, true, 'expected at least the one explicit TBD URL to be counted');
  assert.equal(manifest.counts.rejected >= 2, true, 'expected at least /en/404 and the random unmatched route to be counted rejected');
});

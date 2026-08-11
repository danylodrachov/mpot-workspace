import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crawlSite, SOURCE_FAMILIES } from './crawler.ts';
import type { BrowserContext, Page } from 'playwright';
import type { SourceCoverageRecord, SourceFamilyStatus } from './types.ts';

// FIX-04: crawlSite must run terminal URL discovery/filtering to completion, freeze the
// accepted-URL inventory, and only then visit each accepted URL exactly once. Passive
// observations made while visiting a frozen-inventory page must never enqueue an extra
// same-run navigation.

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

// Builds a fake Playwright Page/Context pair. `linksByUrl` seeds DOM anchor discovery on the
// bootstrap page (before any navigation) so Phase 1-3 has same-origin candidates to filter.
// `callLog` records the order of navigation vs. discovery calls so tests can assert Phase 4
// (freeze) fully precedes Phase 5 (first visit).
function makeFakeEnvironment(options: {
  entryUrl: string;
  bootstrapLinks: string[];
  callLog: string[];
  // Simulates a hard crash mid-crawl: once this many accepted-page navigations have
  // completed, the next post-visit `page.frames()` call (used by discoverFromPage, called
  // directly from the crawl loop with no surrounding try/catch) throws uncaught, aborting
  // crawlSite's promise before that page's terminal artifacts are appended.
  crashAfterNavigationCount?: number;
}) {
  const { entryUrl, bootstrapLinks, callLog, crashAfterNavigationCount } = options;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = entryUrl;
  let navigationCount = 0;
  let framesCallsAtCrashNavigation = 0;

  const evaluateFor = (isBootstrapFrame: () => boolean) =>
    async (fn: (...args: unknown[]) => unknown): Promise<unknown> => {
      const src = fn.toString();
      if (src.includes('candidateSet')) return passiveInteractivityResult();
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      // DOM anchor/meta extraction: only the bootstrap page (first navigation attempt) yields
      // links, simulating anchors discovered before any accepted URL has been visited.
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
    frames: () => {
      if (crashAfterNavigationCount !== undefined && navigationCount === crashAfterNavigationCount + 1) {
        framesCallsAtCrashNavigation += 1;
        // capturePage's own passive-interactivity collection (inside its own try/catch) calls
        // frames() twice before returning a terminal record; only the crawl loop's uncaught
        // post-visit `discoverFromPage` call (outside any try/catch) should actually crash.
        if (framesCallsAtCrashNavigation > 2) {
          throw new Error('simulated crash mid-crawl');
        }
      }
      return [frame];
    },
    mainFrame: () => frame,
    evaluate: evaluateFor(() => false),
  };

  const context = {
    request: {
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
    // Exposed for tests that need to fire a page event (e.g. 'response') directly, bypassing
    // the fake page's own navigation/DOM simulation.
    listeners,
  };
}

function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-test-'));
}

// CD-N01: the run folder is named from casino/geo/timestamp, not runId — manifest.runFolderName
// is the on-disk directory name.
function runDirOf(outputDir: string, manifest: { runFolderName: string }): string {
  return path.join(outputDir, manifest.runFolderName);
}

// CD-N01: debug-only diagnostics only survive on disk (under `debug/`) when debugArtifacts was
// requested for the run.
function debugDirOf(outputDir: string, manifest: { runFolderName: string }): string {
  return path.join(runDirOf(outputDir, manifest), 'debug');
}

test('discovery/filtering (Phase 1-3) completes before the first accepted-page visit (Phase 5)', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit'],
    callLog,
  });

  await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir: makeOutputDir(), settleMs: 0, navigationTimeoutMs: 1000 });

  // Both accepted URLs must have been discovered (no navigate: calls before them) — the
  // fake bootstrap-link source only yields candidates on the very first (pre-navigation)
  // evaluate call, so any navigate: entry proves discovery had already produced its output.
  const firstNavigateIndex = callLog.findIndex((entry) => entry.startsWith('navigate:'));
  assert.ok(firstNavigateIndex >= 0, 'expected at least one navigation to an accepted URL');
  assert.ok(
    callLog.slice(0, firstNavigateIndex).every((entry) => !entry.startsWith('navigate:')),
    'no navigation should occur before discovery/filtering has produced the frozen inventory',
  );
});

test('accepted inventory count/contents are unchanged from freeze through run completion', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit', '/terms-and-conditions'],
    callLog,
  });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  assert.equal(manifest.counts.accepted, 3);
  assert.equal(manifest.counts.visited, 3);
  assert.equal(manifest.counts.failed, 0);

  const urlInventory = JSON.parse(
    fs.readFileSync(path.join(runDirOf(outputDir, manifest), 'url-inventory.json'), 'utf-8'),
  );
  const acceptedUrls: string[] = urlInventory.accepted
    .map((row: { canonicalUrl?: string }) => row.canonicalUrl)
    .sort();
  assert.deepEqual(acceptedUrls, [
    'https://example.test/bonuses',
    'https://example.test/deposit',
    'https://example.test/terms-and-conditions',
  ]);

  const pageVisitsRaw = fs
    .readFileSync(path.join(runDirOf(outputDir, manifest), 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n');
  const visitedPages = pageVisitsRaw.map((line) => JSON.parse(line));
  assert.equal(visitedPages.length, 3, 'every accepted canonical URL must receive exactly one terminal navigation record');
  const requestedUrls = visitedPages.map((row: { requestedUrl: string }) => row.requestedUrl).sort();
  assert.deepEqual(requestedUrls, acceptedUrls);
});

test('a URL discovered while visiting an accepted page is recorded as an observation, not an extra navigation', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  // Only one accepted link is seeded in the bootstrap DOM. If mid-crawl discovery could
  // expand the queue, a page-capture that "discovers" another accepted link during its own
  // visit would cause a second navigation in the same run — that must not happen.
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    debugArtifacts: true,
  });

  const navigations = callLog.filter((entry) => entry.startsWith('navigate:'));
  assert.equal(navigations.length, 1, 'exactly one navigation is expected for the single accepted URL');
  assert.equal(manifest.counts.visited, 1);

  const postVisitObservations = JSON.parse(
    fs.readFileSync(path.join(debugDirOf(outputDir, manifest), 'post-visit-observations.json'), 'utf-8'),
  );
  // The visited page itself is re-scanned passively (discoverFromPage runs post-visit too);
  // that must land in observations, never in a second navigation.
  assert.ok(Array.isArray(postVisitObservations));
});

// FIX-05/CD-N01: run-level artifacts must be written incrementally, so a hang/crash mid-crawl
// still leaves a complete factual ledger for every page attempted before the crash — the
// retained-contract pages.jsonl on disk directly, and every raw diagnostic packaged into
// debug.zip (CD-N01 requirement: any partial/error termination packages debug.zip
// unconditionally, regardless of --debug-artifacts).
test('a crash mid-crawl (after page 2 of 5) still leaves valid pages.jsonl records and a debug.zip for pages 1-2 only', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit', '/terms-and-conditions', '/withdraw', '/rules'],
    callLog,
    crashAfterNavigationCount: 2,
  });

  const outputDir = makeOutputDir();
  await assert.rejects(
    crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 }),
    /simulated crash mid-crawl/,
  );

  // Exactly one run directory should have been created under outputDir.
  const runDirs = fs.readdirSync(outputDir);
  assert.equal(runDirs.length, 1);
  const runDir = path.join(outputDir, runDirs[0]!);
  assert.match(runDirs[0]!, /^example-casino-xx-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/, 'expected the CD-N01 folder-naming pattern');

  const readJsonl = (filePath: string): unknown[] => {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line));
  };

  // pages.jsonl (retained contract) must have exactly the terminal records for pages 1-2, live
  // directly on disk — never lost even though the run never reached a terminal manifest.
  const pageVisits = readJsonl(path.join(runDir, 'pages.jsonl')) as Array<{ requestedUrl: string; status: string }>;
  assert.equal(pageVisits.length, 2, 'only the 2 pages completed before the crash should have terminal records');
  assert.deepEqual(
    pageVisits.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );
  assert.ok(pageVisits.every((row) => row.status === 'visited'));

  // CD-N01: partial/error termination packages every debug-only diagnostic into debug.zip
  // unconditionally — the raw .debug working directory must never be left behind.
  assert.equal(fs.existsSync(path.join(runDir, 'debug')), false, 'expected the raw debug working directory to be removed once zipped');
  const debugZipPath = path.join(runDir, 'debug.zip');
  assert.ok(fs.existsSync(debugZipPath), 'expected debug.zip to be created on a crashed run');

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-test-debug-extract-'));
  execFileSync('unzip', ['-o', '-q', debugZipPath, '-d', extractDir]);

  // Discovery artifacts (raw candidates / source coverage / decision logs) must exist inside the
  // zip and be valid, complete JSON — they were written right after Phase 4 freeze, well before
  // the crash occurred mid-crawl.
  const discoveryArtifacts = [
    'run-context.json',
    'raw-url-candidates.json',
    'url-source-coverage.json',
    'accepted-url-inventory.json',
    'deterministic-rejected-urls.json',
  ];
  for (const name of discoveryArtifacts) {
    const filePath = path.join(extractDir, name);
    assert.ok(fs.existsSync(filePath), `expected debug artifact to exist inside debug.zip: ${name}`);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf-8')), `expected ${name} to be valid JSON`);
  }

  const acceptedInventory = JSON.parse(
    fs.readFileSync(path.join(extractDir, 'accepted-url-inventory.json'), 'utf-8'),
  ) as Array<{ canonicalUrl?: string }>;
  assert.equal(acceptedInventory.length, 5, 'all 5 accepted URLs must be recorded as frozen discovery output');

  // page-visits.jsonl / page-snapshots.jsonl / page-behavior.jsonl inside the zip must contain
  // exactly the terminal records for pages 1-2 — not a partial/corrupt entry for page 3, and not
  // missing entries for 1-2.
  const pageVisitsDebug = readJsonl(path.join(extractDir, 'page-visits.jsonl')) as Array<{ requestedUrl: string; status: string }>;
  assert.equal(pageVisitsDebug.length, 2, 'only the 2 pages completed before the crash should have terminal visit records');
  assert.deepEqual(
    pageVisitsDebug.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );

  const pageSnapshots = readJsonl(path.join(extractDir, 'page-snapshots.jsonl')) as Array<{ requestedUrl: string }>;
  assert.equal(pageSnapshots.length, 2, 'both completed pages produced a page-snapshots.jsonl row');
  assert.deepEqual(
    pageSnapshots.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );

  const pageBehavior = readJsonl(path.join(extractDir, 'page-behavior.jsonl')) as Array<{ requestedUrl: string }>;
  assert.equal(pageBehavior.length, 2, 'both completed pages produced a page-behavior.jsonl row');
  assert.deepEqual(
    pageBehavior.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );

  // run-events.jsonl must be a valid, non-empty append log describing at least the lifecycle
  // up through the crash (run_start, discovery_complete, crawl_start, page_attempt/complete).
  const runEvents = readJsonl(path.join(extractDir, 'run-events.jsonl')) as Array<{ event: string }>;
  assert.ok(runEvents.length > 0);
  assert.ok(runEvents.some((row) => row.event === 'run_start'));
  assert.ok(runEvents.some((row) => row.event === 'discovery_complete'));
  assert.ok(runEvents.some((row) => row.event === 'crawl_start'));

  // run-manifest.json is only finalized on a clean run; a crash mid-crawl must not leave a
  // false "complete" manifest behind.
  assert.equal(fs.existsSync(path.join(runDir, 'run-manifest.json')), false);
});

// FIX-06: every configured source family must resolve to exactly one terminal status
// (complete/absent/blocked/unsupported/error) in url-source-coverage.json — never left
// unreported, and never inferred 'complete' merely because nothing threw.

const TERMINAL_STATUSES: readonly SourceFamilyStatus[] = ['complete', 'absent', 'blocked', 'unsupported', 'error'];

test('every configured source family appears exactly once in url-source-coverage.json with a valid terminal status', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  // Uses the standard fake environment, whose fake BrowserContext.request.get always returns
  // HTTP 404 — so robots.txt/sitemap.xml are genuinely absent for this target, not errored.
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit'],
    callLog,
  });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000, debugArtifacts: true });

  const coverage = JSON.parse(
    fs.readFileSync(path.join(debugDirOf(outputDir, manifest), 'url-source-coverage.json'), 'utf-8'),
  ) as SourceCoverageRecord[];

  // Exactly one record per configured source family, no duplicates, none missing.
  const familiesInCoverage = coverage.map((row) => row.sourceFamily).sort();
  assert.deepEqual(familiesInCoverage, [...SOURCE_FAMILIES].sort());
  assert.equal(new Set(familiesInCoverage).size, SOURCE_FAMILIES.length);

  for (const row of coverage) {
    assert.ok(
      TERMINAL_STATUSES.includes(row.status),
      `source family ${row.sourceFamily} has non-terminal status: ${row.status}`,
    );
    assert.ok(Array.isArray(row.errorDetails));
  }

  // robots.txt/sitemap.xml genuinely don't exist for this fake target (fetch always 404) —
  // that must be reported as 'absent', never silently folded into 'complete'.
  const robotsSitemap = coverage.find((row) => row.sourceFamily === 'robots_sitemap');
  const sitemapUrl = coverage.find((row) => row.sourceFamily === 'sitemap_url');
  assert.equal(robotsSitemap?.status, 'absent');
  assert.equal(sitemapUrl?.status, 'absent');

  // Families whose extractors actually ran and found candidates on this fake page.
  const domAttribute = coverage.find((row) => row.sourceFamily === 'dom_url_attribute');
  assert.equal(domAttribute?.status, 'complete');
});

test('a FIX-01 response-body-scan timeout surfaces as a non-silent error status for network_body_url_token, not empty success', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  // Simulate a hung network response body during the page-1 visit: page.goto() fires a
  // 'response' event (via the listener PassiveNetworkObserver.start() registered) whose
  // body() promise never resolves, forcing scanResponseBody's bounded deadline
  // (RESPONSE_BODY_TIMEOUT_MS) to reject.
  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      listeners.get('response')?.({
        url: () => 'https://example.test/stuck.js',
        headers: () => ({ 'content-type': 'application/javascript' }),
        body: () => new Promise<Buffer>(() => {
          /* stuck forever, simulating a hung network response */
        }),
        request: () => ({ resourceType: () => 'script' }),
        frame: () => ({ url: () => 'https://example.test/' }),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000, debugArtifacts: true });

  const coverage = JSON.parse(
    fs.readFileSync(path.join(debugDirOf(outputDir, manifest), 'url-source-coverage.json'), 'utf-8'),
  ) as SourceCoverageRecord[];
  const bodyTokenCoverage = coverage.find((row) => row.sourceFamily === 'network_body_url_token');

  assert.equal(bodyTokenCoverage?.status, 'error', 'a stuck response-body scan must surface as error, not absent/complete');
  assert.ok(
    bodyTokenCoverage?.errorDetails.some((detail) => /exceeded/i.test(detail.message)),
    'expected the timeout message to be captured in errorDetails',
  );
});

// FIX-07: deterministic upper bounds on passive enrichment operations that would otherwise be
// able to hang the process forever. All tests below use small injectable deadline overrides
// (matching the FIX-01 pattern) so they run fast with no real long waits.

test('a synthetic never-resolving page capture produces a terminal page_capture_timeout error, not a hang', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  // Make page.content() (called by capturePage after a successful navigation) hang forever,
  // simulating a stuck profiler/capture step that never resolves on its own.
  (page as unknown as { content: () => Promise<string> }).content = () => new Promise<string>(() => {
    /* stuck forever */
  });

  const outputDir = makeOutputDir();
  const startedAt = Date.now();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    pageCaptureTimeoutMs: 50,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 2000, `crawlSite took ${elapsedMs}ms, expected it to return near the 50ms page-capture deadline`);
  assert.equal(manifest.counts.visited, 0);
  assert.equal(manifest.counts.failed, 1);
  assert.equal(manifest.status, 'complete', 'the run itself still completes — only the one page is terminal-failed');

  const pageVisits = JSON.parse(
    `[${fs.readFileSync(path.join(runDirOf(outputDir, manifest), 'pages.jsonl'), 'utf-8').trim().split('\n').join(',')}]`,
  ) as Array<{ status: string; failureReason?: string }>;
  assert.equal(pageVisits.length, 1);
  assert.equal(pageVisits[0]!.status, 'failed');
  assert.equal(pageVisits[0]!.failureReason, 'page_capture_timeout');
});

test('a stuck robots/sitemap discovery batch resolves to an error terminal status within its bound, not a hang', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  // context.request.get never resolves, simulating a stuck robots.txt/sitemap.xml fetch.
  (context as unknown as { request: { get: () => Promise<unknown> } }).request.get = () => new Promise(() => {
    /* stuck forever */
  });

  const outputDir = makeOutputDir();
  const startedAt = Date.now();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    robotsSitemapBatchTimeoutMs: 50,
    debugArtifacts: true,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 2000, `crawlSite took ${elapsedMs}ms, expected it to return near the 50ms robots/sitemap deadline`);

  const coverage = JSON.parse(
    fs.readFileSync(path.join(debugDirOf(outputDir, manifest), 'url-source-coverage.json'), 'utf-8'),
  ) as SourceCoverageRecord[];
  const robotsSitemap = coverage.find((row) => row.sourceFamily === 'robots_sitemap');
  const sitemapUrl = coverage.find((row) => row.sourceFamily === 'sitemap_url');
  assert.equal(robotsSitemap?.status, 'error');
  assert.equal(sitemapUrl?.status, 'error');
  assert.ok(robotsSitemap?.errorDetails.some((detail) => /exceeded/i.test(detail.message)));
});

// FIX-03: locale aliases discovered pre-visit must collapse into one accepted visit per
// canonical route, with the localized form preferred as the actual navigation target and the
// bare form preserved as alias history — reproducing the failed Westace run where /payments +
// /en/payments and /rules + /en/rules were scheduled as separate visits.
test('FIX-03: locale aliases (bare + /en/ prefixed) merge into one visit each, preferring the localized URL', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://ws43--westace.com/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/payments', '/en/payments', '/rules', '/en/rules'],
    callLog,
  });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  // Two canonical routes (payments, rules), not four separate aliases.
  assert.equal(manifest.counts.accepted, 2, 'locale aliases must collapse into one canonical route each');
  assert.equal(manifest.counts.visited, 2, 'exactly one visit per canonical route — no duplicate payments/rules visit');

  const navigations = callLog.filter((entry) => entry.startsWith('navigate:'));
  assert.equal(navigations.length, 2, 'exactly one navigation each for payments and rules, not two');

  const urlInventory = JSON.parse(
    fs.readFileSync(path.join(runDirOf(outputDir, manifest), 'url-inventory.json'), 'utf-8'),
  ) as { accepted: Array<{ canonicalUrl?: string; aliasUrls?: string[] }> };
  const acceptedInventory = urlInventory.accepted;
  const canonicalUrls = acceptedInventory.map((row) => row.canonicalUrl).sort();
  assert.deepEqual(canonicalUrls, [
    'https://ws43--westace.com/payments',
    'https://ws43--westace.com/rules',
  ], 'canonical identity is locale-agnostic — bare path, not a localized alias');

  const pageVisitsRaw = fs
    .readFileSync(path.join(runDirOf(outputDir, manifest), 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n');
  const visitedPages = pageVisitsRaw.map((line) => JSON.parse(line)) as Array<{
    requestedUrl: string;
    canonicalUrl?: string;
    aliasUrls?: string[];
  }>;
  assert.equal(visitedPages.length, 2);

  const payments = visitedPages.find((row) => row.canonicalUrl === 'https://ws43--westace.com/payments');
  const rules = visitedPages.find((row) => row.canonicalUrl === 'https://ws43--westace.com/rules');
  assert.ok(payments && rules, 'expected one merged visit record for each canonical route');

  // The localized alias is preferred as the actual navigation target...
  assert.equal(payments!.requestedUrl, 'https://ws43--westace.com/en/payments');
  assert.equal(rules!.requestedUrl, 'https://ws43--westace.com/en/rules');
  // ...while the bare (non-localized) alias is preserved as discovery/provenance history, not lost.
  assert.deepEqual(payments!.aliasUrls, ['https://ws43--westace.com/payments']);
  assert.deepEqual(rules!.aliasUrls, ['https://ws43--westace.com/rules']);
});

test('a run-level deadline reached mid-crawl produces a partial manifest status, never marks unattempted URLs successful', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit', '/terms-and-conditions'],
    callLog,
  });

  // Slow down every navigation slightly so the run-level watchdog has room to fire after the
  // first page but before the remaining two accepted URLs are attempted.
  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return originalGoto(url);
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    runDeadlineMs: 40,
  });

  assert.equal(manifest.status, 'partial', 'at least one page visited before the deadline, but not all accepted URLs were attempted');
  assert.ok(manifest.counts.visited >= 1, 'the watchdog must not prevent pages already in flight from completing');
  assert.ok(manifest.counts.visited < 3, 'the watchdog must have stopped the crawl before every accepted URL was attempted');

  const pageVisits = JSON.parse(
    `[${fs.readFileSync(path.join(runDirOf(outputDir, manifest), 'pages.jsonl'), 'utf-8').trim().split('\n').join(',')}]`,
  ) as Array<{ status: string; failureReason?: string }>;
  assert.equal(pageVisits.length, 3, 'every accepted URL still gets exactly one terminal record, even the ones never attempted');
  const notAttempted = pageVisits.filter((row) => row.failureReason === 'run_deadline_reached');
  assert.ok(notAttempted.length >= 1, 'expected at least one accepted URL to be marked not-attempted due to the run deadline');
  assert.ok(
    notAttempted.every((row) => row.status === 'failed'),
    'a URL never attempted because of the run deadline must never be marked successful',
  );
});

// CD-N07: a page whose capture step never resolves (no timeout individually caught inside
// capturePage's own bounded sub-steps — simulated here directly, since the fake environment's
// page.content() hang below is itself bound by pageCaptureTimeoutMs in the previous test; this
// test proves the SEPARATE no-progress watchdog also bounds the run even when the per-page
// timeout is generous) must not hang the whole run — the no-progress watchdog fires and the run
// terminates as partial or error, never left unresolved.
test('CD-N07: a no-progress watchdog bounds the run when a page capture never resolves, producing a terminal partial/error status', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  // Make page.content() hang forever, simulating a stuck profiler/capture step. The per-page
  // pageCaptureTimeoutMs budget below is set generously large (well beyond the test's own bound)
  // so this test isolates the no-progress watchdog's own bound, not the per-page timeout.
  (page as unknown as { content: () => Promise<string> }).content = () => new Promise<string>(() => {
    /* stuck forever */
  });

  const outputDir = makeOutputDir();
  const startedAt = Date.now();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    pageCaptureTimeoutMs: 60_000,
    runtimeBudgetOverrides: { noProgressWatchdogMs: 50 },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs < 5_000,
    `crawlSite took ${elapsedMs}ms, expected it to terminate near the 50ms no-progress watchdog budget, not the 60s page-capture deadline`,
  );
  assert.notEqual(manifest.status, undefined);
  assert.ok(
    manifest.status === 'partial' || manifest.status === 'error',
    `expected a watchdog-triggered run to resolve to 'partial' or 'error', got '${manifest.status}'`,
  );
  assert.notEqual(manifest.status, 'complete', 'a no-progress timeout must never be treated as a successful run completion');

  const pageVisits = JSON.parse(
    `[${fs.readFileSync(path.join(runDirOf(outputDir, manifest), 'pages.jsonl'), 'utf-8').trim().split('\n').join(',')}]`,
  ) as Array<{ status: string; failureReason?: string }>;
  assert.equal(pageVisits.length, 1);
  assert.equal(pageVisits[0]!.status, 'failed');
  assert.equal(pageVisits[0]!.failureReason, 'no_progress_watchdog');
});

// CD-N01: the run folder name, the 7-item retained artifact contract, and the debug
// discard-by-default behavior on an ordinary successful run.
test('CD-N01: run folder is named <casino-slug>-<geo>-<date>-<time>, retains exactly the 7-item contract, and discards debug diagnostics by default', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses'],
    callLog,
  });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'WestAce Casino!!',
    geo: 'NO',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
  });

  assert.equal(manifest.status, 'complete');
  assert.match(
    manifest.runFolderName,
    /^westace-casino-no-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/,
    'expected <casino-slug>-<geo>-<YYYY-MM-DD>-<HH-mm-ss>',
  );
  const runDirs = fs.readdirSync(outputDir);
  assert.deepEqual(runDirs, [manifest.runFolderName], 'expected the folder on disk to match manifest.runFolderName exactly');
  // The opaque runId is never used as, or embedded in, the folder name.
  assert.ok(!manifest.runFolderName.includes(manifest.runId));

  const runDir = runDirOf(outputDir, manifest);
  const entries = fs.readdirSync(runDir).sort();
  assert.deepEqual(
    entries,
    // CF-02: adds a run-scoped `network/` evidence directory to the retained contract (bounded
    // same-origin xhr/fetch response bodies). `network-evidence.jsonl` itself is only written
    // once at least one eligible response is observed, so it is absent from this no-network-
    // traffic fixture.
    ['corpus', 'interactions.jsonl', 'json', 'network', 'pages.jsonl', 'review.html', 'run-manifest.json', 'url-inventory.json'].sort(),
    'expected the retained contract at the run folder root, with debug diagnostics discarded (no --debug-artifacts, ordinary success)',
  );
  assert.ok(fs.statSync(path.join(runDir, 'corpus')).isDirectory());
  assert.ok(fs.statSync(path.join(runDir, 'json')).isDirectory());

  // No raw HTML/trace, no debug.zip, and no debug/ directory left behind on an ordinary
  // discard-by-default success.
  assert.equal(fs.existsSync(path.join(runDir, 'debug')), false);
  assert.equal(fs.existsSync(path.join(runDir, 'debug.zip')), false);

  // run-manifest.json/url-inventory.json/pages.jsonl/interactions.jsonl reconcile: manifest
  // counts.visited matches the number of 'visited' rows in pages.jsonl, and
  // counts.interactionRecords matches interactions.jsonl's line count.
  const pagesJsonl = fs
    .readFileSync(path.join(runDir, 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line)) as Array<{ status: string }>;
  assert.equal(pagesJsonl.filter((row) => row.status === 'visited').length, manifest.counts.visited);
  assert.equal(pagesJsonl.length, manifest.counts.accepted);

  const interactionsRaw = fs.readFileSync(path.join(runDir, 'interactions.jsonl'), 'utf-8').trim();
  const interactionLines = interactionsRaw.length > 0 ? interactionsRaw.split('\n') : [];
  assert.equal(interactionLines.length, manifest.counts.interactionRecords);
});

// CD-N01: a partial/error termination always packages debug.zip, even without --debug-artifacts.
test('CD-N01: a partial run packages debug.zip unconditionally, without --debug-artifacts', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit', '/terms-and-conditions'],
    callLog,
  });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return originalGoto(url);
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    runDeadlineMs: 40,
    // Deliberately omitted: debugArtifacts. A partial run must still package debug.zip.
  });

  assert.equal(manifest.status, 'partial');
  const runDir = runDirOf(outputDir, manifest);
  assert.equal(fs.existsSync(path.join(runDir, 'debug')), false, 'raw debug directory must never survive a partial run');
  assert.ok(fs.existsSync(path.join(runDir, 'debug.zip')), 'expected debug.zip on a partial run even without --debug-artifacts');
  assert.equal(manifest.artifacts.debugZip, path.join(runDir, 'debug.zip'));
});

// CF-02: bounded same-origin network response bodies observed while visiting an accepted page
// must be persisted alongside (not instead of) the existing URL-token discovery, without ever
// promoting the observed request URL itself into a document navigation target.
function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  return raw.length > 0 ? (raw.split('\n').map((line) => JSON.parse(line)) as T[]) : [];
}

interface FakeNetworkEvidenceRecord {
  requestUrl: string;
  outcome: string;
  bodyPath?: string;
  bodySha256?: string;
  reason?: string;
}

function fireResponse(
  listeners: Map<string, (...args: unknown[]) => void>,
  options: {
    url: string;
    contentType: string;
    resourceType: string;
    status?: number;
    method?: string;
    body: () => Promise<Buffer>;
    pageUrl?: string;
  },
) {
  listeners.get('response')?.({
    url: () => options.url,
    headers: () => ({ 'content-type': options.contentType }),
    status: () => options.status ?? 200,
    body: options.body,
    request: () => ({ resourceType: () => options.resourceType, method: () => options.method ?? 'GET' }),
    frame: () => ({ url: () => options.pageUrl ?? 'https://example.test/' }),
  });
}

test('CF-02: a same-origin JSON xhr response body is persisted and indexed in network-evidence.jsonl', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/api/v3/promotion/list?x=1',
        contentType: 'application/json',
        resourceType: 'xhr',
        body: async () => Buffer.from(JSON.stringify({ promotions: [{ name: 'Welcome Bonus' }] })),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  const record = records.find((row) => row.requestUrl === 'https://example.test/api/v3/promotion/list?x=1');
  assert.ok(record, 'expected a network-evidence.jsonl record for the observed promotion API response');
  assert.equal(record?.outcome, 'captured');
  assert.ok(record?.bodyPath && fs.existsSync(record.bodyPath), 'expected the captured body file to exist on disk');
  assert.ok(fs.readFileSync(record!.bodyPath!, 'utf-8').includes('Welcome Bonus'));

  // CF-02 boundary: the observed API URL must never be promoted into the accepted document
  // visit queue, even though its response body was captured as evidence.
  const inventory = JSON.parse(fs.readFileSync(path.join(runDir, 'url-inventory.json'), 'utf-8')) as {
    accepted: Array<{ canonicalUrl?: string; rawUrl: string }>;
  };
  assert.ok(
    !inventory.accepted.some((row) => (row.canonicalUrl ?? row.rawUrl).includes('/api/v3/promotion/list')),
    'the /api/... URL must remain TBD/rejected, never accepted for document crawl',
  );
});

test('CF-02: a same-origin text fetch response body is persisted and indexed', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/payments'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/cashbox/paymentsystem',
        contentType: 'text/plain',
        resourceType: 'fetch',
        body: async () => Buffer.from('Visa,Mastercard'),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  const record = records.find((row) => row.requestUrl === 'https://example.test/cashbox/paymentsystem');
  assert.equal(record?.outcome, 'captured');
  assert.ok(record?.bodyPath && fs.readFileSync(record.bodyPath, 'utf-8').includes('Visa'));
});

test('CF-02: an image response is never persisted as network evidence', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/visa-logo.png',
        contentType: 'image/png',
        resourceType: 'image',
        body: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  assert.equal(
    records.some((row) => row.requestUrl === 'https://example.test/visa-logo.png'),
    false,
    'a non-xhr/fetch image response must never produce a network-evidence record',
  );
});

test('CF-02: a cross-origin xhr response is never persisted as network evidence', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://analytics.other-domain.test/collect',
        contentType: 'application/json',
        resourceType: 'xhr',
        body: async () => Buffer.from('{"ok":true}'),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  assert.equal(
    records.some((row) => row.requestUrl === 'https://analytics.other-domain.test/collect'),
    false,
    'a cross-origin response must never produce a network-evidence record',
  );
});

test('CF-02: an oversized response body is skipped with an explicit reason, not silently dropped', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/api/v3/huge',
        contentType: 'application/json',
        resourceType: 'fetch',
        body: async () => Buffer.alloc(11 * 1024 * 1024, 'a'),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  const record = records.find((row) => row.requestUrl === 'https://example.test/api/v3/huge');
  assert.equal(record?.outcome, 'skipped');
  assert.ok(record?.reason && /exceeds/.test(record.reason));
});

test('CF-02: a timed-out network evidence capture produces a terminal timeout record, not a hang', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/api/v3/bonus/list',
        contentType: 'application/json',
        resourceType: 'xhr',
        body: () => new Promise<Buffer>(() => {
          /* stuck forever, simulating a hung evidence body fetch */
        }),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    runtimeBudgetOverrides: { responseBodyScanTimeoutMs: 50, networkObserverFlushTimeoutMs: 300 },
  });
  const runDir = runDirOf(outputDir, manifest);

  const records = readJsonl<FakeNetworkEvidenceRecord>(path.join(runDir, 'network-evidence.jsonl'));
  const record = records.find((row) => row.requestUrl === 'https://example.test/api/v3/bonus/list');
  assert.equal(record?.outcome, 'timeout');
});

// CF-03: the deterministic review handoff must reference CF-02's network-evidence.jsonl by path
// (never inline the captured bodies), and validate every 'captured' record's body file exists
// before handing anything to the reviewer.
function readReviewInput(runDir: string): {
  schemaVersion: string;
  networkEvidenceIndexPath?: string;
} {
  const debugDir = path.join(runDir, 'debug');
  const candidate = fs.existsSync(debugDir)
    ? path.join(debugDir, 'review-input.json')
    : path.join(runDir, 'review-input.json');
  return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
}

test('CF-03: a terminal run with captured network evidence assembles review-input.json referencing the index, not embedding bodies', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/api/v3/promotion/list?x=1',
        contentType: 'application/json',
        resourceType: 'xhr',
        body: async () => Buffer.from(JSON.stringify({ promotions: [{ name: 'Welcome Bonus' }] })),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    debugArtifacts: true,
  });
  const runDir = runDirOf(outputDir, manifest);

  const networkEvidencePath = path.join(runDir, 'network-evidence.jsonl');
  assert.ok(fs.existsSync(networkEvidencePath), 'expected network-evidence.jsonl to exist for this run');

  const reviewInput = readReviewInput(runDir);
  assert.equal(reviewInput.schemaVersion, '1.2');
  assert.equal(
    reviewInput.networkEvidenceIndexPath,
    networkEvidencePath,
    'expected review-input.json to reference network-evidence.jsonl by path',
  );

  const rawReviewInput = fs.readFileSync(
    fs.existsSync(path.join(runDir, 'debug')) ? path.join(runDir, 'debug', 'review-input.json') : path.join(runDir, 'review-input.json'),
    'utf-8',
  );
  assert.ok(
    !rawReviewInput.includes('Welcome Bonus'),
    'the captured response body must never be inlined into review-input.json — the reviewer reads it from disk via the index',
  );
});

test('CF-03: a run without any captured network traffic remains backward-compatible (no networkEvidenceIndexPath)', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/bonuses'], callLog });

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({
    context,
    page,
    entryUrl,
    casinoName: 'Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    debugArtifacts: true,
  });
  const runDir = runDirOf(outputDir, manifest);

  assert.equal(fs.existsSync(path.join(runDir, 'network-evidence.jsonl')), false);
  const reviewInput = readReviewInput(runDir);
  assert.equal(reviewInput.networkEvidenceIndexPath, undefined);
});

test('CF-03: a captured network-evidence record pointing at a missing body file fails the review gate', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context, listeners } = makeFakeEnvironment({ entryUrl, bootstrapLinks: ['/promotions'], callLog });

  const originalGoto = (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto;
  let fired = false;
  (page as unknown as { goto: (url: string) => Promise<{ status: () => number }> }).goto = async (url: string) => {
    const result = await originalGoto(url);
    if (!fired) {
      fired = true;
      fireResponse(listeners, {
        url: 'https://example.test/api/v3/promotion/list?x=1',
        contentType: 'application/json',
        resourceType: 'xhr',
        body: async () => Buffer.from(JSON.stringify({ promotions: [{ name: 'Welcome Bonus' }] })),
      });
    }
    return result;
  };

  const outputDir = makeOutputDir();
  const manifest = await crawlSite({ context, page, entryUrl, casinoName: 'Example Casino', outputDir, settleMs: 0, navigationTimeoutMs: 1000 });
  const runDir = runDirOf(outputDir, manifest);

  // The run itself completed with a valid, fully-backed index. Simulate the failure mode the
  // gate exists to catch: a 'captured' record whose body file has since gone missing.
  const indexPath = path.join(runDir, 'network-evidence.jsonl');
  const records = readJsonl<FakeNetworkEvidenceRecord>(indexPath);
  const captured = records.find((row) => row.outcome === 'captured' && row.bodyPath);
  assert.ok(captured?.bodyPath, 'expected at least one captured record with a body file');
  fs.rmSync(captured!.bodyPath!);

  const { validateNetworkEvidenceIndex, PostRunReviewGateError } = await import('./post-run-review.ts');
  await assert.rejects(async () => validateNetworkEvidenceIndex(indexPath), PostRunReviewGateError);
});

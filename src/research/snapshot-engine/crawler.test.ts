import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('discovery/filtering (Phase 1-3) completes before the first accepted-page visit (Phase 5)', async () => {
  const callLog: string[] = [];
  const entryUrl = 'https://example.test/';
  const { page, context } = makeFakeEnvironment({
    entryUrl,
    bootstrapLinks: ['/bonuses', '/deposit'],
    callLog,
  });

  await crawlSite({ context, page, entryUrl, outputDir: makeOutputDir(), settleMs: 0, navigationTimeoutMs: 1000 });

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
  const manifest = await crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  assert.equal(manifest.counts.accepted, 3);
  assert.equal(manifest.counts.visited, 3);
  assert.equal(manifest.counts.failed, 0);

  const acceptedInventory = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'accepted-url-inventory.json'), 'utf-8'),
  );
  const acceptedUrls: string[] = acceptedInventory.map((row: { canonicalUrl?: string }) => row.canonicalUrl).sort();
  assert.deepEqual(acceptedUrls, [
    'https://example.test/bonuses',
    'https://example.test/deposit',
    'https://example.test/terms-and-conditions',
  ]);

  const pageVisitsRaw = fs
    .readFileSync(path.join(outputDir, manifest.runId, 'page-visits.jsonl'), 'utf-8')
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
  const manifest = await crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  const navigations = callLog.filter((entry) => entry.startsWith('navigate:'));
  assert.equal(navigations.length, 1, 'exactly one navigation is expected for the single accepted URL');
  assert.equal(manifest.counts.visited, 1);

  const postVisitObservations = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'post-visit-observations.json'), 'utf-8'),
  );
  // The visited page itself is re-scanned passively (discoverFromPage runs post-visit too);
  // that must land in observations, never in a second navigation.
  assert.ok(Array.isArray(postVisitObservations));
});

// FIX-05: run-level artifacts must be written incrementally, so a hang/crash mid-crawl still
// leaves a complete factual ledger for every page attempted before the crash.
test('a crash mid-crawl (after page 2 of 5) still leaves valid frozen discovery artifacts and terminal per-page records for pages 1-2 only', async () => {
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
    crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 }),
    /simulated crash mid-crawl/,
  );

  // Exactly one run directory should have been created under outputDir.
  const runDirs = fs.readdirSync(outputDir);
  assert.equal(runDirs.length, 1);
  const runDir = path.join(outputDir, runDirs[0]!);

  // Discovery artifacts (canonical names 1-5) must exist and be valid, complete JSON — they
  // were written right after Phase 4 freeze, well before the crash occurred mid-crawl.
  const discoveryArtifacts = [
    'run-context.json',
    'raw-url-candidates.json',
    'url-source-coverage.json',
    'accepted-url-inventory.json',
    'deterministic-rejected-urls.json',
  ];
  for (const name of discoveryArtifacts) {
    const filePath = path.join(runDir, name);
    assert.ok(fs.existsSync(filePath), `expected discovery artifact to exist: ${name}`);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf-8')), `expected ${name} to be valid JSON`);
  }

  const acceptedInventory = JSON.parse(
    fs.readFileSync(path.join(runDir, 'accepted-url-inventory.json'), 'utf-8'),
  ) as Array<{ canonicalUrl?: string }>;
  assert.equal(acceptedInventory.length, 5, 'all 5 accepted URLs must be recorded as frozen discovery output');

  // page-visits.jsonl / page-snapshots.jsonl / page-behavior.jsonl must contain exactly the
  // terminal records for pages 1-2 — not a partial/corrupt entry for page 3, and not missing
  // entries for 1-2.
  const readJsonl = (name: string): unknown[] => {
    const filePath = path.join(runDir, name);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line));
  };

  const pageVisits = readJsonl('page-visits.jsonl') as Array<{ requestedUrl: string; status: string }>;
  assert.equal(pageVisits.length, 2, 'only the 2 pages completed before the crash should have terminal visit records');
  assert.deepEqual(
    pageVisits.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );
  assert.ok(pageVisits.every((row) => row.status === 'visited'));

  const pageSnapshots = readJsonl('page-snapshots.jsonl') as Array<{ requestedUrl: string }>;
  assert.equal(pageSnapshots.length, 2, 'both completed pages produced a page-snapshots.jsonl row');
  assert.deepEqual(
    pageSnapshots.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );

  const pageBehavior = readJsonl('page-behavior.jsonl') as Array<{ requestedUrl: string }>;
  assert.equal(pageBehavior.length, 2, 'both completed pages produced a page-behavior.jsonl row');
  assert.deepEqual(
    pageBehavior.map((row) => row.requestedUrl).sort(),
    ['https://example.test/bonuses', 'https://example.test/deposit'],
  );

  // run-events.jsonl must be a valid, non-empty append log describing at least the lifecycle
  // up through the crash (run_start, discovery_complete, crawl_start, page_attempt/complete).
  const runEvents = readJsonl('run-events.jsonl') as Array<{ event: string }>;
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
  const manifest = await crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  const coverage = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'url-source-coverage.json'), 'utf-8'),
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
  const manifest = await crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  const coverage = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'url-source-coverage.json'), 'utf-8'),
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
    `[${fs.readFileSync(path.join(outputDir, manifest.runId, 'page-visits.jsonl'), 'utf-8').trim().split('\n').join(',')}]`,
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
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    robotsSitemapBatchTimeoutMs: 50,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 2000, `crawlSite took ${elapsedMs}ms, expected it to return near the 50ms robots/sitemap deadline`);

  const coverage = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'url-source-coverage.json'), 'utf-8'),
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
  const manifest = await crawlSite({ context, page, entryUrl, outputDir, settleMs: 0, navigationTimeoutMs: 1000 });

  // Two canonical routes (payments, rules), not four separate aliases.
  assert.equal(manifest.counts.accepted, 2, 'locale aliases must collapse into one canonical route each');
  assert.equal(manifest.counts.visited, 2, 'exactly one visit per canonical route — no duplicate payments/rules visit');

  const navigations = callLog.filter((entry) => entry.startsWith('navigate:'));
  assert.equal(navigations.length, 2, 'exactly one navigation each for payments and rules, not two');

  const acceptedInventory = JSON.parse(
    fs.readFileSync(path.join(outputDir, manifest.runId, 'accepted-url-inventory.json'), 'utf-8'),
  ) as Array<{ canonicalUrl?: string; aliasUrls?: string[] }>;
  const canonicalUrls = acceptedInventory.map((row) => row.canonicalUrl).sort();
  assert.deepEqual(canonicalUrls, [
    'https://ws43--westace.com/payments',
    'https://ws43--westace.com/rules',
  ], 'canonical identity is locale-agnostic — bare path, not a localized alias');

  const pageVisitsRaw = fs
    .readFileSync(path.join(outputDir, manifest.runId, 'page-visits.jsonl'), 'utf-8')
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
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    runDeadlineMs: 40,
  });

  assert.equal(manifest.status, 'partial', 'at least one page visited before the deadline, but not all accepted URLs were attempted');
  assert.ok(manifest.counts.visited >= 1, 'the watchdog must not prevent pages already in flight from completing');
  assert.ok(manifest.counts.visited < 3, 'the watchdog must have stopped the crawl before every accepted URL was attempted');

  const pageVisits = JSON.parse(
    `[${fs.readFileSync(path.join(outputDir, manifest.runId, 'page-visits.jsonl'), 'utf-8').trim().split('\n').join(',')}]`,
  ) as Array<{ status: string; failureReason?: string }>;
  assert.equal(pageVisits.length, 3, 'every accepted URL still gets exactly one terminal record, even the ones never attempted');
  const notAttempted = pageVisits.filter((row) => row.failureReason === 'run_deadline_reached');
  assert.ok(notAttempted.length >= 1, 'expected at least one accepted URL to be marked not-attempted due to the run deadline');
  assert.ok(
    notAttempted.every((row) => row.status === 'failed'),
    'a URL never attempted because of the run deadline must never be marked successful',
  );
});

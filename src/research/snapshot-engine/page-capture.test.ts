import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePage } from './page-capture.ts';

// Minimal fake of the subset of the Playwright Page API that capturePage touches.
// FIX-02: HTTP-status classification must not depend on real browser navigation,
// so a fake response/page is enough to exercise the branch logic deterministically.
function makeFakePage(options: {
  status: number | undefined;
  throwOnGoto?: Error;
  url?: string;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fakeResponse = options.status === undefined ? null : { status: () => options.status };
  const page = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    goto: async () => {
      if (options.throwOnGoto) throw options.throwOnGoto;
      return fakeResponse;
    },
    waitForTimeout: async () => {},
    url: () => options.url ?? 'https://example.test/page',
    title: async () => 'Example Title',
    content: async () => '<html><body>ok</body></html>',
    evaluate: async () => 'complete',
    frames: () => [],
  };
  return page as unknown as import('playwright').Page;
}

// FIX-04: fake page whose readyState/loading-indicator/content/url settle-signal can be scripted
// per-poll, so the bounded deterministic settle routine in page-capture.ts can be exercised
// without a real browser. Each call to `evaluate`/`content`/`url` advances/reads a shared
// `tick` counter driven by the settle poll loop itself (via `waitForTimeout`), so scripting is
// keyed off "how many polls has the settle loop run" rather than wall-clock time.
function makeScriptedSettlePage(options: {
  status?: number;
  htmlAtTick: (tick: number) => string;
  readyStateAtTick?: (tick: number) => string;
  loadingIndicatorAtTick?: (tick: number) => boolean;
  urlAtTick?: (tick: number) => string;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fakeResponse = { status: () => options.status ?? 200 };
  let tick = 0;
  const page = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    goto: async () => fakeResponse,
    // The settle loop's own inter-poll delay is what advances the script forward in time.
    waitForTimeout: async () => {
      tick += 1;
    },
    url: () => (options.urlAtTick ? options.urlAtTick(tick) : 'https://example.test/page'),
    title: async () => 'Example Title',
    content: async () => options.htmlAtTick(tick),
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('loadingIndicatorPresent') || src.includes('querySelectorAll')) {
        return options.loadingIndicatorAtTick ? options.loadingIndicatorAtTick(tick) : false;
      }
      return options.readyStateAtTick ? options.readyStateAtTick(tick) : 'complete';
    },
    frames: () => [],
  };
  return page as unknown as import('playwright').Page;
}

function makeFakeNetworkObserver() {
  return {
    flush: async () => {},
    counters: {
      requests: 0,
      responses: 0,
      failedRequests: 0,
      xhrOrFetchResponses: 0,
      scriptResponses: 0,
      jsonResponses: 0,
      websocketConnections: 0,
    },
  } as unknown as import('./url-discovery.ts').PassiveNetworkObserver;
}

function makeTmpPagesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'page-capture-test-'));
}

test('HTTP 404 document is classified as failed, not visited, and writes no snapshot', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: 404 }),
    requestedUrl: 'https://example.test/missing',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.httpStatus, 404);
  assert.equal(record.failureReason, 'http_client_error');
  assert.equal(record.htmlPath, undefined);
  assert.equal(record.tracePath, undefined);
  assert.deepEqual(fs.readdirSync(pagesDir), []);
});

test('HTTP 500 document is classified as failed, not visited, and writes no snapshot', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: 500 }),
    requestedUrl: 'https://example.test/error',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.httpStatus, 500);
  assert.equal(record.failureReason, 'http_server_error');
  assert.equal(record.htmlPath, undefined);
  assert.equal(record.tracePath, undefined);
  assert.deepEqual(fs.readdirSync(pagesDir), []);
});

test('HTTP 200 document is classified as visited and writes HTML and trace', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: 200 }),
    requestedUrl: 'https://example.test/ok',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'visited');
  assert.equal(record.httpStatus, 200);
  assert.equal(record.failureReason, undefined);
  assert.ok(record.htmlPath && fs.existsSync(record.htmlPath));
  assert.ok(record.tracePath && fs.existsSync(record.tracePath));
});

test('a navigation exception is classified as failed with navigation_exception reason', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: undefined, throwOnGoto: new Error('net::ERR_CONNECTION_REFUSED') }),
    requestedUrl: 'https://example.test/unreachable',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.failureReason, 'navigation_exception');
  assert.deepEqual(fs.readdirSync(pagesDir), []);
});

// --- FIX-04: deterministic page settling replaces the fixed page.waitForTimeout(settleMs) rule. ---

test('FIX-04: SPA content that swaps in a few ticks after domcontentloaded captures the destination DOM, not the transitional one', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    htmlAtTick: (tick) => (tick < 1 ? '<html><body>loading placeholder</body></html>' : '<html><body>destination content</body></html>'),
    loadingIndicatorAtTick: (tick) => tick < 1,
  });

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/spa-route',
    pageIndex: 0,
    pagesDir,
    settleMs: 5_000,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'visited');
  assert.equal(record.failureReason, undefined);
  assert.ok(record.htmlPath);
  const savedHtml = fs.readFileSync(record.htmlPath!, 'utf8');
  assert.match(savedHtml, /destination content/);
  assert.doesNotMatch(savedHtml, /loading placeholder/);
});

test('FIX-04: continuous background traffic (no networkidle requirement) does not block settling once the DOM itself is stable', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    htmlAtTick: () => '<html><body>stable content</body></html>',
  });
  // Simulate a page that keeps producing network activity (e.g. an open WebSocket / analytics
  // beacon) throughout the capture — settling must never require this to go quiet.
  const networkObserver = makeFakeNetworkObserver();
  (networkObserver.counters as { websocketConnections: number }).websocketConnections = 1;
  (networkObserver.counters as { requests: number }).requests = 42;

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/live-feed',
    pageIndex: 0,
    pagesDir,
    settleMs: 5_000,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver,
  });

  assert.equal(record.status, 'visited');
  assert.ok(record.htmlPath && fs.existsSync(record.htmlPath));
});

test('FIX-09: a DOM that never stabilizes is still recorded visited (best-effort capture), with the settle timeout as a non-fatal diagnostic', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    // Content keeps changing on every single poll — never two consecutive identical samples.
    // Simulates a real-world SPA that keeps mutating its DOM (ongoing WebSocket/analytics
    // traffic, animations) well past a short settle window.
    htmlAtTick: (tick) => `<html><body>tick-${tick}</body></html>`,
  });

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/never-settles',
    pageIndex: 0,
    pagesDir,
    settleMs: 150,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  // Navigation succeeded (HTTP 200), so the visit is 'visited' even though the settle-poll loop
  // never converged — only the settleStatus/diagnostic distinguishes this from a clean settle.
  assert.equal(record.status, 'visited');
  assert.equal(record.failureReason, undefined);
  assert.equal(record.settleStatus, 'timeout');
  assert.ok(record.htmlPath && fs.existsSync(record.htmlPath));
  assert.ok(record.tracePath && fs.existsSync(record.tracePath));
  assert.equal(record.finalUrl, 'https://example.test/page');

  const trace = JSON.parse(fs.readFileSync(record.tracePath!, 'utf8'));
  assert.ok(trace.notes.some((note: string) => note.includes('page_settle_timeout')));
});

// --- FIX-04 named regression: run 2026-08-10T14-58-23-014Z-360a9ab9 ---
// The second /rules navigation in that run recorded final URL /en/rules but saved homepage HTML,
// because a fixed sleep elapsed before the SPA swapped its content in. These two tests prove that
// failure mode is now structurally impossible: either the destination DOM is what gets saved, or
// no 'visited' snapshot is produced at all.

test('regression 2026-08-10T14-58-23-014Z-360a9ab9: final URL updates immediately but content swap lags — destination DOM is captured, not stale homepage HTML', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    urlAtTick: () => 'https://example.test/en/rules',
    // A visible loading indicator (e.g. a route-transition skeleton) is present for the first
    // few ticks while the SPA is still showing the outgoing page's markup underneath it, then
    // clears at the same moment the destination markup swaps in — the realistic shape of the
    // real regression, and the reason the settle routine's loading-indicator gate (not DOM
    // stability alone) is what actually prevents the stale-homepage-under-/en/rules capture.
    htmlAtTick: (tick) => (tick < 3 ? '<html><body>Homepage</body></html>' : '<html><body>Rules page content</body></html>'),
    loadingIndicatorAtTick: (tick) => tick < 3,
  });

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/en/rules',
    pageIndex: 0,
    pagesDir,
    settleMs: 5_000,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'visited');
  assert.equal(record.finalUrl, 'https://example.test/en/rules');
  const savedHtml = fs.readFileSync(record.htmlPath!, 'utf8');
  assert.match(savedHtml, /Rules page content/);
  assert.doesNotMatch(savedHtml, /Homepage/);
});

test('regression 2026-08-10T14-58-23-014Z-360a9ab9: final URL is /en/rules but a visible loading indicator never clears — captured as a best-effort visited snapshot with settleStatus: timeout, never reported as a clean settle', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    urlAtTick: () => 'https://example.test/en/rules',
    // The exact bug shape: URL already reflects the new route, but the SPA is still mid-render
    // (a visible loading-state candidate never clears) for the entire bounded settle budget —
    // the settle routine's own passive-detector check must refuse to call this "settled",
    // regardless of how stable the underlying (still-transitional) markup otherwise looks.
    htmlAtTick: () => '<html><body>Homepage</body></html>',
    loadingIndicatorAtTick: () => true,
  });

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/en/rules',
    pageIndex: 0,
    pagesDir,
    settleMs: 150,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  // Navigation to /en/rules succeeded, so the visit is still 'visited' — but settleStatus:
  // 'timeout' means a consumer must not treat the saved (still possibly-stale) HTML as a
  // converged, fully-trustworthy snapshot the way a 'settled' capture would be.
  assert.equal(record.status, 'visited');
  assert.equal(record.failureReason, undefined);
  assert.equal(record.settleStatus, 'timeout');
  assert.ok(record.htmlPath && fs.existsSync(record.htmlPath));
  assert.equal(record.finalUrl, 'https://example.test/en/rules');
});

// --- FIX-05: soft-404/error-page classification ---

test('FIX-05 tier 1: HTTP 200 that resolves to a final /404 route is classified as a failed, non-successful visit, and writes no snapshot', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    status: 200,
    urlAtTick: () => 'https://example.test/404',
    htmlAtTick: () => '<html><body>generic site chrome, not necessarily error copy</body></html>',
  });

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/deposit-limits',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  // Requested/final URLs are recorded verbatim — no different guessed path is invented.
  assert.equal(record.requestedUrl, 'https://example.test/deposit-limits');
  assert.equal(record.finalUrl, 'https://example.test/404');
  assert.equal(record.httpStatus, 200);
  assert.equal(record.status, 'failed');
  assert.equal(record.failureReason, 'soft_404_error_route');
  assert.equal(record.errorPageClassification, 'error_page');
  assert.ok(record.errorPageSignals && record.errorPageSignals.length > 0);
  assert.ok(record.errorPageReason);
  assert.equal(record.htmlPath, undefined);
  assert.equal(record.tracePath, undefined);
  assert.deepEqual(fs.readdirSync(pagesDir), []);
});

test('FIX-05 tier 2: a genuine HTTP 404 remains a failed visit classified as error_page', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: 404 }),
    requestedUrl: 'https://example.test/missing',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.failureReason, 'http_client_error');
  assert.equal(record.errorPageClassification, 'error_page');
  assert.ok(record.errorPageSignals?.some((s) => s.startsWith('http_status:')));
});

test('FIX-05 tier 3: a page that keeps its requested URL/status but shows strong title+body error markers is marked suspected_error_page, not forced to fail', async () => {
  const pagesDir = makeTmpPagesDir();
  const page = makeScriptedSettlePage({
    status: 200,
    urlAtTick: () => 'https://example.test/promotions/summer-bonus',
    htmlAtTick: () => '<html><body><h1>404</h1><p>Sorry, this page not found.</p></body></html>',
  });
  // Override title to a generic error-style title (page.title() is not scripted per-tick above).
  (page as unknown as { title: () => Promise<string> }).title = async () => '404 Not Found';

  const record = await capturePage({
    page,
    requestedUrl: 'https://example.test/promotions/summer-bonus',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    settlePollIntervalMs: 1,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  // Ambiguous content-only case: still a real, saved visit — never forced to a hard failure, and
  // never re-navigated to some other guessed URL.
  assert.equal(record.status, 'visited');
  assert.equal(record.requestedUrl, 'https://example.test/promotions/summer-bonus');
  assert.equal(record.finalUrl, 'https://example.test/promotions/summer-bonus');
  assert.equal(record.errorPageClassification, 'suspected_error_page');
  assert.ok(record.errorPageSignals && record.errorPageSignals.length >= 2);
  assert.ok(record.errorPageReason);
  assert.ok(record.htmlPath && fs.existsSync(record.htmlPath));
  assert.ok(record.tracePath && fs.existsSync(record.tracePath));
});

test('FIX-05: an ordinary page with clean content is classified ok and never flagged', async () => {
  const pagesDir = makeTmpPagesDir();
  const record = await capturePage({
    page: makeFakePage({ status: 200 }),
    requestedUrl: 'https://example.test/payments',
    pageIndex: 0,
    pagesDir,
    settleMs: 0,
    navigationTimeoutMs: 1000,
    discoveredBy: [],
    networkObserver: makeFakeNetworkObserver(),
  });

  assert.equal(record.status, 'visited');
  assert.equal(record.errorPageClassification, 'ok');
  assert.equal(record.errorPageSignals, undefined);
  assert.equal(record.errorPageReason, undefined);
});

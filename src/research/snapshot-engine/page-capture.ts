import type { Page } from 'playwright';
import { collectPassiveInteractivity, hasVisibleLoadingIndicator } from './passive-interactivity.ts';
import type { AutomaticDialogTrace, PagePassiveTrace, VisitedPageRecord } from './types.ts';
import { sha256, stablePageBasename, writeJsonAtomic, writeTextAtomic } from './io.ts';
import path from 'node:path';
import type { PassiveNetworkObserver } from './url-discovery.ts';

export interface PageCaptureOptions {
  page: Page;
  requestedUrl: string;
  pageIndex: number;
  pagesDir: string;
  // FIX-04: interpreted as the bounded *maximum* wait budget for deterministic page settling
  // (final URL + document readiness + rendered-DOM content-hash stable across consecutive
  // samples, with no visible loading-state candidate), not a fixed sleep. A run that settles
  // sooner than this budget returns as soon as it does; a run that never settles is bounded by
  // this value and reported as an explicit settle-timeout error, never a silent success.
  settleMs: number;
  navigationTimeoutMs: number;
  discoveredBy: VisitedPageRecord['discoveredBy'];
  networkObserver: PassiveNetworkObserver;
  // FIX-04: overridable knobs for the settle poll loop; all default to production-safe values so
  // normal runs (and every existing caller that doesn't pass these) are unaffected.
  settlePollIntervalMs?: number;
  settleStableSamples?: number;
}

// FIX-04: the only `document.readyState` value that unambiguously means "document has not
// finished its own initial load" is 'loading'. A page still in that state can never be
// considered settled regardless of how stable its current (transitional) DOM looks. Anything
// else recognizable as a readyState ('interactive' | 'complete') is terminal; an environment
// that can't meaningfully answer the probe at all (e.g. a non-browser test double) fails open
// to 'complete' rather than fails closed forever — real Playwright pages always resolve this to
// one of the three genuine DOM readyState values.
const NON_TERMINAL_READY_STATE = 'loading';

const DEFAULT_SETTLE_POLL_INTERVAL_MS = 200;
const DEFAULT_SETTLE_STABLE_SAMPLES = 2;

interface SettleSample {
  url: string;
  readyState: string;
  domSignature: string;
  loadingIndicatorPresent: boolean;
}

async function sampleSettleState(page: Page): Promise<SettleSample> {
  const url = page.url();
  const readyStateRaw = await page.evaluate(() => document.readyState).catch(() => 'complete');
  // Strict boolean check: only an unambiguous `true` from the passive loading-indicator detector
  // counts as "a loading indicator is present". Anything else (false, undefined, or a value from
  // an environment that doesn't implement the probe) is treated as "no known indicator" rather
  // than defaulting to "always loading" for such environments.
  const loadingIndicatorPresent = (await hasVisibleLoadingIndicator(page).catch(() => false)) === true;
  const html = await page.content().catch(() => '');
  return {
    url,
    readyState: typeof readyStateRaw === 'string' ? readyStateRaw : 'complete',
    domSignature: `${html.length}:${sha256(html)}`,
    loadingIndicatorPresent,
  };
}

function samplesMatch(a: SettleSample, b: SettleSample): boolean {
  return a.url === b.url && a.readyState === b.readyState && a.domSignature === b.domSignature;
}

function isSettleCandidate(sample: SettleSample): boolean {
  return sample.readyState !== NON_TERMINAL_READY_STATE && !sample.loadingIndicatorPresent;
}

export interface SettleResult {
  settled: boolean;
  sample: SettleSample;
  attempts: number;
  elapsedMs: number;
}

// FIX-04: bounded, passive-only settle routine. Never performs a click/fill/select/hover/
// pagination/load-more/deliberate-scroll — purely observes url/readyState/DOM-content-hash/
// loading-indicator state on an interval until either:
//   - `stableRequired` consecutive samples agree on url+readyState+DOM-signature, the document
//     has reached a terminal readyState, and no visible loading-indicator candidate is present
//     (settled: true), or
//   - the bounded `maxWaitMs` budget is exhausted (settled: false) — the last sample taken is
//     still returned so a caller can decide what (if anything) to do with it, but it is never
//     silently treated as equivalent to a settled sample by this function itself.
// Deliberately does NOT wait for 'networkidle' — casino pages may hold WebSocket/analytics
// connections open indefinitely, and requiring network silence would make settling effectively
// unbounded/impossible on such pages.
export async function waitForPageSettle(
  page: Page,
  maxWaitMs: number,
  options: { pollIntervalMs?: number; stableRequired?: number } = {},
): Promise<SettleResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS;
  const stableRequired = Math.max(1, options.stableRequired ?? DEFAULT_SETTLE_STABLE_SAMPLES);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, maxWaitMs);

  let previous: SettleSample | undefined;
  let stableCount = 0;
  let attempts = 0;
  let last: SettleSample;

  while (true) {
    last = await sampleSettleState(page);
    attempts += 1;

    if (isSettleCandidate(last) && previous && samplesMatch(previous, last)) {
      stableCount += 1;
    } else {
      stableCount = isSettleCandidate(last) ? 1 : 0;
    }

    // No time budget for further polling (e.g. settleMs: 0 in fast test fixtures): accept a
    // single sample as settled only if it already looks terminal/stable on its own — never
    // relax the readyState/loading-indicator gate itself.
    const noBudgetForMorePolls = maxWaitMs <= 0;
    if (stableCount >= stableRequired || (noBudgetForMorePolls && stableCount >= 1)) {
      return { settled: true, sample: last, attempts, elapsedMs: Date.now() - startedAt };
    }

    if (Date.now() >= deadline) {
      return { settled: false, sample: last, attempts, elapsedMs: Date.now() - startedAt };
    }

    previous = last;
    const remaining = deadline - Date.now();
    await page.waitForTimeout(Math.max(0, Math.min(pollIntervalMs, remaining)));
  }
}

export async function capturePage(options: PageCaptureOptions): Promise<VisitedPageRecord> {
  const started = new Date();
  const dialogs: AutomaticDialogTrace[] = [];
  const onDialog = async (dialog: import('playwright').Dialog) => {
    dialogs.push({
      type: dialog.type(),
      message: dialog.message().slice(0, 500),
      defaultValue: dialog.defaultValue()?.slice(0, 500) || undefined,
      autoDismissedForCrawl: true,
    });
    try {
      await dialog.dismiss();
    } catch {
      // Dialog may already be gone; trace still records that it occurred.
    }
  };

  options.page.on('dialog', onDialog);
  try {
    const response = await options.page.goto(options.requestedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs,
    });

    const httpStatusFromResponse = response?.status();

    if (httpStatusFromResponse !== undefined && (httpStatusFromResponse >= 400 || httpStatusFromResponse < 200)) {
      // Terminal HTTP status: do not save a normal successful-page snapshot/trace, and do not
      // spend the settle budget on a page we already know we won't capture.
      await options.networkObserver.flush();
      const completed = new Date();
      return {
        requestedUrl: options.requestedUrl,
        finalUrl: options.page.url(),
        status: 'failed',
        httpStatus: httpStatusFromResponse,
        failureReason: httpStatusFromResponse >= 500 ? 'http_server_error' : 'http_client_error',
        discoveredBy: options.discoveredBy,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        error: {
          name: 'HttpStatusError',
          message: `Navigation resolved with unusable HTTP status ${httpStatusFromResponse}`,
        },
      };
    }

    // FIX-04: replaces the fixed `page.waitForTimeout(settleMs)` capture rule. Bounded,
    // passive-only polling decides readiness — never an unbounded wait, never `networkidle`
    // (casino pages may hold WebSocket/analytics connections open indefinitely).
    const settleResult = await waitForPageSettle(options.page, options.settleMs, {
      pollIntervalMs: options.settlePollIntervalMs,
      stableRequired: options.settleStableSamples,
    });
    await options.networkObserver.flush();

    const finalUrl = settleResult.sample.url || options.page.url();
    const httpStatus = httpStatusFromResponse;

    if (!settleResult.settled) {
      // Navigation itself completed (finalUrl/httpStatus are preserved), but the page never
      // reached a stable, terminal-ready, loading-indicator-free state within the bounded
      // settle budget. Never silently mark a transitional/possibly-stale DOM as a valid
      // 'visited' snapshot — record an explicit settle-timeout error instead. No HTML/trace is
      // written for this outcome, matching every other 'failed' terminal state.
      const completed = new Date();
      return {
        requestedUrl: options.requestedUrl,
        finalUrl,
        status: 'failed',
        httpStatus,
        failureReason: 'page_settle_timeout',
        discoveredBy: options.discoveredBy,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        error: {
          name: 'PageSettleTimeoutError',
          message:
            `Page did not settle within ${options.settleMs}ms (url=${settleResult.sample.url}, ` +
            `readyState=${settleResult.sample.readyState}, ` +
            `loadingIndicatorPresent=${settleResult.sample.loadingIndicatorPresent}, ` +
            `attempts=${settleResult.attempts}, elapsedMs=${settleResult.elapsedMs})`,
        },
      };
    }

    const title = await options.page.title().catch(() => undefined);
    const html = await options.page.content();
    const passive = await collectPassiveInteractivity(options.page);
    const basename = stablePageBasename(options.pageIndex, finalUrl || options.requestedUrl);
    const htmlPath = path.join(options.pagesDir, `${basename}.html`);
    const tracePath = path.join(options.pagesDir, `${basename}.trace.json`);
    const trace: PagePassiveTrace = {
      schemaVersion: '1.0',
      requestedUrl: options.requestedUrl,
      finalUrl,
      capturedAt: new Date().toISOString(),
      title,
      interactiveElements: passive.interactiveElements,
      visibleOverlays: passive.visibleOverlays,
      frames: passive.frames,
      automaticDialogs: dialogs,
      network: { ...options.networkObserver.counters },
      runtimeSignals: passive.runtimeSignals,
      notes: [
        'Passive-only profile: no element click, hover, keyboard activation, form fill, selection, pagination, load-more, or controlled scroll was executed.',
        ...passive.notes,
      ],
    };

    await writeTextAtomic(htmlPath, html);
    await writeJsonAtomic(tracePath, trace);

    const completed = new Date();
    return {
      requestedUrl: options.requestedUrl,
      finalUrl,
      status: 'visited',
      httpStatus,
      title,
      htmlPath,
      tracePath,
      htmlSha256: sha256(html),
      discoveredBy: options.discoveredBy,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
    };
  } catch (error) {
    const completed = new Date();
    return {
      requestedUrl: options.requestedUrl,
      finalUrl: options.page.url() || undefined,
      status: 'failed',
      failureReason: 'navigation_exception',
      discoveredBy: options.discoveredBy,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    options.page.off('dialog', onDialog);
  }
}

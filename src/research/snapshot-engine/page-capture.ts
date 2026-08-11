import type { Page } from 'playwright';
import { collectPassiveInteractivity, hasVisibleLoadingIndicator } from './passive-interactivity.ts';
import { controlledScrollPass, executeInteractionCandidates } from './interaction-delta-profiler.ts';
import { executeBoundedRevealCandidates } from './bounded-reveal.ts';
import type {
  AutomaticDialogTrace,
  ErrorPageClassification,
  InteractionMode,
  PagePassiveTrace,
  SettleStatus,
  VisitedPageRecord,
} from './types.ts';
import { sha256, stablePageBasename, writeJsonAtomic, writeTextAtomic } from './io.ts';
import path from 'node:path';
import { withTimeout, TimeoutError, type PassiveNetworkObserver } from './url-discovery.ts';
import { DEFAULT_RUNTIME_BUDGETS } from './runtime-config.ts';
import { detectSoftErrorSignals, isErrorRoutePath } from './error-page-rules.ts';

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
  // FIX-02: the run's declared interaction contract. Defaults to 'passive_only' — the only value
  // that exists today — so every existing/omitted caller stays passive by default rather than
  // opting into execution implicitly. CD-N04's executeInteractionCandidates (the one function in
  // this codebase that can dispatch a mutating Playwright action) is invoked ONLY when this is
  // set to something other than 'passive_only'; see the `runInteractions` gate below. No caller
  // in this codebase currently sets a non-passive value — that is reserved for FIX-03.
  interactionMode?: InteractionMode;
  interactionActionTimeoutMs?: number;
  interactionDeltaSettleMs?: number;
  interactionDeltaSettlePollIntervalMs?: number;
  interactionMaxCandidates?: number;
  // FIX-03: bounded_reveal-only action-count budgets, ignored under any other interactionMode.
  boundedRevealMaxActionsPerPage?: number;
  boundedRevealMaxActionsPerAdapter?: number;
  lazyScrollEnabled?: boolean;
  lazyScrollMaxRounds?: number;
  lazyScrollStableRoundsRequired?: number;
  lazyScrollRoundBudgetMs?: number;
  // CD-N07: bounds the WHOLE interaction-expansion pass (all executed candidates plus the
  // lazy-scroll pass) for this page — separate from, and generous relative to, the per-action/
  // per-scroll-round budgets above, so a page whose candidates individually respect their own
  // bounds but collectively never stop expanding (e.g. an unbounded chain of newly-revealed
  // candidates) still can't hold up the page beyond this ceiling.
  interactionExpansionTimeoutMs?: number;
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
      // FIX-05 tier 2: HTTP status is already the strong signal here (no need to consult the
      // route pattern or content heuristic — those are lower priority than a genuine 4xx/5xx).
      return {
        requestedUrl: options.requestedUrl,
        finalUrl: options.page.url(),
        status: 'failed',
        httpStatus: httpStatusFromResponse,
        failureReason: httpStatusFromResponse >= 500 ? 'http_server_error' : 'http_client_error',
        errorPageClassification: 'error_page',
        errorPageSignals: [`http_status:${httpStatusFromResponse}`],
        errorPageReason: `Navigation resolved with unusable HTTP status ${httpStatusFromResponse}`,
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

    // FIX-09: navigation already succeeded (httpStatusFromResponse was checked above), so a
    // settle-poll timeout is no longer treated as a page-visit failure. The bounded settle
    // routine is best-effort: whatever DOM was observed at the last sample is captured and
    // saved either way, and `settleStatus` tells a downstream consumer whether the capture is
    // a clean, converged snapshot ('settled') or a best-effort one taken after the settle
    // budget ran out ('timeout') — never silently indistinguishable from each other.
    const settleStatus: SettleStatus = settleResult.settled ? 'settled' : 'timeout';

    // FIX-05 tier 1: the strongest signal after a genuinely bad HTTP status (tier 2, already
    // ruled out above) — the browser followed a same-origin redirect/rewrite to a final URL
    // that itself matches a versioned generic error-route pattern (see error-page-rules.ts),
    // despite the transport reporting HTTP 200. This is never a hostname/brand-specific check
    // and never triggers a second, differently-guessed navigation — the page that was actually
    // reached is simply recorded as a failed visit with its real requested/final URL intact.
    let finalPath = '';
    try {
      finalPath = new URL(finalUrl).pathname;
    } catch {
      // finalUrl came back non-parseable (should not happen for a real Playwright page.url());
      // leave finalPath empty so the route-pattern check below simply doesn't match.
    }
    if (isErrorRoutePath(finalPath)) {
      const completed = new Date();
      return {
        requestedUrl: options.requestedUrl,
        finalUrl,
        status: 'failed',
        httpStatus,
        settleStatus,
        failureReason: 'soft_404_error_route',
        errorPageClassification: 'error_page',
        errorPageSignals: [`final_url_matches_error_route:${finalPath}`],
        errorPageReason: `Final URL resolved to a configured terminal error route (${finalPath}) despite HTTP ${httpStatus ?? 'unknown'} status.`,
        discoveredBy: options.discoveredBy,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        error: {
          name: 'SoftErrorRouteError',
          message: `Navigation to ${options.requestedUrl} resolved to error route ${finalPath}`,
        },
      };
    }

    const title = await options.page.title().catch(() => undefined);
    const html = await options.page.content();

    // FIX-05 tier 3 (optional, lowest priority): the page kept its requested route and returned
    // a clean HTTP status (tiers 1/2 already ruled out above), but its own title/body copy
    // carries multiple independent generic error-page markers. Deliberately never forces a
    // hard failure — flagged as `suspected_error_page` only, still captured/saved/reported as a
    // normal `status: 'visited'` record, so ambiguous content-only evidence is surfaced for
    // review rather than silently discarded or silently retried against a guessed alternate URL.
    const softError = detectSoftErrorSignals({ title, html });
    const errorPageClassification: ErrorPageClassification = softError.suspected ? 'suspected_error_page' : 'ok';
    const errorPageSignals = softError.suspected ? softError.signals : undefined;
    const errorPageReason = softError.suspected
      ? 'Page kept its requested URL and HTTP status, but independent title and body error-page markers were both detected.'
      : undefined;

    const passive = await collectPassiveInteractivity(options.page);

    // CD-N04: deterministic interaction execution against the live page, seeded from the passive
    // trace candidates above. Runs only when there is actually something to do — a page with no
    // detected interactive elements and no lazy-load signal never invokes this machinery.
    let interactionExecutions: PagePassiveTrace['interactionExecutions'];
    let lazyScrollPass: PagePassiveTrace['lazyScrollPass'];
    const interactionMode: InteractionMode = options.interactionMode ?? 'passive_only';
    // FIX-02/FIX-03: hard gate. `executeInteractionCandidates` (full CD-N04 vocabulary, including
    // modal_trigger/payment_method_card/pagination) and `executeBoundedRevealCandidates` (the
    // FIX-03 allowlist-only adapter set) are the only functions in this codebase that can call a
    // Playwright mutating action (click/fill/select/hover/press) — a passive_only run must be
    // structurally incapable of reaching either, not merely configured not to by default. A
    // bounded_reveal run is routed to the narrower, allowlist-gated executor, never the full one.
    const interactionExecutionEnabled = interactionMode !== 'passive_only';
    const lazyScrollEnabled = options.lazyScrollEnabled ?? true;
    // controlledScrollPass only ever calls window.scrollTo via page.evaluate() — no Playwright
    // locator/mouse/keyboard action — so it stays available under passive_only; it is not part of
    // the mutating-action vocabulary this ticket forbids (click/fill/select/hover/press/load-more
    // refers to activating a load-more *control*, never to a passive scroll of the viewport).
    const runLazyScroll =
      lazyScrollEnabled && (passive.runtimeSignals.lazyImageCount > 0 || passive.runtimeSignals.lazySourceCount > 0);
    const runInteractions = interactionExecutionEnabled && passive.interactiveElements.length > 0;

    // CD-N07: the whole interaction-expansion pass (executed candidates + lazy-scroll pass) is
    // bounded as one unit — a lazy-load surface, or a chain of candidates, that never stabilizes
    // must still stop at this ceiling rather than holding up the page indefinitely, even though
    // each individual action/scroll round already respects its own tighter budget.
    if (runInteractions || runLazyScroll) {
      const interactionExpansionTimeoutMs = options.interactionExpansionTimeoutMs ?? DEFAULT_RUNTIME_BUDGETS.interactionExpansionTimeoutMs;
      try {
        await withTimeout(
          (async () => {
            if (runInteractions && interactionMode === 'bounded_reveal') {
              interactionExecutions = await executeBoundedRevealCandidates(
                options.page,
                passive.interactiveElements,
                options.requestedUrl,
                {
                  actionTimeoutMs: options.interactionActionTimeoutMs,
                  deltaSettleMs: options.interactionDeltaSettleMs,
                  deltaSettlePollIntervalMs: options.interactionDeltaSettlePollIntervalMs,
                  maxActionsPerPage: options.boundedRevealMaxActionsPerPage,
                  maxActionsPerAdapter: options.boundedRevealMaxActionsPerAdapter,
                },
              ).catch((error) => {
                // A profiler-level failure (as opposed to one candidate's own recorded outcome)
                // must never fail the whole page capture.
                passive.notes.push(
                  `bounded_reveal_execution_failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                return undefined;
              });
            } else if (runInteractions) {
              interactionExecutions = await executeInteractionCandidates(options.page, passive.interactiveElements, {
                actionTimeoutMs: options.interactionActionTimeoutMs,
                deltaSettleMs: options.interactionDeltaSettleMs,
                deltaSettlePollIntervalMs: options.interactionDeltaSettlePollIntervalMs,
                maxCandidates: options.interactionMaxCandidates,
              }).catch((error) => {
                // A profiler-level failure (as opposed to one candidate's own recorded outcome)
                // must never fail the whole page capture.
                passive.notes.push(
                  `interaction_execution_failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                return undefined;
              });
            }
            if (runLazyScroll) {
              lazyScrollPass = await controlledScrollPass(options.page, {
                maxRounds: options.lazyScrollMaxRounds,
                stableRoundsRequired: options.lazyScrollStableRoundsRequired,
                roundBudgetMs: options.lazyScrollRoundBudgetMs,
              }).catch((error) => {
                passive.notes.push(`lazy_scroll_pass_failed: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
              });
            }
          })(),
          interactionExpansionTimeoutMs,
          `Interaction-expansion pass exceeded ${interactionExpansionTimeoutMs}ms deadline`,
        );
      } catch (error) {
        // Only a bounded-deadline timeout is downgraded to a best-effort note here — evidence
        // already captured (any interactionExecutions/lazyScrollPass results resolved before the
        // deadline fired) is preserved as-is; whatever hadn't finished yet is simply abandoned,
        // never awaited to completion. Any non-timeout exception keeps propagating unchanged.
        if (!(error instanceof TimeoutError)) throw error;
        passive.notes.push(`interaction_expansion_timeout: ${error.message}`);
      }
    }

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
      interactionExecutions,
      lazyScrollPass,
      notes: [
        // CD-N04: the passive trace above is a candidate seed, never proof by itself that hidden
        // content was collected. `interactionExecutions` (when present) records exactly which of
        // those candidates were actually promoted to a stable action class and executed, with a
        // terminal per-candidate outcome — a bare candidate that was never executed keeps no
        // outcome label at all.
        interactionExecutions && interactionExecutions.length > 0
          ? `interaction_execution: ${interactionExecutions.length} candidate(s) executed against the live page under the ` +
            'bounded deterministic protocol (trial action, one real action, delta-settle, before/after delta, restore-to-baseline).'
          : 'interaction_execution: no eligible candidate was promoted to an allowed action class on this page.',
        ...(settleStatus === 'timeout'
          ? [
              `page_settle_timeout: page did not settle within ${options.settleMs}ms (url=${settleResult.sample.url}, ` +
                `readyState=${settleResult.sample.readyState}, ` +
                `loadingIndicatorPresent=${settleResult.sample.loadingIndicatorPresent}, ` +
                `attempts=${settleResult.attempts}, elapsedMs=${settleResult.elapsedMs}); HTML/trace below are a ` +
                'best-effort capture of the last observed sample, not a converged snapshot.',
            ]
          : []),
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
      settleStatus,
      errorPageClassification,
      errorPageSignals,
      errorPageReason,
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

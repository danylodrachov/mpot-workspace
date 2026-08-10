import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import { runPostRunReview } from './post-run-review.ts';
import type { BrowserContext, Page } from 'playwright';
import type {
  ReviewInputDocument,
  SourceCoverageRecord,
  UrlDecisionRecord,
  UrlInventoryDocument,
  VisitedPageRecord,
} from './types.ts';

// FIX-06: one end-to-end regression that runs the actual public entry point used by
// /casino-discovery (crawlSite from crawler.ts, the same function cli.ts's main() calls after
// attaching the authenticated CDP session) against a single synthetic fixture site that
// reproduces every factual shape observed in run 2026-08-10T14-58-23-014Z-360a9ab9:
//   - a localized/non-localized alias pair for both /payments and /rules
//   - a promotions category page and a promotion detail page (nested nesting depth 2)
//   - live-casino and virtual-sports product-category pages (bare route shape, canonicalized)
//   - a /sport/<category> root plus a deeply nested league/event route that must canonicalize
//     to the same category root (an alias, not a second visit)
//   - an individual game route that must never be visited
//   - an API route and a query-string variant, both explicit TBD
//   - a JS asset URL, explicit TBD
//   - one page (the promotion detail page) whose DOM only reaches its destination content a few
//     settle-poll ticks after domcontentloaded (delayed SPA render)
//   - one page (rules) with a child frame that is detached/unusable (evaluate() rejects the way
//     a real "Execution context was destroyed" error would), while the main frame's own
//     discovery/capture still succeeds
//   - one page (live-casino) where a network response body becomes unavailable (rejects) during
//     its visit
//   - interactive controls present in the passive trace of a visited page that are never clicked
//
// This test does not duplicate url-rules.test.ts (pure decideUrl unit coverage), crawler.test.ts
// (crawl-loop plumbing/watchdog coverage), page-capture.test.ts (settle-routine unit coverage),
// url-discovery.test.ts (extractor unit coverage), or regression-spinboss.test.ts (FIX-09's
// narrower stuck-response-body + 404/TBD regression). It is the one comprehensive, deterministic,
// full-pipeline regression: crawlSite() end to end, then runPostRunReview() over its own output,
// with no scorer/relevance-gate/visit-plan/field-collector/normaliser/gap-probe/browser-capable
// LLM agent import anywhere in this file (only crawler.ts's and post-run-review.ts's own public
// entry points are used).

interface FakeFrame {
  url(): string;
  name(): string;
  parentFrame(): undefined;
  evaluate: (fn: (...args: unknown[]) => unknown, arg?: unknown) => Promise<unknown>;
}

function passiveInteractivityResult(withInteractiveControls: boolean) {
  return {
    interactive: withInteractiveControls
      ? [
          {
            frameUrl: 'https://example.test/en/promotions/casino/daily-cashback-15',
            domPath: 'button[data-testid="claim-button"]',
            tag: 'button',
            role: 'button',
            name: 'Claim bonus',
            visible: true,
            disabled: false,
            contentEditable: false,
            cursorPointer: true,
            eventAttributeHints: [],
            detectorHints: ['button'],
          },
        ]
      : [],
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

const ENTRY_URL = 'https://example.test/en/';
const PAYMENTS_URL = 'https://example.test/en/payments';
const RULES_URL = 'https://example.test/en/rules';
const PROMOTIONS_URL = 'https://example.test/en/promotions';
const PROMOTION_DETAIL_URL = 'https://example.test/en/promotions/casino/daily-cashback-15';
const LIVE_CASINO_URL = 'https://example.test/en/casino/live-casino';
const VIRTUAL_SPORTS_URL = 'https://example.test/en/virtual-sports';
const SPORT_FOOTBALL_URL = 'https://example.test/en/sport/football';

// A DOM-detected child frame (e.g. a live-chat widget) whose execution context is/becomes
// unusable — every evaluate() call on it rejects the way a real detached-frame navigation would.
const DETACHED_FRAME_URL = 'https://example.test/en/live-chat-widget';

function makeFixtureEnvironment(callLog: string[]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = ENTRY_URL;
  let navigationCount = 0;
  let settleTick = 0;

  const mainFrame: FakeFrame = {
    url: () => currentUrl,
    name: () => '',
    parentFrame: () => undefined,
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('candidateSet')) {
        return passiveInteractivityResult(currentUrl === PROMOTION_DETAIL_URL);
      }
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      if (src.includes('getBoundingClientRect')) {
        // Loading-indicator probe: only the SPA-delay page shows a transient indicator, and only
        // for its first tick.
        if (currentUrl === PROMOTION_DETAIL_URL) return settleTick < 2;
        return false;
      }
      if (src.includes('document.readyState')) return 'complete';
      if (navigationCount === 0) {
        // Bootstrap discovery reads the already-authenticated entry page's DOM once, before any
        // navigation the crawl loop performs.
        return [
          { value: '/payments', attribute: 'href' },
          { value: '/en/payments', attribute: 'href' },
          { value: '/rules', attribute: 'href' },
          { value: '/en/rules', attribute: 'href' },
          { value: '/en/promotions', attribute: 'href' },
          { value: '/en/promotions/casino/daily-cashback-15', attribute: 'href' },
          { value: '/en/casino/live-casino', attribute: 'href' },
          { value: '/en/virtual-sports', attribute: 'href' },
          { value: '/en/sport/football', attribute: 'href' },
          { value: '/en/sport/football/england/premier-league', attribute: 'href' },
          { value: '/en/game/starburst', attribute: 'href' },
          { value: '/en/api/session', attribute: 'href' },
          { value: '/en/promotions?ref=hero-banner', attribute: 'href' },
          { value: '/assets/app.bundle.js', attribute: 'href' },
        ];
      }
      return [];
    },
  };

  const detachedFrame: FakeFrame = {
    url: () => DETACHED_FRAME_URL,
    name: () => 'live-chat-widget',
    parentFrame: () => undefined,
    evaluate: async () => {
      throw new Error('Execution context was destroyed, most likely because of a navigation.');
    },
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
      settleTick = 0;
      if (url === LIVE_CASINO_URL) {
        // One response body that becomes unavailable during this visit — must be recorded as a
        // source error without failing the page itself or any other page.
        listeners.get('response')?.({
          url: () => 'https://example.test/en/api/live-casino-feed.json',
          headers: () => ({ 'content-type': 'application/json' }),
          body: () => Promise.reject(new Error('net::ERR_ABORTED (response body unavailable)')),
          request: () => ({ resourceType: () => 'xhr' }),
          frame: () => ({ url: () => LIVE_CASINO_URL }),
        });
      }
      return { status: () => 200 };
    },
    waitForTimeout: async () => {
      settleTick += 1;
    },
    title: async () => 'Title',
    content: async () => {
      if (currentUrl === PROMOTION_DETAIL_URL) {
        return settleTick < 2
          ? '<html><body>loading placeholder</body></html>'
          : '<html><body>daily cashback 15% — destination content</body></html>';
      }
      return `<html><body>${currentUrl}</body></html>`;
    },
    frames: () => (currentUrl === RULES_URL ? [mainFrame, detachedFrame] : [mainFrame]),
    mainFrame: () => mainFrame,
    evaluate: mainFrame.evaluate,
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
  };
}

function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-engine-e2e-'));
}

function makeTemplateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-engine-e2e-templates-'));
  fs.writeFileSync(path.join(dir, 'payments.json'), JSON.stringify({ fields: ['method', 'currency'] }));
  fs.writeFileSync(path.join(dir, 'promotions.json'), JSON.stringify({ fields: ['title', 'terms'] }));
  // Explicitly excluded from templateFiles by review-input.ts — proves the exclusion still holds.
  fs.writeFileSync(path.join(dir, 'dropdowns.json'), JSON.stringify({ ignored: true }));
  return dir;
}

test('FIX-06: end-to-end regression — deterministic snapshot-engine pipeline over one synthetic multi-shape fixture site', async () => {
  const callLog: string[] = [];
  const { page, context } = makeFixtureEnvironment(callLog);
  const templateDir = makeTemplateDir();
  const outputDir = makeOutputDir();

  // --- Run the actual public entry point /casino-discovery uses (crawlSite), not an internal
  // helper. cli.ts's main() calls this exact function after attachToLoggedInChrome(); this test
  // supplies the fake page/context in its place, the same substitution pattern already used by
  // crawler.test.ts and regression-spinboss.test.ts. ---
  const manifest = await crawlSite({
    context,
    page,
    entryUrl: ENTRY_URL,
    outputDir,
    templateDir,
    settleMs: 2_000,
    navigationTimeoutMs: 1_000,
  });

  const runDir = path.join(outputDir, manifest.runId);

  const acceptedInventory = JSON.parse(
    fs.readFileSync(path.join(runDir, 'accepted-url-inventory.json'), 'utf-8'),
  ) as UrlDecisionRecord[];
  const rejectedAndTbd = JSON.parse(
    fs.readFileSync(path.join(runDir, 'deterministic-rejected-urls.json'), 'utf-8'),
  ) as UrlDecisionRecord[];
  const pageVisits = fs
    .readFileSync(path.join(runDir, 'page-visits.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as VisitedPageRecord[];
  const pageSnapshots = fs
    .readFileSync(path.join(runDir, 'page-snapshots.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{ requestedUrl: string; htmlPath: string; tracePath: string }>;
  const pageBehavior = fs
    .readFileSync(path.join(runDir, 'page-behavior.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const coverage = JSON.parse(
    fs.readFileSync(path.join(runDir, 'url-source-coverage.json'), 'utf-8'),
  ) as SourceCoverageRecord[];

  // --- 1. Only deterministic URL Rules decide visitability: every accepted row carries a
  // URLR_* ruleId, and no accepted/rejected/tbd row exists without one. ---
  for (const row of [...acceptedInventory, ...rejectedAndTbd]) {
    assert.match(row.ruleId, /^URLR_/, `expected a URL Rules ruleId, got ${row.ruleId} for ${row.rawUrl}`);
  }

  // --- 2/3. All 7 distinct canonical research pages accepted exactly once; locale aliases
  // (/payments+/en/payments, /rules+/en/rules) and the nested sport route merge into one
  // canonical target each rather than creating duplicate visits. ---
  const acceptedCanonicalUrls = acceptedInventory.map((row) => row.canonicalUrl).sort();
  assert.deepEqual(acceptedCanonicalUrls, [
    'https://example.test/casino/live-casino',
    'https://example.test/casino/virtual-sports',
    'https://example.test/payments',
    'https://example.test/promotions',
    'https://example.test/promotions/casino/daily-cashback-15',
    'https://example.test/rules',
    'https://example.test/sport/football',
  ]);
  assert.equal(pageVisits.length, 7, 'expected exactly one terminal visit record per canonical accepted target');
  assert.deepEqual(
    pageVisits.map((row) => row.canonicalUrl).sort(),
    acceptedCanonicalUrls,
  );
  const requestedUrlCounts = new Map<string, number>();
  for (const row of pageVisits) requestedUrlCounts.set(row.requestedUrl, (requestedUrlCounts.get(row.requestedUrl) ?? 0) + 1);
  for (const [url, count] of requestedUrlCounts) assert.equal(count, 1, `expected exactly one visit for ${url}, got ${count}`);
  // Locale-preferring representative was actually navigated to for each merged canonical target.
  assert.deepEqual(
    pageVisits.map((row) => row.requestedUrl).sort(),
    [PAYMENTS_URL, PROMOTIONS_URL, PROMOTION_DETAIL_URL, RULES_URL, SPORT_FOOTBALL_URL, LIVE_CASINO_URL, VIRTUAL_SPORTS_URL].sort(),
  );
  const sportFootballVisit = pageVisits.find((row) => row.canonicalUrl === 'https://example.test/sport/football');
  assert.ok(
    sportFootballVisit?.aliasUrls?.includes('https://example.test/en/sport/football/england/premier-league'),
    'expected the nested league route to be preserved as alias history on the single /sport/football visit, not a second visit',
  );
  const payVisit = pageVisits.find((row) => row.canonicalUrl === 'https://example.test/payments');
  assert.ok(payVisit?.aliasUrls?.includes('https://example.test/payments'), 'expected the non-localized /payments alias to be merged into the localized visit');
  const rulesVisit = pageVisits.find((row) => row.canonicalUrl === 'https://example.test/rules');
  assert.ok(rulesVisit?.aliasUrls?.includes('https://example.test/rules'), 'expected the non-localized /rules alias to be merged into the localized visit');
  assert.ok(pageVisits.every((row) => row.status === 'visited'), 'expected every accepted target to succeed in this fixture');

  // --- 4. Product categories and promotions are not lost as unclassified routes. ---
  const acceptedRuleIds = new Set(acceptedInventory.map((row) => row.ruleId));
  assert.ok(acceptedRuleIds.has('URLR_KEEP_CASINO_CATEGORY'), 'expected live-casino/virtual-sports to be classified as product categories');
  assert.ok(acceptedRuleIds.has('URLR_KEEP_BONUS'), 'expected promotions to be classified via the bonus/promotion keep pattern');
  assert.ok(
    acceptedRuleIds.has('URLR_KEEP_SPORT_CATEGORY') || acceptedRuleIds.has('URLR_KEEP_SPORT_CATEGORY_NORMALIZED'),
    'expected the sport category to be classified, not left unclassified',
  );

  // --- 5. Individual games/events are not visited. ---
  const gameDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/game/starburst');
  assert.equal(gameDecision?.decision, 'rejected');
  assert.equal(gameDecision?.ruleId, 'URLR_DROP_INDIVIDUAL_GAME_EVENT');
  assert.ok(!pageVisits.some((row) => row.requestedUrl.includes('/game/')), 'expected no navigation to any /game/ route');
  assert.ok(!callLog.some((entry) => entry.includes('/game/')), 'expected the browser to never navigate to an individual game route');

  // --- 6. API/assets/query variants remain non-visited TBD. ---
  const apiDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/api/session');
  assert.equal(apiDecision?.decision, 'tbd');
  assert.equal(apiDecision?.ruleId, 'URLR_TBD_API');
  const assetDecision = rejectedAndTbd.find((row) => row.rawUrl === '/assets/app.bundle.js');
  assert.equal(assetDecision?.decision, 'tbd');
  assert.equal(assetDecision?.ruleId, 'URLR_TBD_ASSET');
  const queryDecision = rejectedAndTbd.find((row) => row.rawUrl === '/en/promotions?ref=hero-banner');
  assert.equal(queryDecision?.decision, 'tbd');
  assert.equal(queryDecision?.ruleId, 'URLR_TBD_QUERY_VARIANT');
  assert.ok(!acceptedInventory.some((row) => row.rawUrl === apiDecision!.rawUrl));
  assert.ok(!acceptedInventory.some((row) => row.rawUrl === assetDecision!.rawUrl));
  assert.ok(!acceptedInventory.some((row) => row.rawUrl === queryDecision!.rawUrl));

  // --- 7. Delayed SPA pages save the correct final rendered HTML, not the transitional one. ---
  const promotionDetailSnapshot = pageSnapshots.find((row) => row.requestedUrl === PROMOTION_DETAIL_URL);
  assert.ok(promotionDetailSnapshot, 'expected a saved snapshot for the SPA-delayed promotion detail page');
  const savedHtml = fs.readFileSync(promotionDetailSnapshot!.htmlPath, 'utf-8');
  assert.match(savedHtml, /destination content/);
  assert.doesNotMatch(savedHtml, /loading placeholder/);

  // --- 8. Detached-frame and unavailable-response-body errors are recorded, without discarding
  // successful sibling discovery/visits. ---
  const frameErrorFamilies: SourceCoverageRecord[] = coverage.filter((row) =>
    ['dom_url_attribute', 'document_metadata', 'inline_script_url_token'].includes(row.sourceFamily),
  );
  assert.ok(
    frameErrorFamilies.some((row) => row.status === 'error' || row.errors.length > 0),
    'expected the detached child frame to surface as an explicit source error for at least one DOM/script family',
  );
  const bodyTokenCoverage = coverage.find((row) => row.sourceFamily === 'network_body_url_token');
  assert.ok(
    bodyTokenCoverage?.status === 'error' || (bodyTokenCoverage?.errors.length ?? 0) > 0,
    'expected the unavailable response body to surface as an explicit source error',
  );
  // The rules page (which has the detached child frame) and the live-casino page (which has the
  // unavailable response body) both still succeeded as normal visited pages, and every other page
  // succeeded too — sibling discovery/capture was never discarded because of these two errors.
  assert.equal(rulesVisit?.status, 'visited');
  const liveCasinoVisit = pageVisits.find((row) => row.canonicalUrl === 'https://example.test/casino/live-casino');
  assert.equal(liveCasinoVisit?.status, 'visited');
  assert.equal(pageVisits.filter((row) => row.status === 'visited').length, 7);

  // --- 9. Every visited page has HTML plus a passive trace (or, structurally in this codebase,
  // an explicit collection error — this fixture only exercises the success path since every
  // accepted page settles and captures cleanly). ---
  assert.equal(pageSnapshots.length, 7);
  for (const snapshot of pageSnapshots) {
    assert.ok(fs.existsSync(snapshot.htmlPath), `expected HTML file to exist: ${snapshot.htmlPath}`);
    assert.ok(fs.existsSync(snapshot.tracePath), `expected trace file to exist: ${snapshot.tracePath}`);
  }
  assert.equal(pageBehavior.length, 7, 'expected one passive-behavior trace row per successful page');

  // --- 10. Passive interactive controls are present in the trace but never actively
  // interacted with — the fake page object exposes no click/fill/hover/select method at all, so
  // any attempt by the pipeline to interact with an element would throw and fail this test. ---
  const promotionDetailBehavior = pageBehavior.find((row) => row.requestedUrl === PROMOTION_DETAIL_URL) as
    | { interactiveElements: Array<{ name?: string }> }
    | undefined;
  assert.ok(
    (promotionDetailBehavior?.interactiveElements.length ?? 0) > 0,
    'expected the promotion detail page trace to record a detected interactive control',
  );
  assert.ok(
    promotionDetailBehavior!.interactiveElements.some((el) => el.name === 'Claim bonus'),
    'expected the passive trace to record the claim-bonus control as a detected candidate only',
  );
  assert.ok(!callLog.some((entry) => entry.startsWith('click:') || entry.startsWith('fill:')), 'expected no active interaction to ever be logged');

  // --- 11. The post-run reviewer receives only saved evidence and produces every review-input
  // JSON section, including the template files this run was configured with.
  //
  // review-input.json is read here as crawlSite itself wrote it at end-of-run (from its own
  // in-memory, already-alias-merged `decisions`, 7 canonical accepted targets — see acceptance
  // criteria 2/3 above). runPostRunReview()/assemblePostRunReviewEvidence() is exercised
  // separately below purely for its own gate/handoff contract (never for the merged-count
  // assertions): it re-derives its own review-input.json from the raw, pre-merge
  // url-clean-decisions.jsonl log (one row per discovered alias, not per canonical route), which
  // is a distinct, already-existing FIX-05 behavior this ticket does not touch. ---
  const reviewInput = JSON.parse(fs.readFileSync(path.join(runDir, 'review-input.json'), 'utf-8')) as ReviewInputDocument;
  assert.equal(reviewInput.templateFiles.length, 2, 'expected the two real templates, with dropdowns.json excluded');
  assert.ok(reviewInput.templateFiles.every((templatePath) => !templatePath.endsWith('dropdowns.json')));
  assert.equal(reviewInput.acceptedTargets.length, 7);
  assert.equal(reviewInput.visitedPages.length, 7);
  assert.equal(reviewInput.urlCounts.visited, 7);
  assert.equal(reviewInput.urlCounts.failed, 0);
  assert.ok(reviewInput.rejectedByRule.some((row) => row.ruleId === 'URLR_DROP_INDIVIDUAL_GAME_EVENT'));
  assert.ok(reviewInput.tbdByRule.some((row) => row.ruleId === 'URLR_TBD_API'));
  assert.ok(reviewInput.tbdByRule.some((row) => row.ruleId === 'URLR_TBD_ASSET'));
  assert.ok(reviewInput.sourceFamilyCoverage.length > 0);
  assert.ok(fs.existsSync(reviewInput.fullUrlInventoryPath), 'expected the full unbounded url-inventory.json evidence file to exist');
  const urlInventory = JSON.parse(fs.readFileSync(reviewInput.fullUrlInventoryPath, 'utf-8')) as UrlInventoryDocument;
  assert.equal(urlInventory.accepted.length, 7);

  // The reviewer gate itself: reads only saved deterministic evidence (never browses), refuses
  // non-terminal runs, cross-validates every snapshot traces to a real visited record with HTML
  // on disk, and hands off to the discovery-reviewer subagent — never a raw model/API call.
  const { bundle, handoff } = await runPostRunReview(runDir);
  assert.equal(bundle.manifest.status, 'complete');
  assert.equal(bundle.runContext?.templateDir, templateDir);
  assert.equal(handoff.reviewInputPath, path.join(runDir, 'review-input.json'));
  assert.equal(handoff.templateDir, templateDir);
  assert.equal(handoff.agentName, 'discovery-reviewer');
  assert.equal(handoff.discoveryReviewOutputPath, path.join(runDir, 'discovery-review.json'));

  // --- 12. Structural guarantee that no legacy scorer/relevance-gate/visit-plan/field-collector/
  // normaliser/gap-probe/browser-capable-LLM-agent module is invoked: this file imports nothing
  // outside crawler.ts, post-run-review.ts and types.ts (snapshot-engine's own deterministic
  // public surface), and the accepted-target/rejected/tbd counts above only ever moved through
  // decideUrl()'s URL Rules — no scoring/priority/confidence field appears anywhere above. ---
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.counts.accepted, 7);
  assert.equal(manifest.counts.visited, 7);
  assert.equal(manifest.counts.failed, 0);
});

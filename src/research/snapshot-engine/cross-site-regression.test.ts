import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import { decideUrl } from './url-rules.ts';
import { executeBoundedRevealCandidates } from './bounded-reveal.ts';
import { assertPassiveOnlyInteractionRecords } from './interaction-contract.ts';
import type { BrowserContext, Page } from 'playwright';
import type {
  InteractionCandidateRecord,
  InteractiveElementTrace,
  NetworkEvidenceRecord,
  ReviewInputDocument,
  UrlInventoryDocument,
  VisitedPageRecord,
} from './types.ts';

// FIX-10: cross-site regression matrix (this ticket's own local id "FIX-07" per the coverage-fix
// tickets doc). Purpose: prove FIX-01..FIX-06 behavior is generic browser/route semantics, not
// encoded from a single real run. Everything in this file is synthetic — no real casino hostname,
// selector, endpoint path, or literal promotion/payment/game value is copied from any real run.
// Two independent, differently-shaped synthetic "site" fixture families are exercised end to end
// through the exact same production code path (crawlSite / decideUrl / bounded-reveal adapters /
// interaction-contract gate):
//
//   - "Site Alpha" (generic-alpha.test) — styled after the WestAce-class failure patterns
//     documented by FIX-01..FIX-06 (category-vs-individual-route confusion, locale aliasing,
//     soft-404 redirect, promotion/payment facts only reachable via XHR/JSON, image-only visible
//     labels) but rebuilt with entirely made-up wording/paths/selectors.
//   - "Site Beta" (generic-beta.test) — styled after the existing SpinBoss-class regression
//     fixture (regression-spinboss.test.ts) reused here for its applicable shapes (unclassified
//     same-origin routes, explicit TBD API route) plus its own distinct wording/paths.
//
// Cases 6-9 (bounded_reveal adapters) are exercised directly against bounded-reveal.ts (the same
// module regression-spinboss.test.ts/bounded-reveal.test.ts use) because crawlSite's crawl loop
// currently always runs in passive_only mode (see crawler.ts's RUN_INTERACTION_MODE) — there is
// no separate "bounded_reveal site" entry point to route through; the adapters themselves are
// exercised against two differently-worded/selectored fixtures instead, proving the same generic
// adapter code (not a per-site special case) drives both.

interface FakeFrame {
  url(): string;
  name(): string;
  parentFrame(): undefined;
  evaluate: (fn: (...args: unknown[]) => unknown, arg?: unknown) => Promise<unknown>;
}

function emptyPassiveResult(listLabels: string[] = []) {
  return {
    interactive: listLabels.map((label, index) => ({
      frameUrl: '',
      domPath: `[data-list-item="${index}"]`,
      tag: 'li',
      role: 'listitem',
      name: label,
      visible: true,
      disabled: false,
      contentEditable: false,
      cursorPointer: false,
      eventAttributeHints: [],
      detectorHints: ['list_item_label'],
    })),
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

function makeOutputDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `snapshot-engine-${prefix}-`));
}

// ---------------------------------------------------------------------------------------------
// Site Alpha — synthetic, WestAce-failure-shaped but entirely made-up terms/paths.
//   - category route (/games/slots) vs individual route (/game/lucky-sevens)  [case 1]
//   - locale alias (/en/loyalty) vs locale-free canonical (/loyalty)       [case 2]
//   - a document that resolves HTTP 200 but whose final path is /support/404         [case 3]
//   - a promotions page whose full list is only present in a JSON/XHR response       [case 4]
//   - a rewards page with visible list-item labels captured passively                [case 5]
// ---------------------------------------------------------------------------------------------

const ALPHA_ENTRY_URL = 'https://alpha-casino.test/en/';
const ALPHA_TABLE_GAMES_URL = 'https://alpha-casino.test/games/slots';
const ALPHA_LOYALTY_URL = 'https://alpha-casino.test/loyalty';
const ALPHA_LOYALTY_LOCALE_URL = 'https://alpha-casino.test/en/loyalty';
const ALPHA_BROKEN_LINK_URL = 'https://alpha-casino.test/en/rules';
const ALPHA_BROKEN_FINAL_URL = 'https://alpha-casino.test/support/404';
const ALPHA_PROMOTIONS_URL = 'https://alpha-casino.test/en/promotions';
const ALPHA_PROMOTIONS_API_URL = 'https://alpha-casino.test/data/promo-feed.json';
const ALPHA_REWARDS_URL = 'https://alpha-casino.test/en/rewards';

function makeAlphaEnvironment(callLog: string[]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = ALPHA_ENTRY_URL;
  let navigationCount = 0;

  const mainFrame: FakeFrame = {
    url: () => currentUrl,
    name: () => '',
    parentFrame: () => undefined,
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('candidateSet')) {
        if (currentUrl === ALPHA_REWARDS_URL) {
          return emptyPassiveResult(['Tier Bronze — 100 points', 'Tier Silver — 500 points', 'Tier Gold — 1500 points']);
        }
        return emptyPassiveResult();
      }
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      if (src.includes('getBoundingClientRect')) return false;
      if (src.includes('document.readyState')) return 'complete';
      if (navigationCount === 0) {
        return [
          { value: '/games/slots', attribute: 'href' },
          { value: '/game/lucky-sevens', attribute: 'href' },
          { value: '/loyalty', attribute: 'href' },
          { value: '/en/loyalty', attribute: 'href' },
          { value: '/en/rules', attribute: 'href' },
          { value: '/en/promotions', attribute: 'href' },
          { value: '/en/rewards', attribute: 'href' },
        ];
      }
      return [];
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
      // Case 3: an otherwise-accepted document route resolves HTTP 200 but the browser lands on a
      // soft-404 final path (simulating a stale/removed real target behind an accepted route).
      currentUrl = url === ALPHA_BROKEN_LINK_URL ? ALPHA_BROKEN_FINAL_URL : url;
      if (url === ALPHA_PROMOTIONS_URL) {
        // Case 4: promotion facts only reachable via JSON/XHR, never navigated to as a document.
        listeners.get('response')?.({
          url: () => ALPHA_PROMOTIONS_API_URL,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          body: () =>
            Promise.resolve(
              Buffer.from(
                JSON.stringify({ promotions: [{ title: 'Alpha Welcome Package' }, { title: 'Alpha Midweek Reload' }] }),
                'utf8',
              ),
            ),
          request: () => ({ resourceType: () => 'xhr', method: () => 'GET' }),
          frame: () => ({ url: () => ALPHA_PROMOTIONS_URL }),
        });
      }
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    title: async () => (currentUrl === ALPHA_BROKEN_FINAL_URL ? 'Page not found' : 'Title'),
    content: async () => {
      if (currentUrl === ALPHA_BROKEN_FINAL_URL) {
        return '<html><body><h1>404</h1><p>The page you requested could not be found.</p></body></html>';
      }
      if (currentUrl === ALPHA_PROMOTIONS_URL) {
        return '<html><body><h1>Promotions</h1><p>Alpha Welcome Package</p></body></html>';
      }
      if (currentUrl === ALPHA_REWARDS_URL) {
        return '<html><body><ul><li>Tier Bronze — 100 points</li><li>Tier Silver — 500 points</li><li>Tier Gold — 1500 points</li></ul></body></html>';
      }
      return `<html><body>${currentUrl}</body></html>`;
    },
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    evaluate: mainFrame.evaluate,
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

  return { page: page as unknown as Page, context: context as unknown as BrowserContext };
}

test('cross-site regression [Site Alpha]: category vs individual route, locale alias, soft-404, JSON-only facts, passive list labels', async () => {
  const callLog: string[] = [];
  const { page, context } = makeAlphaEnvironment(callLog);
  const outputDir = makeOutputDir('cross-site-alpha');

  const manifest = await crawlSite({
    context,
    page,
    entryUrl: ALPHA_ENTRY_URL,
    casinoName: 'Alpha Example Casino',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1_000,
    debugArtifacts: true,
  });

  const runDir = path.join(outputDir, manifest.runFolderName);
  const debugDir = path.join(runDir, 'debug');
  const urlInventory = JSON.parse(fs.readFileSync(path.join(runDir, 'url-inventory.json'), 'utf-8')) as UrlInventoryDocument;
  const rejectedAndTbd = [...urlInventory.rejected, ...urlInventory.tbd];
  const pageVisits = fs
    .readFileSync(path.join(runDir, 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as VisitedPageRecord[];

  // --- Case 1: category route accepted, individual route rejected. ---
  const tableGamesDecision = urlInventory.accepted.find((row) => row.rawUrl === '/games/slots');
  assert.equal(tableGamesDecision?.ruleId, 'URLR_KEEP_CASINO_CATEGORY');
  const luckySevensDecision = rejectedAndTbd.find((row) => row.rawUrl === '/game/lucky-sevens');
  assert.equal(luckySevensDecision?.decision, 'rejected');
  assert.equal(luckySevensDecision?.ruleId, 'URLR_DROP_INDIVIDUAL_GAME_EVENT');
  assert.ok(!callLog.some((entry) => entry.includes('/game/lucky-sevens')));

  // --- Case 2: locale-bearing alias and locale-free canonical merge into one visit. ---
  const loyaltyVisit = pageVisits.find((row) => row.canonicalUrl === 'https://alpha-casino.test/loyalty');
  assert.ok(loyaltyVisit, 'expected exactly one canonical loyalty visit');
  assert.ok(
    loyaltyVisit!.aliasUrls?.includes(ALPHA_LOYALTY_LOCALE_URL) || loyaltyVisit!.requestedUrl === ALPHA_LOYALTY_LOCALE_URL,
    'expected the locale alias to be merged rather than producing a second visit',
  );
  assert.equal(pageVisits.filter((row) => row.canonicalUrl === 'https://alpha-casino.test/loyalty').length, 1);

  // --- Case 3: HTTP-200 page whose final path is a terminal error route is classified an error
  // page, not a false-positive successful visit of ordinary research content. ---
  const brokenVisit = pageVisits.find((row) => row.requestedUrl === ALPHA_BROKEN_LINK_URL);
  assert.ok(brokenVisit, 'expected a terminal visit record for the soft-404 link');
  assert.equal(brokenVisit!.errorPageClassification, 'error_page');
  assert.ok(brokenVisit!.errorPageSignals?.some((s) => s.includes('final_url_matches_error_route')));

  // --- Case 4: promotion facts reachable only via JSON/XHR are captured as network evidence and
  // exposed to the reviewer, while the API URL itself never becomes an accepted document. ---
  const networkRecords = fs
    .readFileSync(path.join(runDir, 'network-evidence.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as NetworkEvidenceRecord[];
  const promoRecord = networkRecords.find((row) => row.requestUrl === ALPHA_PROMOTIONS_API_URL);
  assert.equal(promoRecord?.outcome, 'captured');
  const promoBody = JSON.parse(fs.readFileSync(promoRecord!.bodyPath!, 'utf-8'));
  assert.deepEqual(
    promoBody.promotions.map((row: { title: string }) => row.title),
    ['Alpha Welcome Package', 'Alpha Midweek Reload'],
  );
  assert.ok(!urlInventory.accepted.some((row) => row.rawUrl === ALPHA_PROMOTIONS_API_URL || row.resolvedUrl === ALPHA_PROMOTIONS_API_URL));
  const reviewInput = JSON.parse(fs.readFileSync(path.join(debugDir, 'review-input.json'), 'utf-8')) as ReviewInputDocument;
  assert.ok(reviewInput.networkEvidenceIndexPath && fs.existsSync(reviewInput.networkEvidenceIndexPath));

  // --- Case 5: visible list-item labels are captured passively, without any click. ---
  const pageBehavior = fs
    .readFileSync(path.join(debugDir, 'page-behavior.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{ requestedUrl: string; interactiveElements: Array<{ name?: string }> }>;
  const rewardsBehavior = pageBehavior.find((row) => row.requestedUrl === ALPHA_REWARDS_URL);
  assert.ok(rewardsBehavior);
  assert.ok(rewardsBehavior!.interactiveElements.some((el) => el.name === 'Tier Gold — 1500 points'));
  assert.ok(!callLog.some((entry) => entry.startsWith('click:')));

  // --- Case 10: passive mode records contain no executed-action outcomes anywhere in this run. ---
  const interactionsPath = path.join(runDir, 'interactions.jsonl');
  const interactionRecords = fs.existsSync(interactionsPath)
    ? fs
        .readFileSync(interactionsPath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InteractionCandidateRecord)
    : [];
  assert.doesNotThrow(() => assertPassiveOnlyInteractionRecords('passive_only', interactionRecords));

  assert.equal(manifest.status, 'complete');
});

// ---------------------------------------------------------------------------------------------
// Site Beta — synthetic, SpinBoss-regression-shaped (reused/extended from
// regression-spinboss.test.ts's applicable shapes: same-origin unclassified routes, an explicit
// TBD API route, locale-prefixed accepted routes) plus its own distinct wording, a second
// category-vs-individual pairing, and a second locale-alias pairing — different casino, different
// route names, different labels, same generic production code path.
// ---------------------------------------------------------------------------------------------

const BETA_ENTRY_URL = 'https://beta-wagers.test/no/';
const BETA_SLOTS_CATEGORY_URL = 'https://beta-wagers.test/no/games/slots';
const BETA_INDIVIDUAL_GAME_URL = 'https://beta-wagers.test/no/game/frost-fortune';
const BETA_BONUS_URL = 'https://beta-wagers.test/no/bonuses';
const BETA_BONUS_LOCALE_FREE_URL = 'https://beta-wagers.test/bonuses';
const BETA_UNMATCHED_URL = 'https://beta-wagers.test/no/whatever-page';
const BETA_API_URL = 'https://beta-wagers.test/no/api/wallet';

function makeBetaEnvironment(callLog: string[]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = BETA_ENTRY_URL;
  let navigationCount = 0;

  const mainFrame: FakeFrame = {
    url: () => currentUrl,
    name: () => '',
    parentFrame: () => undefined,
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('candidateSet')) return emptyPassiveResult();
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      if (src.includes('getBoundingClientRect')) return false;
      if (src.includes('document.readyState')) return 'complete';
      if (navigationCount === 0) {
        return [
          { value: '/no/games/slots', attribute: 'href' },
          { value: '/no/game/frost-fortune', attribute: 'href' },
          { value: '/no/bonuses', attribute: 'href' },
          { value: '/bonuses', attribute: 'href' },
          { value: '/no/whatever-page', attribute: 'href' },
          { value: '/no/api/wallet', attribute: 'href' },
        ];
      }
      return [];
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
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    title: async () => 'Title',
    content: async () => `<html><body>${currentUrl}</body></html>`,
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    evaluate: mainFrame.evaluate,
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

  return { page: page as unknown as Page, context: context as unknown as BrowserContext };
}

test('cross-site regression [Site Beta]: SpinBoss-shaped fixture — category vs individual, locale alias, unmatched route, explicit TBD API', async () => {
  const callLog: string[] = [];
  const { page, context } = makeBetaEnvironment(callLog);
  const outputDir = makeOutputDir('cross-site-beta');

  const manifest = await crawlSite({
    context,
    page,
    entryUrl: BETA_ENTRY_URL,
    casinoName: 'Beta Example Wagers',
    outputDir,
    settleMs: 0,
    navigationTimeoutMs: 1_000,
    debugArtifacts: true,
  });

  const runDir = path.join(outputDir, manifest.runFolderName);
  const urlInventory = JSON.parse(fs.readFileSync(path.join(runDir, 'url-inventory.json'), 'utf-8')) as UrlInventoryDocument;
  const rejectedAndTbd = [...urlInventory.rejected, ...urlInventory.tbd];
  const pageVisits = fs
    .readFileSync(path.join(runDir, 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as VisitedPageRecord[];

  // --- Case 1 (second site): category vs individual route, same generic ruleId. ---
  const categoryDecision = urlInventory.accepted.find((row) => row.rawUrl === '/no/games/slots');
  assert.equal(categoryDecision?.ruleId, 'URLR_KEEP_CASINO_CATEGORY');
  const individualDecision = rejectedAndTbd.find((row) => row.rawUrl === '/no/game/frost-fortune');
  assert.equal(individualDecision?.ruleId, 'URLR_DROP_INDIVIDUAL_GAME_EVENT');
  assert.ok(!callLog.some((entry) => entry.includes('/game/frost-fortune')));

  // --- Case 2 (second site): locale-prefixed and locale-free bonus aliases merge to one visit. ---
  const bonusVisit = pageVisits.find((row) => row.canonicalUrl === 'https://beta-wagers.test/bonuses');
  assert.ok(bonusVisit);
  assert.equal(pageVisits.filter((row) => row.canonicalUrl === 'https://beta-wagers.test/bonuses').length, 1);
  assert.ok(
    bonusVisit!.aliasUrls?.includes(BETA_BONUS_LOCALE_FREE_URL) || bonusVisit!.requestedUrl === BETA_BONUS_URL,
  );

  // --- Reused SpinBoss-class shapes: an ordinary unmatched same-origin route stays rejected, and
  // an API route stays explicit TBD, never accepted/visited. ---
  const unmatchedDecision = rejectedAndTbd.find((row) => row.rawUrl === '/no/whatever-page');
  assert.equal(unmatchedDecision?.decision, 'rejected');
  assert.equal(unmatchedDecision?.ruleId, 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN');
  const apiDecision = rejectedAndTbd.find((row) => row.rawUrl === '/no/api/wallet');
  assert.equal(apiDecision?.decision, 'tbd');
  assert.equal(apiDecision?.ruleId, 'URLR_TBD_API');
  assert.ok(!urlInventory.accepted.some((row) => row.rawUrl === BETA_API_URL));

  assert.equal(manifest.status, 'complete');
});

// ---------------------------------------------------------------------------------------------
// Cases 6-9: bounded_reveal adapters exercised against two independently-worded/selectored
// fixtures (Alpha-styled and Beta-styled) proving the same generic adapter code in bounded-reveal
// ts handles both, without any per-site special casing.
// ---------------------------------------------------------------------------------------------

function el(overrides: Partial<InteractiveElementTrace>): InteractiveElementTrace {
  return {
    frameUrl: 'https://example.test/page',
    domPath: '#target',
    tag: 'button',
    visible: true,
    disabled: false,
    contentEditable: false,
    cursorPointer: false,
    eventAttributeHints: [],
    detectorHints: [],
    ...overrides,
  };
}

interface BoundedRevealFixtureConfig {
  mainUrl: string;
  contentBefore: string;
  contentAfter: string;
  ariaExpandedBefore?: string | null;
  ariaExpandedAfter?: string | null;
  throwOnTrial?: Error;
}

function makeBoundedRevealFixture(config: BoundedRevealFixtureConfig) {
  let clicked = false;
  let clickCount = 0;

  const locator = {
    getAttribute: async (name: string) => {
      if (name === 'aria-expanded') return clicked ? config.ariaExpandedAfter ?? null : config.ariaExpandedBefore ?? null;
      return null;
    },
    click: async (opts?: { trial?: boolean; timeout?: number }) => {
      if (opts?.trial) {
        if (config.throwOnTrial) throw config.throwOnTrial;
        return;
      }
      clicked = !clicked;
      clickCount += 1;
    },
    evaluate: async () => ({ selectedIndex: 0, optionCount: 3 }),
    first: function () {
      return this;
    },
  };

  const frame = { url: () => config.mainUrl, locator: () => locator };
  const page = {
    url: () => config.mainUrl,
    content: async () => (clicked ? config.contentAfter : config.contentBefore),
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('scrollTo')) return undefined;
      if (src.includes('dialog')) return 0;
      return false;
    },
    waitForTimeout: async () => {},
    mainFrame: () => frame,
    frames: () => [frame],
    goto: async () => {},
  };

  return { page: page as unknown as Page, getClickCount: () => clickCount };
}

const boundedRevealSites = [
  {
    name: 'Alpha',
    mainUrl: 'https://alpha-casino.test/en/faq',
    tabName: 'Table rules overview',
    accordionQuestion: 'How long does approval take?',
    unsafeButtonName: 'Take a virtual tour',
    blockedTabName: 'Account verification status',
    withdrawPanelName: 'Withdraw funds',
    loadMoreName: 'Show more table games',
    loadMoreStates: ['<html>12 tables</html>', '<html>24 tables</html>', '<html>24 tables</html>'],
  },
  {
    name: 'Beta',
    mainUrl: 'https://beta-wagers.test/no/help',
    tabName: 'Bonus terms',
    accordionQuestion: 'How long does verification take?',
    unsafeButtonName: 'Open live chat widget',
    blockedTabName: 'Payment history',
    withdrawPanelName: 'Request payout',
    loadMoreName: 'Vis flere spilleautomater',
    loadMoreStates: ['<html>8 games</html>', '<html>16 games</html>', '<html>16 games</html>'],
  },
];

for (const site of boundedRevealSites) {
  test(`cross-site regression [${site.name}] bounded_reveal: tab/disclosure reveals new evidence`, async () => {
    const fixture = makeBoundedRevealFixture({
      mainUrl: site.mainUrl,
      contentBefore: '<html><body>collapsed</body></html>',
      contentAfter: `<html><body>${site.accordionQuestion} — answer text revealed</body></html>`,
      ariaExpandedBefore: 'false',
      ariaExpandedAfter: 'true',
    });
    const candidate = el({ frameUrl: site.mainUrl, name: site.tabName, role: 'tab', detectorHints: ['tab'] });
    const [record] = await executeBoundedRevealCandidates(fixture.page, [candidate], site.mainUrl, { deltaSettleMs: 0 });
    assert.equal(record.actionClass, 'tab');
    assert.equal(record.outcome, 'revealed_evidence');
    assert.ok(record.delta);
  });

  test(`cross-site regression [${site.name}] bounded_reveal: load-more grows a repeated list and terminates on no growth`, async () => {
    let round = 0;
    const locator = {
      getAttribute: async () => null,
      click: async (opts?: { trial?: boolean }) => {
        if (opts?.trial) return;
        round += 1;
      },
      evaluate: async () => ({ selectedIndex: 0, optionCount: 1 }),
      first: function () {
        return this;
      },
    };
    const frame = { url: () => site.mainUrl, locator: () => locator };
    const page = {
      url: () => site.mainUrl,
      content: async () => site.loadMoreStates[Math.min(round, site.loadMoreStates.length - 1)],
      evaluate: async () => false,
      waitForTimeout: async () => {},
      mainFrame: () => frame,
      frames: () => [frame],
      goto: async () => {},
    } as unknown as Page;

    const candidate = el({ frameUrl: site.mainUrl, name: site.loadMoreName, detectorHints: ['load_more_candidate'] });
    const records = await executeBoundedRevealCandidates(page, [candidate], site.mainUrl, {
      deltaSettleMs: 0,
      maxActionsPerAdapter: 5,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].actionClass, 'load_more');
    assert.equal(records[0].outcome, 'revealed_evidence');
    assert.ok(round <= 5 && round >= 2, `expected load-more to stop once growth plateaus, ran ${round} rounds`);
  });

  test(`cross-site regression [${site.name}] bounded_reveal: arbitrary unsafe/unapproved button remains untouched`, async () => {
    const fixture = makeBoundedRevealFixture({
      mainUrl: site.mainUrl,
      contentBefore: '<html></html>',
      contentAfter: '<html>changed</html>',
    });
    const candidate = el({
      frameUrl: site.mainUrl,
      name: site.unsafeButtonName,
      tag: 'button',
      cursorPointer: true,
      detectorHints: ['custom_pointer_control'],
    });
    const records = await executeBoundedRevealCandidates(fixture.page, [candidate], site.mainUrl, { deltaSettleMs: 0 });
    assert.equal(records.length, 0);
    assert.equal(fixture.getClickCount(), 0);
  });

  test(`cross-site regression [${site.name}] bounded_reveal: prerequisite-blocked withdrawal/payment panel is recorded as blocked, never bypassed`, async () => {
    const fixture = makeBoundedRevealFixture({
      mainUrl: site.mainUrl,
      contentBefore: '<html></html>',
      contentAfter: '<html></html>',
      throwOnTrial: new Error('element is not visible (behind an account-gated overlay)'),
    });
    // Named after a withdrawal/payment concept but shaped (role=tab) as an approved adapter
    // class — the point of this case is a prerequisite-blocked *reveal* (e.g. a withdrawal-status
    // tab that requires a logged-in/verified account state), not a transactional submit control
    // (which the safety gate rejects outright, exercised separately in bounded-reveal.test.ts).
    const candidate = el({ frameUrl: site.mainUrl, name: site.blockedTabName, role: 'tab', detectorHints: ['tab'] });
    const [record] = await executeBoundedRevealCandidates(fixture.page, [candidate], site.mainUrl, { deltaSettleMs: 0 });
    assert.equal(record.outcome, 'blocked');
    assert.equal(fixture.getClickCount(), 0);

    // The withdrawal-panel-named control itself, if transactional-shaped, is rejected by the
    // safety gate before any adapter runs at all (never even attempted, let alone blocked).
    const withdrawCandidate = el({ frameUrl: site.mainUrl, name: site.withdrawPanelName, role: 'tab', detectorHints: ['tab'] });
    const withdrawRecords = await executeBoundedRevealCandidates(fixture.page, [withdrawCandidate], site.mainUrl, { deltaSettleMs: 0 });
    assert.equal(withdrawRecords.length, 0);
  });
}

// --- Case 10, standalone: passive mode structurally cannot contain an action outcome, for
// arbitrary records claiming otherwise (the interaction-contract gate, independent of any single
// site fixture — same check crawler.ts itself calls). ---
test('cross-site regression: passive_only interaction-contract gate rejects any executed-action outcome, regardless of site', () => {
  for (const site of boundedRevealSites) {
    const contaminated: InteractionCandidateRecord[] = [
      {
        schemaVersion: '1.0',
        requestedUrl: site.mainUrl,
        capturedAt: new Date().toISOString(),
        interactionMode: 'passive_only',
        candidateCount: 1,
        candidates: [
          {
            frameUrl: site.mainUrl,
            domPath: '#whatever',
            tag: 'button',
            label: 'revealed_evidence',
          } as unknown as InteractionCandidateRecord['candidates'][number],
        ],
      },
    ];
    assert.throws(() => assertPassiveOnlyInteractionRecords('passive_only', contaminated));
  }
});

// --- Sanity: decideUrl itself (not just crawlSite's end-to-end wiring) produces the same ruleIds
// for both sites' category-vs-individual and locale-alias pairs — the deterministic proof that
// url-rules.ts is generic route classification, not a per-hostname table. ---
test('cross-site regression: decideUrl produces identical generic ruleIds across independent hostnames', () => {
  for (const [hostname, categoryPath, individualPath] of [
    ['alpha-casino.test', '/games/slots', '/game/lucky-sevens'],
    ['beta-wagers.test', '/no/games/slots', '/no/game/frost-fortune'],
  ] as const) {
    const categoryDecision = decideUrl(categoryPath, `https://${hostname}/`, hostname, []);
    assert.equal(categoryDecision.decision, 'accepted');
    assert.equal(categoryDecision.ruleId, 'URLR_KEEP_CASINO_CATEGORY');

    const individualDecision = decideUrl(individualPath, `https://${hostname}/`, hostname, []);
    assert.equal(individualDecision.decision, 'rejected');
    assert.equal(individualDecision.ruleId, 'URLR_DROP_INDIVIDUAL_GAME_EVENT');
  }
});

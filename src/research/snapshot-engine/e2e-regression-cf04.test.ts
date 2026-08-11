import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import type { BrowserContext, Page } from 'playwright';
import type { NetworkEvidenceRecord, ReviewInputDocument, UrlInventoryDocument, VisitedPageRecord } from './types.ts';

// CF-04: bounded, synthetic regression fixture derived from the observed Westace failure modes
// (not fetched from the live site). This is deliberately smaller/narrower than
// e2e-regression.test.ts's multi-shape fixture — it isolates exactly the coverage-loss classes
// CF-01/CF-02/CF-03/CF-04 were built to close:
//   - a promotions page whose rendered DOM is sparse while a same-origin promotion JSON response
//     (observed passively, never navigated to) carries additional promotion records;
//   - a payments page whose payment-method names exist only as image accessible labels;
//   - a same-origin withdrawal/payment JSON response observed on the same payments page;
//   - passive Deposit/Withdrawal controls that must remain visible as separate candidates;
//   - the API URLs behind both responses must stay classified TBD and must never become document
//     visits themselves.
//
// The passive trace returned by the faked frame.evaluate below is written in its already-
// canonicalized shape (actionable button/card as the candidate, decorative/image child folded in
// as the `name`) — this repo has no real-browser test harness anywhere (every snapshot-engine
// test fakes Page/Frame.evaluate by return-value, never by executing real DOM logic; see
// e2e-regression.test.ts / page-capture.test.ts), so passive-interactivity.ts's in-browser
// canonicalization algorithm itself cannot be executed under node:test. What this test proves
// instead is the property that actually matters for the Westace regression: once the trace is in
// its canonical shape, the rest of the pipeline (page-behavior.jsonl, interactions.jsonl, the
// reviewer handoff) carries that shape through unchanged, with no separate duplicate
// clickable-child-image candidate re-introduced anywhere downstream, and never executes a click.

interface FakeFrame {
  url(): string;
  name(): string;
  parentFrame(): undefined;
  evaluate: (fn: (...args: unknown[]) => unknown, arg?: unknown) => Promise<unknown>;
}

const ENTRY_URL = 'https://example.test/en/';
const PROMOTIONS_URL = 'https://example.test/en/promotions';
const PAYMENTS_URL = 'https://example.test/en/payments';
const PROMOTION_API_URL = 'https://example.test/api/v3/promotion/list?geo=NO';
const WITHDRAW_API_URL = 'https://example.test/api/cashbox/steps/withdraw';

// CF-04 Part A fixture: the canonicalized passive-interactivity shape for the payments page —
// the payment-card buttons carry the child image's accessible label as their own `name` (no
// separate `img "Visa"` candidate), and the Deposit/Withdrawal testid controls remain their own
// distinct candidates.
function paymentsPassiveResult() {
  return {
    interactive: [
      {
        frameUrl: PAYMENTS_URL,
        domPath: '[data-testid="visa-card"]',
        tag: 'button',
        role: undefined,
        name: 'Visa',
        visible: true,
        disabled: false,
        contentEditable: false,
        cursorPointer: true,
        eventAttributeHints: [],
        detectorHints: ['payment_method_card'],
      },
      {
        frameUrl: PAYMENTS_URL,
        domPath: '[data-testid="mastercard-card"]',
        tag: 'button',
        role: undefined,
        name: 'Mastercard',
        visible: true,
        disabled: false,
        contentEditable: false,
        cursorPointer: true,
        eventAttributeHints: [],
        detectorHints: ['payment_method_card'],
      },
      {
        frameUrl: PAYMENTS_URL,
        domPath: '[data-testid="depositList"]',
        tag: 'button',
        role: 'button',
        name: 'Deposit',
        visible: true,
        disabled: false,
        contentEditable: false,
        cursorPointer: true,
        eventAttributeHints: [],
        detectorHints: ['button'],
      },
      {
        frameUrl: PAYMENTS_URL,
        domPath: '[data-testid="withdrawList"]',
        tag: 'button',
        role: 'button',
        name: 'Withdrawal',
        visible: true,
        disabled: false,
        contentEditable: false,
        cursorPointer: true,
        eventAttributeHints: [],
        detectorHints: ['button'],
      },
    ],
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

function emptyPassiveResult() {
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

function makeFixtureEnvironment(callLog: string[]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = ENTRY_URL;
  let navigationCount = 0;

  const mainFrame: FakeFrame = {
    url: () => currentUrl,
    name: () => '',
    parentFrame: () => undefined,
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('candidateSet')) {
        return currentUrl === PAYMENTS_URL ? paymentsPassiveResult() : emptyPassiveResult();
      }
      if (src.includes('document.scripts')) return [];
      if (src.includes('performance.getEntriesByType')) return [];
      if (src.includes('getBoundingClientRect')) return false;
      if (src.includes('document.readyState')) return 'complete';
      if (navigationCount === 0) {
        return [
          { value: '/en/promotions', attribute: 'href' },
          { value: '/en/payments', attribute: 'href' },
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
      if (url === PROMOTIONS_URL) {
        // Same-origin promotion JSON response, observed passively while visiting the sparse
        // promotions document — never itself navigated to.
        listeners.get('response')?.({
          url: () => PROMOTION_API_URL,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          body: () =>
            Promise.resolve(
              Buffer.from(
                JSON.stringify({
                  promotions: [
                    { title: 'Daily Cashback 15%' },
                    { title: 'Weekend Reload 50%' },
                  ],
                }),
                'utf8',
              ),
            ),
          request: () => ({ resourceType: () => 'xhr', method: () => 'GET' }),
          frame: () => ({ url: () => PROMOTIONS_URL }),
        });
      }
      if (url === PAYMENTS_URL) {
        // Same-origin withdrawal/payment JSON response, observed passively while visiting the
        // payments document whose visible payment-method names are image-only.
        listeners.get('response')?.({
          url: () => WITHDRAW_API_URL,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          body: () =>
            Promise.resolve(
              Buffer.from(JSON.stringify({ methods: ['Skrill', 'Neteller', 'Bank Transfer'] }), 'utf8'),
            ),
          request: () => ({ resourceType: () => 'xhr', method: () => 'GET' }),
          frame: () => ({ url: () => PAYMENTS_URL }),
        });
      }
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    title: async () => 'Title',
    content: async () => {
      if (currentUrl === PROMOTIONS_URL) {
        // Sparse rendered DOM — only one promotion visible, deliberately incomplete relative to
        // the JSON response fired above.
        return '<html><body><h1>Promotions</h1><p>Daily Cashback 15%</p></body></html>';
      }
      if (currentUrl === PAYMENTS_URL) {
        // Payment-method names exist only as image accessible labels, plus the Deposit/Withdrawal
        // testid controls.
        return `<html><body>
          <div class="payment-list">
            <button data-testid="visa-card"><img alt="Visa"></button>
            <button data-testid="mastercard-card"><img aria-label="Mastercard"></button>
          </div>
          <button data-testid="depositList">Deposit</button>
          <button data-testid="withdrawList">Withdrawal</button>
        </body></html>`;
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

  return {
    page: page as unknown as Page,
    context: context as unknown as BrowserContext,
  };
}

function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-engine-cf04-'));
}

test('CF-04: promotion/payment network evidence and image-only payment labels survive, passive trace stays canonicalized, API URLs stay TBD', async () => {
  const callLog: string[] = [];
  const { page, context } = makeFixtureEnvironment(callLog);
  const outputDir = makeOutputDir();

  const manifest = await crawlSite({
    context,
    page,
    entryUrl: ENTRY_URL,
    casinoName: 'CF04 Example Casino',
    outputDir,
    settleMs: 500,
    navigationTimeoutMs: 1_000,
    debugArtifacts: true,
  });

  const runDir = path.join(outputDir, manifest.runFolderName);
  const debugDir = path.join(runDir, 'debug');

  const urlInventory = JSON.parse(
    fs.readFileSync(path.join(runDir, 'url-inventory.json'), 'utf-8'),
  ) as UrlInventoryDocument;
  const pageVisits = fs
    .readFileSync(path.join(runDir, 'pages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as VisitedPageRecord[];
  const pageBehavior = fs
    .readFileSync(path.join(debugDir, 'page-behavior.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{
    requestedUrl: string;
    interactiveElements: Array<{ domPath: string; tag: string; name?: string }>;
  }>;

  // --- 1. Both accepted document URLs (promotions, payments) are visited exactly once each. ---
  const requestedUrlCounts = new Map<string, number>();
  for (const row of pageVisits) requestedUrlCounts.set(row.requestedUrl, (requestedUrlCounts.get(row.requestedUrl) ?? 0) + 1);
  assert.deepEqual([...requestedUrlCounts.keys()].sort(), [PAYMENTS_URL, PROMOTIONS_URL].sort());
  for (const [url, count] of requestedUrlCounts) assert.equal(count, 1, `expected exactly one visit for ${url}`);
  assert.ok(pageVisits.every((row) => row.status === 'visited'));

  // --- 2. API URLs stay TBD and are never accepted / never navigated to as documents.
  // These URLs are observed only via PassiveNetworkObserver during a page visit (Phase 5), which
  // records them as post-visit observations only — by design (see crawler.ts's postVisitSink)
  // they can never mutate the frozen accepted inventory or trigger an extra navigation. ---
  const postVisitObservations = JSON.parse(
    fs.readFileSync(path.join(debugDir, 'post-visit-observations.json'), 'utf-8'),
  ) as Array<{ rawUrl: string; decision: string }>;
  const apiObservations = postVisitObservations.filter(
    (row) => row.rawUrl === PROMOTION_API_URL || row.rawUrl === WITHDRAW_API_URL,
  );
  assert.equal(apiObservations.length, 2, 'expected both observed API URLs to be recorded as post-visit observations');
  assert.ok(
    apiObservations.every((row) => row.decision === 'tbd'),
    'expected both observed API URLs to be classified TBD',
  );
  assert.ok(
    !urlInventory.accepted.some((row) => row.rawUrl === PROMOTION_API_URL || row.rawUrl === WITHDRAW_API_URL),
    'expected neither API URL to be an accepted document target',
  );
  assert.ok(
    !callLog.some((entry) => entry.includes('/api/')),
    'expected the browser to never navigate to an API URL',
  );

  // --- 3. Promotion and payment network bodies are retained and indexed. ---
  const networkEvidenceIndexPath = path.join(runDir, 'network-evidence.jsonl');
  assert.ok(fs.existsSync(networkEvidenceIndexPath), 'expected network-evidence.jsonl to exist');
  const networkRecords = fs
    .readFileSync(networkEvidenceIndexPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as NetworkEvidenceRecord[];
  const promotionRecord = networkRecords.find((row) => row.requestUrl === PROMOTION_API_URL);
  const withdrawRecord = networkRecords.find((row) => row.requestUrl === WITHDRAW_API_URL);
  assert.equal(promotionRecord?.outcome, 'captured', 'expected the promotion JSON body to be captured');
  assert.equal(withdrawRecord?.outcome, 'captured', 'expected the withdrawal JSON body to be captured');
  assert.ok(promotionRecord?.bodyPath && fs.existsSync(promotionRecord.bodyPath));
  assert.ok(withdrawRecord?.bodyPath && fs.existsSync(withdrawRecord.bodyPath));
  const promotionBody = JSON.parse(fs.readFileSync(promotionRecord!.bodyPath!, 'utf-8'));
  assert.deepEqual(
    promotionBody.promotions.map((row: { title: string }) => row.title),
    ['Daily Cashback 15%', 'Weekend Reload 50%'],
  );
  const withdrawBody = JSON.parse(fs.readFileSync(withdrawRecord!.bodyPath!, 'utf-8'));
  assert.deepEqual(withdrawBody.methods, ['Skrill', 'Neteller', 'Bank Transfer']);

  // --- 4. Visible image-only payment labels survive into corpus text. ---
  const paymentsVisit = pageVisits.find((row) => row.requestedUrl === PAYMENTS_URL);
  assert.ok(paymentsVisit, 'expected a visit record for the payments page');
  const corpusDir = path.join(runDir, 'corpus');
  const corpusFiles = fs.readdirSync(corpusDir);
  const paymentsCorpusFile = corpusFiles.find((name) => name.toLowerCase().includes('payment'));
  assert.ok(paymentsCorpusFile, `expected a payments corpus file among: ${corpusFiles.join(', ')}`);
  const paymentsCorpus = fs.readFileSync(path.join(corpusDir, paymentsCorpusFile!), 'utf-8');
  assert.match(paymentsCorpus, /Visa/);
  assert.match(paymentsCorpus, /Mastercard/);

  // --- 5. Passive trace uses the actionable parent — no separate clickable child-image
  // candidate ("img" tag) is present anywhere in the payments trace, and Deposit/Withdrawal
  // remain their own distinct candidates. ---
  const paymentsBehavior = pageBehavior.find((row) => row.requestedUrl === PAYMENTS_URL);
  assert.ok(paymentsBehavior, 'expected a passive-behavior trace row for the payments page');
  assert.ok(
    !paymentsBehavior!.interactiveElements.some((el) => el.tag === 'img'),
    'expected no standalone img candidate in the passive trace',
  );
  const visaCandidate = paymentsBehavior!.interactiveElements.find((el) => el.domPath === '[data-testid="visa-card"]');
  assert.equal(visaCandidate?.name, 'Visa', 'expected the canonical payment-card button to carry the child image label as its name');
  assert.ok(
    paymentsBehavior!.interactiveElements.some((el) => el.domPath === '[data-testid="depositList"]' && el.name === 'Deposit'),
    'expected Deposit to remain a separate passive candidate',
  );
  assert.ok(
    paymentsBehavior!.interactiveElements.some((el) => el.domPath === '[data-testid="withdrawList"]' && el.name === 'Withdrawal'),
    'expected Withdrawal to remain a separate passive candidate',
  );

  // --- 6. No interaction click was ever executed — the fake page exposes no click/fill method,
  // so any attempt would throw and fail this test; also assert the call log never logs one. ---
  assert.ok(!callLog.some((entry) => entry.startsWith('click:') || entry.startsWith('fill:')));

  // --- 7. Reviewer input references the network evidence index (on-disk reference, not inlined
  // bodies) and both accepted document pages were fed into the review handoff. ---
  const reviewInput = JSON.parse(fs.readFileSync(path.join(debugDir, 'review-input.json'), 'utf-8')) as ReviewInputDocument;
  assert.equal(reviewInput.networkEvidenceIndexPath, networkEvidenceIndexPath);
  assert.ok(fs.existsSync(reviewInput.networkEvidenceIndexPath!));
  assert.equal(reviewInput.visitedPages.length, 2);

  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.counts.visited, 2);
  assert.equal(manifest.counts.failed, 0);
});

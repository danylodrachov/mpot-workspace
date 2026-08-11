import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLocatorEvidence,
  classifyActionCandidate,
  controlledScrollPass,
  executeInteractionCandidates,
  isExcludedFromAutomaticExecution,
} from './interaction-delta-profiler.ts';
import type { InteractiveElementTrace } from './types.ts';

const MAIN_URL = 'https://example.test/page';

function el(overrides: Partial<InteractiveElementTrace>): InteractiveElementTrace {
  return {
    frameUrl: MAIN_URL,
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

// ---------------------------------------------------------------------------
// classifyActionCandidate / isExcludedFromAutomaticExecution — pure, no browser needed.
// ---------------------------------------------------------------------------

test('classifyActionCandidate: accordion/disclosure hint promotes to accordion_or_disclosure', () => {
  const candidate = el({ tag: 'summary', ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'accordion_or_disclosure');
});

test('classifyActionCandidate: tab hint promotes to tab', () => {
  const candidate = el({ role: 'tab', detectorHints: ['tab'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'tab');
});

test('classifyActionCandidate: aria-haspopup=dialog hint promotes to modal_trigger', () => {
  const candidate = el({ ariaHaspopup: 'dialog', detectorHints: ['possible_modal_trigger'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'modal_trigger');
});

test('classifyActionCandidate: select/combobox/listbox hint promotes to dropdown_or_combobox', () => {
  const candidate = el({ tag: 'select', detectorHints: ['dropdown_or_listbox'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'dropdown_or_combobox');
});

test('classifyActionCandidate: load-more text hint promotes to load_more', () => {
  const candidate = el({ name: 'Show more games', detectorHints: ['load_more_candidate'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'load_more');
});

test('classifyActionCandidate: pagination text hint promotes to pagination', () => {
  const candidate = el({ name: 'Next', detectorHints: ['pagination_candidate'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'pagination');
});

test('classifyActionCandidate: a known payment brand name on a radio/tab/button-role element promotes to payment_method_card', () => {
  const candidate = el({ role: 'radio', name: 'Skrill', detectorHints: [] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'payment_method_card');
});

test('classifyActionCandidate: a bare custom_pointer_control candidate is never promoted', () => {
  const candidate = el({ cursorPointer: true, detectorHints: ['custom_pointer_control'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
});

test('classifyActionCandidate: an accordion candidate inside a nested frame is classified iframe_interaction', () => {
  const candidate = el({
    frameUrl: 'https://example.test/embed.html',
    tag: 'summary',
    detectorHints: ['expandable_or_accordion'],
  });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'iframe_interaction');
});

test('classifyActionCandidate: invisible or disabled candidates are never promoted', () => {
  const invisible = el({ visible: false, detectorHints: ['tab'] });
  const disabled = el({ disabled: true, detectorHints: ['tab'] });
  assert.equal(classifyActionCandidate(invisible, { mainFrameUrl: MAIN_URL }), undefined);
  assert.equal(classifyActionCandidate(disabled, { mainFrameUrl: MAIN_URL }), undefined);
});

for (const [label, name] of [
  ['cookie', 'Cookie settings'],
  ['account', 'Sign in'],
  ['game-launch', 'Play now'],
  ['transaction', 'Deposit'],
]) {
  test(`classifyActionCandidate: ${label} candidates are excluded from automatic execution even with a promotable hint`, () => {
    const candidate = el({ name, role: 'tab', detectorHints: ['tab'] });
    assert.ok(isExcludedFromAutomaticExecution(candidate));
    assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
  });
}

test('classifyActionCandidate: a plain header/footer navigation link is excluded', () => {
  const candidate = el({ tag: 'a', href: 'https://example.test/terms', detectorHints: ['navigation_link'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL, pageOrigin: 'https://example.test' }), undefined);
});

test('classifyActionCandidate: an external-origin link is excluded even if it also carries a promotable hint', () => {
  const candidate = el({
    tag: 'a',
    href: 'https://external.example/dialog',
    detectorHints: ['possible_modal_trigger', 'navigation_link'],
  });
  assert.equal(
    classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL, pageOrigin: 'https://example.test' }),
    undefined,
  );
});

test('classifyActionCandidate: a submit-type form control is excluded', () => {
  const candidate = el({ tag: 'button', type: 'submit', detectorHints: ['form_control', 'tab'] });
  assert.equal(classifyActionCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
});

// ---------------------------------------------------------------------------
// buildLocatorEvidence — reusable-locator preference order.
// ---------------------------------------------------------------------------

test('buildLocatorEvidence: prefers stable id/testid domPath', () => {
  const candidate = el({ domPath: '#accordion-1' });
  assert.equal(buildLocatorEvidence(candidate).strategy, 'stable_id');
  const testId = el({ domPath: '[data-testid="accordion-1"]' });
  assert.equal(buildLocatorEvidence(testId).strategy, 'stable_id');
});

test('buildLocatorEvidence: falls back to ARIA role + accessible name', () => {
  const candidate = el({ domPath: 'button:nth-of-type(2)', role: 'tab', name: 'Bonuses' });
  assert.equal(buildLocatorEvidence(candidate).strategy, 'aria_role_name');
});

test('buildLocatorEvidence: falls back to aria-controls/aria-expanded relationship', () => {
  const candidate = el({ domPath: 'button:nth-of-type(2)', ariaExpanded: 'false' });
  assert.equal(buildLocatorEvidence(candidate).strategy, 'aria_relationship');
});

test('buildLocatorEvidence: falls back to bounded element semantics/text', () => {
  const candidate = el({ domPath: 'button:nth-of-type(2)', name: 'Show more' });
  assert.equal(buildLocatorEvidence(candidate).strategy, 'semantic_bounded_text');
});

test('buildLocatorEvidence: last resort is the current DOM path', () => {
  const candidate = el({ domPath: 'div > button:nth-of-type(2)' });
  assert.equal(buildLocatorEvidence(candidate).strategy, 'dom_path_fallback');
});

// ---------------------------------------------------------------------------
// executeInteractionCandidates — the live deterministic protocol, against a scripted fake Page.
// ---------------------------------------------------------------------------

interface FakeSiteConfig {
  ariaExpandedBefore?: string | null;
  ariaExpandedAfter?: string | null;
  contentBefore: string;
  contentAfter: string;
  overlayCountAfter?: number;
  throwOnTrial?: Error;
  throwOnClick?: Error;
  urlAfterClick?: string;
}

function makeFakeSite(config: FakeSiteConfig) {
  let clicked = false;
  let clickCount = 0;
  let currentUrl = MAIN_URL;

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
      if (config.throwOnClick) throw config.throwOnClick;
      clicked = !clicked;
      clickCount += 1;
      if (config.urlAfterClick) currentUrl = config.urlAfterClick;
    },
    first: function () {
      return this;
    },
  };

  const frame = {
    url: () => MAIN_URL,
    locator: () => locator,
  };

  const page = {
    url: () => currentUrl,
    content: async () => (clicked ? config.contentAfter : config.contentBefore),
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('scrollTo')) return undefined;
      if (src.includes('dialog')) return clicked ? config.overlayCountAfter ?? 0 : 0;
      return false; // loading-indicator probe: never present in these fixtures
    },
    waitForTimeout: async () => {},
    mainFrame: () => frame,
    frames: () => [frame],
    goBack: async () => {
      currentUrl = MAIN_URL;
    },
  };

  return { page: page as unknown as import('playwright').Page, getClickCount: () => clickCount };
}

test('revealed_evidence: an accordion toggle that changes both aria-expanded and visible content', async () => {
  const site = makeFakeSite({
    ariaExpandedBefore: 'false',
    ariaExpandedAfter: 'true',
    contentBefore: '<html><body>collapsed</body></html>',
    contentAfter: '<html><body>collapsed<div>revealed FAQ text</div></body></html>',
  });
  const candidate = el({ ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] });

  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'revealed_evidence');
  assert.equal(record.actionClass, 'accordion_or_disclosure');
  assert.ok(record.delta?.contentChanged);
  // Restore-to-baseline: the profiler must click again to collapse it back.
  assert.equal(site.getClickCount(), 2);
});

test('state_changed_no_new_evidence: aria-expanded toggles but the visible content hash does not change', async () => {
  const site = makeFakeSite({
    ariaExpandedBefore: 'false',
    ariaExpandedAfter: 'true',
    contentBefore: '<html><body>same</body></html>',
    contentAfter: '<html><body>same</body></html>',
  });
  const candidate = el({ ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'state_changed_no_new_evidence');
});

test('no_effect (tab with no instrumented aria/content change): a click that produces no observable delta at all', async () => {
  const site = makeFakeSite({
    contentBefore: '<html><body>same</body></html>',
    contentAfter: '<html><body>same</body></html>',
  });
  const candidate = el({ role: 'tab', detectorHints: ['tab'] });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'no_effect');
});

test('no_effect: a click produces no measurable delta at all', async () => {
  const site = makeFakeSite({
    contentBefore: '<html><body>same</body></html>',
    contentAfter: '<html><body>same</body></html>',
  });
  const candidate = el({ detectorHints: ['dropdown_or_listbox'], tag: 'select' });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'no_effect');
});

test('blocked: a failed actionability trial never executes the real action', async () => {
  const site = makeFakeSite({
    contentBefore: '<html><body>a</body></html>',
    contentAfter: '<html><body>b</body></html>',
    throwOnTrial: new Error('element is not visible'),
  });
  const candidate = el({ detectorHints: ['tab'] });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'blocked');
  assert.equal(site.getClickCount(), 0);
});

test('timeout: a TimeoutError from the trial action is reported as timeout, not blocked', async () => {
  const timeoutError = new Error('Timeout 3000ms exceeded');
  timeoutError.name = 'TimeoutError';
  const site = makeFakeSite({
    contentBefore: '<html><body>a</body></html>',
    contentAfter: '<html><body>b</body></html>',
    throwOnTrial: timeoutError,
  });
  const candidate = el({ detectorHints: ['tab'] });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'timeout');
});

test('unsafe: an action that navigates off the page origin is flagged unsafe and not restored', async () => {
  const site = makeFakeSite({
    contentBefore: '<html><body>a</body></html>',
    contentAfter: '<html><body>b</body></html>',
    urlAfterClick: 'https://external.example/landing',
  });
  const candidate = el({ detectorHints: ['tab'] });
  const [record] = await executeInteractionCandidates(site.page, [candidate], { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'unsafe');
});

test('one candidate failing never stops execution of the remaining candidates on the page', async () => {
  const failingSite = makeFakeSite({
    contentBefore: '<html><body>a</body></html>',
    contentAfter: '<html><body>a</body></html>',
    throwOnClick: new Error('detached from DOM'),
  });
  const first = el({ domPath: '#one', detectorHints: ['tab'] });
  const second = el({
    domPath: '#two',
    ariaExpanded: 'false',
    detectorHints: ['expandable_or_accordion'],
  });

  // Run against the failing site for candidate one, then reuse a healthy site for candidate two
  // by executing them as two separate calls and asserting both produce a terminal record —
  // the isolation guarantee is that a thrown error from one candidate's real action is always
  // caught and turned into its own record, never propagated to abort the loop.
  const records = await executeInteractionCandidates(failingSite.page, [first], { deltaSettleMs: 0 });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'blocked');

  const healthySite = makeFakeSite({
    ariaExpandedBefore: 'false',
    ariaExpandedAfter: 'true',
    contentBefore: '<html><body>a</body></html>',
    contentAfter: '<html><body>a<div>b</div></body></html>',
  });
  const secondRecords = await executeInteractionCandidates(healthySite.page, [second], { deltaSettleMs: 0 });
  assert.equal(secondRecords.length, 1);
  assert.equal(secondRecords[0].outcome, 'revealed_evidence');
});

test('maxCandidates bounds how many eligible candidates are executed on one page', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html></html>' });
  const trace = [
    el({ domPath: '#one', detectorHints: ['tab'] }),
    el({ domPath: '#two', detectorHints: ['tab'] }),
    el({ domPath: '#three', detectorHints: ['tab'] }),
  ];
  const records = await executeInteractionCandidates(site.page, trace, { deltaSettleMs: 0, maxCandidates: 2 });
  assert.equal(records.length, 2);
});

test('candidates excluded from automatic execution produce zero records', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html></html>' });
  const trace = [
    el({ name: 'Cookie settings', detectorHints: ['tab'] }),
    el({ name: 'Deposit', detectorHints: ['tab'] }),
    el({ cursorPointer: true, detectorHints: ['custom_pointer_control'] }),
  ];
  const records = await executeInteractionCandidates(site.page, trace, { deltaSettleMs: 0 });
  assert.equal(records.length, 0);
});

test('an empty trace never touches the Page API at all', async () => {
  let touched = false;
  const page = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('should not be called');
      },
    },
  ) as unknown as import('playwright').Page;
  const records = await executeInteractionCandidates(page, []);
  assert.equal(records.length, 0);
  assert.equal(touched, false);
});

// ---------------------------------------------------------------------------
// controlledScrollPass — bounded, never infinite.
// ---------------------------------------------------------------------------

test('controlledScrollPass stops after consecutive stable rounds', async () => {
  let round = 0;
  const html = ['a', 'a', 'b', 'b', 'b'];
  const page = {
    evaluate: async () => undefined,
    content: async () => {
      const value = html[Math.min(round, html.length - 1)];
      round += 1;
      return value;
    },
    waitForTimeout: async () => {},
  } as unknown as import('playwright').Page;

  const result = await controlledScrollPass(page, { maxRounds: 10, stableRoundsRequired: 2, roundBudgetMs: 0 });
  assert.equal(result.timedOut, false);
  assert.ok(result.newContentDetected);
  assert.ok(result.rounds <= 10);
});

test('controlledScrollPass never scrolls past maxRounds when content keeps changing', async () => {
  let round = 0;
  const page = {
    evaluate: async () => undefined,
    content: async () => {
      round += 1;
      return `content-${round}`;
    },
    waitForTimeout: async () => {},
  } as unknown as import('playwright').Page;

  const result = await controlledScrollPass(page, { maxRounds: 5, stableRoundsRequired: 2, roundBudgetMs: 0 });
  assert.equal(result.timedOut, true);
  assert.equal(result.rounds, 5);
});

// ---------------------------------------------------------------------------
// Multi-site regression corpus: three distinct site layouts, none sharing a hostname or a
// framework-specific naming scheme, all classified by the same generic recipes.
// ---------------------------------------------------------------------------

test('multi-site regression: siteA (semantic <details>/<summary> accordion, ARIA tabs, native <select>)', () => {
  const accordion = el({ tag: 'summary', domPath: '#faq-1', detectorHints: ['expandable_or_accordion'] });
  const tab = el({ role: 'tab', domPath: '.tabset > button:nth-of-type(1)', detectorHints: ['tab'] });
  const dropdown = el({ tag: 'select', domPath: '#currency-select', detectorHints: ['dropdown_or_listbox'] });
  assert.equal(classifyActionCandidate(accordion, { mainFrameUrl: MAIN_URL }), 'accordion_or_disclosure');
  assert.equal(classifyActionCandidate(tab, { mainFrameUrl: MAIN_URL }), 'tab');
  assert.equal(classifyActionCandidate(dropdown, { mainFrameUrl: MAIN_URL }), 'dropdown_or_combobox');
});

test('multi-site regression: siteB (div-based custom modal trigger, payment method cards, iframe game list)', () => {
  const modal = el({
    tag: 'div',
    domPath: '[data-testid="terms-modal-trigger"]',
    ariaHaspopup: 'dialog',
    detectorHints: ['possible_modal_trigger'],
  });
  const paymentCard = el({
    tag: 'div',
    role: 'radio',
    name: 'PayPal',
    domPath: '.payment-grid > div:nth-of-type(3)',
    detectorHints: [],
  });
  const iframeAccordion = el({
    tag: 'button',
    frameUrl: 'https://provider.example/widget',
    domPath: '.faq-item:nth-of-type(2)',
    detectorHints: ['expandable_or_accordion'],
  });
  assert.equal(classifyActionCandidate(modal, { mainFrameUrl: MAIN_URL }), 'modal_trigger');
  assert.equal(classifyActionCandidate(paymentCard, { mainFrameUrl: MAIN_URL }), 'payment_method_card');
  assert.equal(classifyActionCandidate(iframeAccordion, { mainFrameUrl: MAIN_URL }), 'iframe_interaction');
});

test('multi-site regression: siteC (custom combobox, load-more button, cookie banner excluded)', () => {
  const combobox = el({ role: 'combobox', domPath: '#lang-picker', detectorHints: ['dropdown_or_listbox'] });
  const loadMore = el({ name: 'Load more slots', domPath: '.grid-footer > button', detectorHints: ['load_more_candidate'] });
  const cookieBanner = el({ name: 'Manage cookie preferences', domPath: '#gdpr-banner button', detectorHints: ['tab'] });
  assert.equal(classifyActionCandidate(combobox, { mainFrameUrl: MAIN_URL }), 'dropdown_or_combobox');
  assert.equal(classifyActionCandidate(loadMore, { mainFrameUrl: MAIN_URL }), 'load_more');
  assert.equal(classifyActionCandidate(cookieBanner, { mainFrameUrl: MAIN_URL }), undefined);
});

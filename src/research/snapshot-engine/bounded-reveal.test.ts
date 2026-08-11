import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyBoundedRevealCandidate,
  executeBoundedRevealCandidates,
  isSafeToExecute,
} from './bounded-reveal.ts';
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
// isSafeToExecute — the hard safety gate. Pure, no browser needed.
// ---------------------------------------------------------------------------

test('isSafeToExecute: rejects a form element outright', () => {
  assert.equal(isSafeToExecute(el({ tag: 'form' })), false);
});

test('isSafeToExecute: rejects a submit-type control', () => {
  assert.equal(isSafeToExecute(el({ type: 'submit' })), false);
});

test('isSafeToExecute: rejects an onsubmit-bearing control', () => {
  assert.equal(isSafeToExecute(el({ eventAttributeHints: ['onsubmit'] })), false);
});

for (const name of ['Deposit now', 'Withdraw funds', 'Confirm payment', 'Place bet', 'Buy now', 'Proceed to checkout', 'Top up wallet']) {
  test(`isSafeToExecute: rejects a transactional/submit-shaped control named "${name}"`, () => {
    assert.equal(isSafeToExecute(el({ name, role: 'tab', detectorHints: ['tab'] })), false);
  });
}

for (const name of ['Password', 'Card number', 'CVV', 'IBAN', 'Bank account number', 'Upload passport', 'KYC verification']) {
  test(`isSafeToExecute: rejects a credential/KYC/payment-shaped control named "${name}"`, () => {
    assert.equal(isSafeToExecute(el({ name, role: 'tab', detectorHints: ['tab'] })), false);
  });
}

test('isSafeToExecute: rejects a password-type input regardless of name', () => {
  assert.equal(isSafeToExecute(el({ tag: 'input', type: 'password', name: 'field-1' })), false);
});

test('isSafeToExecute: rejects a cross-origin target', () => {
  assert.equal(
    isSafeToExecute(el({ tag: 'a', href: 'https://external.example/x' }), 'https://example.test'),
    false,
  );
});

test('isSafeToExecute: accepts an ordinary same-origin tab/accordion candidate', () => {
  assert.equal(isSafeToExecute(el({ name: 'Bonus terms', role: 'tab' }), 'https://example.test'), true);
});

// ---------------------------------------------------------------------------
// classifyBoundedRevealCandidate — strict adapter allowlist.
// ---------------------------------------------------------------------------

test('classifyBoundedRevealCandidate: semantic ARIA tab is classified tab', () => {
  const candidate = el({ role: 'tab', tag: 'button', detectorHints: ['tab'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'tab');
});

test('classifyBoundedRevealCandidate: aria-expanded disclosure is classified accordion_or_disclosure', () => {
  const candidate = el({ ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'accordion_or_disclosure');
});

test('classifyBoundedRevealCandidate: native <summary>/<details> is classified accordion_or_disclosure', () => {
  const candidate = el({ tag: 'summary' });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'accordion_or_disclosure');
});

test('classifyBoundedRevealCandidate: native <select> is always classified native_select_enumeration', () => {
  const candidate = el({ tag: 'select' });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'native_select_enumeration');
});

test('classifyBoundedRevealCandidate: combobox with strong ARIA relationship (aria-controls) is classified combobox_listbox_open', () => {
  const candidate = el({ role: 'combobox', ariaControls: 'lang-listbox', detectorHints: ['dropdown_or_listbox'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'combobox_listbox_open');
});

test('classifyBoundedRevealCandidate: combobox with aria-haspopup=listbox is classified combobox_listbox_open', () => {
  const candidate = el({ role: 'combobox', ariaHaspopup: 'listbox', detectorHints: ['dropdown_or_listbox'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'combobox_listbox_open');
});

test('classifyBoundedRevealCandidate: a custom "dropdown-looking" control with no strong ARIA relationship is unsupported, never clicked', () => {
  const candidate = el({ cursorPointer: true, detectorHints: ['dropdown_or_listbox'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'unsupported');
});

test('classifyBoundedRevealCandidate: load-more text hint is classified load_more', () => {
  const candidate = el({ name: 'Load more games', detectorHints: ['load_more_candidate'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), 'load_more');
});

test('classifyBoundedRevealCandidate: an arbitrary custom button with no approved-adapter hint is never classified (never clicked)', () => {
  const candidate = el({ name: 'Contact support', tag: 'button', cursorPointer: true, detectorHints: ['custom_pointer_control'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
});

test('classifyBoundedRevealCandidate: a transactional/submit-like control is rejected by the safety gate before any adapter runs', () => {
  const candidate = el({ name: 'Deposit', role: 'tab', detectorHints: ['tab'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
});

test('classifyBoundedRevealCandidate: candidates in a nested frame are out of scope (main-frame only)', () => {
  const candidate = el({ frameUrl: 'https://provider.example/widget', role: 'tab', detectorHints: ['tab'] });
  assert.equal(classifyBoundedRevealCandidate(candidate, { mainFrameUrl: MAIN_URL }), undefined);
});

test('classifyBoundedRevealCandidate: invisible or disabled candidates are never promoted', () => {
  assert.equal(classifyBoundedRevealCandidate(el({ visible: false, detectorHints: ['tab'] }), { mainFrameUrl: MAIN_URL }), undefined);
  assert.equal(classifyBoundedRevealCandidate(el({ disabled: true, detectorHints: ['tab'] }), { mainFrameUrl: MAIN_URL }), undefined);
});

// ---------------------------------------------------------------------------
// executeBoundedRevealCandidates — the live deterministic protocol against a scripted fake Page.
// ---------------------------------------------------------------------------

interface FakeSiteConfig {
  ariaExpandedBefore?: string | null;
  ariaExpandedAfter?: string | null;
  contentBefore: string;
  contentAfter: string;
  throwOnTrial?: Error;
  goto?: () => void;
}

function makeFakeSite(config: FakeSiteConfig) {
  let clicked = false;
  let clickCount = 0;
  let gotoCount = 0;

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

  const frame = {
    url: () => MAIN_URL,
    locator: () => locator,
  };

  const page = {
    url: () => MAIN_URL,
    content: async () => (clicked ? config.contentAfter : config.contentBefore),
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('scrollTo')) return undefined;
      if (src.includes('dialog')) return 0;
      return false; // loading-indicator probe: never present in these fixtures
    },
    waitForTimeout: async () => {},
    mainFrame: () => frame,
    frames: () => [frame],
    goto: async () => {
      gotoCount += 1;
      config.goto?.();
    },
  };

  return {
    page: page as unknown as import('playwright').Page,
    getClickCount: () => clickCount,
    getGotoCount: () => gotoCount,
  };
}

test('semantic tab fixture: reveals hidden content and produces a before/after evidence record', async () => {
  const site = makeFakeSite({
    contentBefore: '<html><body>tab1 content</body></html>',
    contentAfter: '<html><body>tab2 revealed content</body></html>',
    ariaExpandedBefore: 'false',
    ariaExpandedAfter: 'true',
  });
  const candidate = el({ role: 'tab', tag: 'button', detectorHints: ['tab'] });
  const [record] = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(record.actionClass, 'tab');
  assert.equal(record.outcome, 'revealed_evidence');
  assert.ok(record.delta);
  assert.ok(record.afterHtml);
});

test('accordion fixture: expanded once, revealed content captured', async () => {
  const site = makeFakeSite({
    ariaExpandedBefore: 'false',
    ariaExpandedAfter: 'true',
    contentBefore: '<html><body>collapsed</body></html>',
    contentAfter: '<html><body>collapsed<div>FAQ answer text</div></body></html>',
  });
  const candidate = el({ ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] });
  const [record] = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(record.actionClass, 'accordion_or_disclosure');
  assert.equal(record.outcome, 'revealed_evidence');
  // Restore-to-baseline: the adapter must click again to collapse it back.
  assert.equal(site.getClickCount(), 2);
});

test('native select is enumerated without changing the selected value', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html></html>' });
  const candidate = el({ tag: 'select' });
  const [record] = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(record.actionClass, 'native_select_enumeration');
  assert.equal(record.outcome, 'revealed_evidence');
  // The adapter never calls .click() on a <select> — it only reads .options.
  assert.equal(site.getClickCount(), 0);
});

test('an arbitrary button without an approved adapter is never clicked', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html>changed</html>' });
  const candidate = el({ name: 'Mystery action', tag: 'button', cursorPointer: true, detectorHints: ['custom_pointer_control'] });
  const records = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(records.length, 0);
  assert.equal(site.getClickCount(), 0);
});

test('a transactional/submit-like control is rejected by the safety gate and never clicked', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html>changed</html>' });
  const candidate = el({ name: 'Deposit now', role: 'tab', detectorHints: ['tab'] });
  const records = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(records.length, 0);
  assert.equal(site.getClickCount(), 0);
});

test('an unsupported custom control (dropdown-like, no strong ARIA relationship) stays a trace candidate only, never clicked', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html>changed</html>' });
  const candidate = el({ cursorPointer: true, detectorHints: ['dropdown_or_listbox'] });
  const [record] = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'unsupported');
  assert.equal(site.getClickCount(), 0);
});

test('a prerequisite-blocked panel produces blocked evidence and never attempts to bypass the prerequisite', async () => {
  const site = makeFakeSite({
    contentBefore: '<html></html>',
    contentAfter: '<html></html>',
    throwOnTrial: new Error('element is not visible (behind an account-gated overlay)'),
  });
  const candidate = el({ role: 'tab', detectorHints: ['tab'] });
  const [record] = await executeBoundedRevealCandidates(site.page, [candidate], MAIN_URL, { deltaSettleMs: 0 });
  assert.equal(record.outcome, 'blocked');
  assert.equal(site.getClickCount(), 0);
});

test('per-page action budget is enforced across candidates', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html></html>' });
  const trace = [
    el({ domPath: '#one', role: 'tab', detectorHints: ['tab'] }),
    el({ domPath: '#two', role: 'tab', detectorHints: ['tab'] }),
    el({ domPath: '#three', role: 'tab', detectorHints: ['tab'] }),
  ];
  const records = await executeBoundedRevealCandidates(site.page, trace, MAIN_URL, {
    deltaSettleMs: 0,
    maxActionsPerPage: 2,
  });
  assert.equal(records.length, 2);
});

test('per-adapter action budget is enforced independently of the per-page budget', async () => {
  const site = makeFakeSite({ contentBefore: '<html></html>', contentAfter: '<html></html>' });
  const trace = [
    el({ domPath: '#one', role: 'tab', detectorHints: ['tab'] }),
    el({ domPath: '#two', role: 'tab', detectorHints: ['tab'] }),
    el({ domPath: '#three', ariaExpanded: 'false', detectorHints: ['expandable_or_accordion'] }),
  ];
  const records = await executeBoundedRevealCandidates(site.page, trace, MAIN_URL, {
    deltaSettleMs: 0,
    maxActionsPerPage: 10,
    maxActionsPerAdapter: 1,
  });
  // Only the first tab candidate runs (adapter budget 1); the second tab candidate is skipped;
  // the accordion candidate (a different adapter) still gets its own budget of 1.
  assert.equal(records.filter((r) => r.actionClass === 'tab').length, 1);
  assert.equal(records.filter((r) => r.actionClass === 'accordion_or_disclosure').length, 1);
});

test('load-more fixture: runs until no growth, aggregating rounds into a terminal record', async () => {
  let round = 0;
  const listStates = ['<html>10 items</html>', '<html>20 items</html>', '<html>20 items</html>'];
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
  const frame = { url: () => MAIN_URL, locator: () => locator };
  const page = {
    url: () => MAIN_URL,
    content: async () => listStates[Math.min(round, listStates.length - 1)],
    evaluate: async () => false,
    waitForTimeout: async () => {},
    mainFrame: () => frame,
    frames: () => [frame],
    goto: async () => {},
  } as unknown as import('playwright').Page;

  const candidate = el({ name: 'Load more', detectorHints: ['load_more_candidate'] });
  const records = await executeBoundedRevealCandidates(page, [candidate], MAIN_URL, {
    deltaSettleMs: 0,
    maxActionsPerAdapter: 5,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].actionClass, 'load_more');
  assert.equal(records[0].outcome, 'revealed_evidence');
  assert.ok(round <= 5);
});

test('load-more fixture: budget exhausted while still growing is reported without exceeding the adapter budget', async () => {
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
  const frame = { url: () => MAIN_URL, locator: () => locator };
  const page = {
    url: () => MAIN_URL,
    content: async () => `<html>${round} items</html>`, // always grows
    evaluate: async () => false,
    waitForTimeout: async () => {},
    mainFrame: () => frame,
    frames: () => [frame],
    goto: async () => {},
  } as unknown as import('playwright').Page;

  const candidate = el({ name: 'Load more', detectorHints: ['load_more_candidate'] });
  const records = await executeBoundedRevealCandidates(page, [candidate], MAIN_URL, {
    deltaSettleMs: 0,
    maxActionsPerAdapter: 3,
  });
  assert.equal(records.length, 1);
  assert.equal(round, 3);
  assert.equal(records[0].outcome, 'revealed_evidence');
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
  const records = await executeBoundedRevealCandidates(page, [], MAIN_URL);
  assert.equal(records.length, 0);
  assert.equal(touched, false);
});

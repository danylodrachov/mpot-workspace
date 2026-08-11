import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageCorpus } from './page-content-pruner.ts';
import type { InteractionExecutionRecord } from './types.ts';

function baseInteraction(overrides: Partial<InteractionExecutionRecord>): InteractionExecutionRecord {
  return {
    frameUrl: 'https://example.test/payments',
    domPath: '#faq-toggle',
    tag: 'button',
    actionClass: 'accordion_or_disclosure',
    locatorEvidence: { strategy: 'stable_id', selector: '#faq-toggle' },
    outcome: 'no_effect',
    durationMs: 5,
    ...overrides,
  };
}

test('buildPageCorpus: strips scripts, styles, images, and tracking/cookie chrome from the baseline evidence', () => {
  const html = `<!doctype html><html><head><title>Payments</title>
    <script>window.dataLayer = [];</script>
    <style>.x { color: red }</style>
  </head><body>
    <div id="gtm-noscript" class="analytics-pixel">tracked</div>
    <div class="cookie-consent-banner">We use cookies. Accept?</div>
    <img src="/logo.png" alt="logo" />
    <svg><circle /></svg>
    <h1>Payment Methods</h1>
    <p>We support a range of deposit options.</p>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    title: 'Payments',
    html,
  });

  assert.ok(corpus.includes('# Payment Methods'));
  assert.ok(corpus.includes('We support a range of deposit options.'));
  assert.ok(!corpus.includes('dataLayer'));
  assert.ok(!corpus.includes('color: red'));
  assert.ok(!corpus.includes('tracked'));
  assert.ok(!corpus.includes('We use cookies'));
  assert.ok(!corpus.includes('logo.png'));
});

test('buildPageCorpus: strips duplicated global header/nav/footer chrome but keeps main content', () => {
  const html = `<html><body>
    <header><nav><a href="/">Home</a><a href="/promos">Promos</a></nav></header>
    <main><h1>Bonus Terms</h1><p>Wagering requirement is 35x.</p></main>
    <footer>Copyright 2026</footer>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/bonus',
    finalUrl: 'https://example.test/bonus',
    title: 'Bonus Terms',
    html,
  });

  assert.ok(corpus.includes('Wagering requirement is 35x.'));
  assert.ok(!corpus.includes('Copyright 2026'));
  assert.ok(!corpus.includes('Promos'));
});

test('buildPageCorpus: preserves table row/column relationships', () => {
  const html = `<html><body>
    <table>
      <tr><th>Method</th><th>Min Deposit</th></tr>
      <tr><td>Visa</td><td>$10</td></tr>
      <tr><td>Skrill</td><td>$20</td></tr>
    </table>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    html,
  });

  assert.ok(corpus.includes('| Method | Min Deposit |'));
  assert.ok(corpus.includes('| Visa | $10 |'));
  assert.ok(corpus.includes('| Skrill | $20 |'));
});

test('buildPageCorpus: hidden boilerplate that was never revealed by an interaction is dropped', () => {
  const html = `<html><body>
    <div hidden>never shown promo copy</div>
    <div style="display:none">also never shown</div>
    <p>Visible copy.</p>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/promo',
    finalUrl: 'https://example.test/promo',
    html,
  });

  assert.ok(corpus.includes('Visible copy.'));
  assert.ok(!corpus.includes('never shown promo copy'));
  assert.ok(!corpus.includes('also never shown'));
});

// CD-N05 acceptance criterion: "A fixture proves text revealed by a modal/accordion survives
// pruning with its interaction ID."
test('buildPageCorpus: text revealed by an accordion interaction survives pruning, grouped under its interaction ID', () => {
  const baselineHtml = `<html><body>
    <h1>FAQ</h1>
    <button id="faq-toggle" aria-controls="faq-panel" aria-expanded="false">What are the withdrawal limits?</button>
    <div id="faq-panel" hidden>Withdrawal limits are $5,000 per week.</div>
  </body></html>`;

  const afterHtml = `<html><body>
    <h1>FAQ</h1>
    <button id="faq-toggle" aria-controls="faq-panel" aria-expanded="true">What are the withdrawal limits?</button>
    <div id="faq-panel">Withdrawal limits are $5,000 per week.</div>
  </body></html>`;

  const interactionExecutions: InteractionExecutionRecord[] = [
    baseInteraction({
      domPath: '#faq-toggle',
      name: 'What are the withdrawal limits?',
      outcome: 'revealed_evidence',
      afterHtml,
      revealedContainerSelector: '#faq-panel',
    }),
    // A candidate that produced no measurable delta must never contribute an interaction section.
    baseInteraction({ domPath: '#unrelated-toggle', outcome: 'no_effect', afterHtml: undefined }),
  ];

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/faq',
    finalUrl: 'https://example.test/faq',
    title: 'FAQ',
    html: baselineHtml,
    interactionExecutions,
  });

  // Baseline evidence must not already contain the hidden panel's text (it was hidden and not
  // revealed via a recorded interaction in the baseline capture itself).
  const baselineSection = corpus.split('## Interaction-Revealed Evidence')[0]!;
  assert.ok(!baselineSection.includes('Withdrawal limits are $5,000 per week.'));

  assert.ok(corpus.includes('## Interaction-Revealed Evidence'));
  assert.ok(corpus.includes('### Interaction int-1 (accordion_or_disclosure — revealed_evidence)'));
  assert.ok(corpus.includes('Locator: #faq-toggle'));
  assert.ok(corpus.includes('Withdrawal limits are $5,000 per week.'));
  // The no-op candidate must never produce its own interaction section.
  assert.ok(!corpus.includes('#unrelated-toggle'));
});

test('buildPageCorpus: corpus output is materially smaller than the source HTML for a representative page', () => {
  const filler = Array.from({ length: 50 }, (_, i) => `<div class="tracker-${i}" data-gtm-id="x">noise-${i}</div>`).join('\n');
  const html = `<html><head><script>${'x'.repeat(2000)}</script></head><body>
    ${filler}
    <h1>Casino Terms</h1>
    <p>Full terms and conditions apply to all bonuses.</p>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/terms',
    finalUrl: 'https://example.test/terms',
    html,
  });

  assert.ok(corpus.length < html.length * 0.5, `expected corpus (${corpus.length}) to be materially smaller than html (${html.length})`);
  assert.ok(corpus.includes('Full terms and conditions apply to all bonuses.'));
});

test('buildPageCorpus: form select option text is preserved', () => {
  const html = `<html><body>
    <form>
      <label>Currency</label>
      <select name="currency">
        <option>USD</option>
        <option>EUR</option>
        <option>GBP</option>
      </select>
    </form>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/account',
    finalUrl: 'https://example.test/account',
    html,
  });

  assert.ok(corpus.includes('USD'));
  assert.ok(corpus.includes('EUR'));
  assert.ok(corpus.includes('GBP'));
});

// CF-01: image accessible labels (alt/aria-label/title) carry semantic meaning (e.g. a payment
// method logo) and must survive pruning as plain text, even though the <img> itself is dropped.
test('buildPageCorpus: an image alt inside a button survives pruning as text', () => {
  const html = `<html><body><button><img src="/visa.png" alt="Visa" /></button></body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    html,
  });

  assert.ok(corpus.includes('Visa'));
  assert.ok(!corpus.includes('visa.png'));
});

test('buildPageCorpus: an image aria-label survives pruning as text', () => {
  const html = `<html><body><img src="/mc.png" aria-label="Mastercard" /></body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    html,
  });

  assert.ok(corpus.includes('Mastercard'));
  assert.ok(!corpus.includes('mc.png'));
});

test('buildPageCorpus: a decorative image with empty alt contributes no text', () => {
  const html = `<html><body><p>Before.</p><img src="/spacer.png" alt="" /><p>After.</p></body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    html,
  });

  assert.ok(corpus.includes('Before.'));
  assert.ok(corpus.includes('After.'));
  assert.ok(!corpus.includes('spacer.png'));
});

test('buildPageCorpus: a header/footer logo image label does not survive chrome pruning', () => {
  const html = `<html><body>
    <header><img src="/logo.png" alt="CasinoBrand Logo" /></header>
    <main><p>Main content.</p></main>
    <footer><img src="/footer-logo.png" alt="CasinoBrand Footer Logo" /></footer>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/home',
    finalUrl: 'https://example.test/home',
    html,
  });

  assert.ok(corpus.includes('Main content.'));
  assert.ok(!corpus.includes('CasinoBrand Logo'));
  assert.ok(!corpus.includes('CasinoBrand Footer Logo'));
});

test('buildPageCorpus: every distinct image-only payment method label survives in a list', () => {
  const html = `<html><body>
    <ul>
      <li><img src="/visa.png" alt="Visa" /></li>
      <li><img src="/mastercard.png" alt="Mastercard" /></li>
      <li><img src="/skrill.png" aria-label="Skrill" /></li>
      <li><img src="/neteller.png" title="Neteller" /></li>
    </ul>
  </body></html>`;

  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/payments',
    finalUrl: 'https://example.test/payments',
    html,
  });

  assert.ok(corpus.includes('Visa'));
  assert.ok(corpus.includes('Mastercard'));
  assert.ok(corpus.includes('Skrill'));
  assert.ok(corpus.includes('Neteller'));
});

test('buildPageCorpus: includes requested/final URL and title metadata', () => {
  const corpus = buildPageCorpus({
    requestedUrl: 'https://example.test/a',
    finalUrl: 'https://example.test/a/',
    title: 'Example Page',
    html: '<html><body><p>hello</p></body></html>',
  });

  assert.ok(corpus.includes('# Example Page'));
  assert.ok(corpus.includes('Requested URL: https://example.test/a'));
  assert.ok(corpus.includes('Final URL: https://example.test/a/'));
});

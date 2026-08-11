import assert from 'node:assert/strict';
import test from 'node:test';

import { technicalFilter } from './technical-filter.ts';

const allowed = ['betlabel1.com', 'gg.bet', 'megarich.com', 'west-ace.com', 'ws43--westace.com'];

const positiveExamples = [
  'https://betlabel1.com/en/line',
  'https://betlabel1.com/en/live',
  'https://betlabel1.com/en/slots',
  'https://betlabel1.com/en/casino',
  'https://betlabel1.com/en/bonus/rules?category=casino',
  'https://betlabel1.com/en/office/recharge',
  'https://betlabel1.com/en/office/deduce',
  'https://gg.bet/casino/slots',
  'https://gg.bet/casino/live',
  'https://gg.bet/betting-welcome-bonus#!/player/profile-deposit',
  'https://gg.bet/betting-welcome-bonus#!/player/profile-cashier-withdraw',
  'https://megarich.com/en/sport?bt-path=/live-section',
  'https://megarich.com/en/',
  'https://west-ace.com/',
  'https://ws43--westace.com/en/payments',
];

test('technical filter preserves candidate-example page URLs', () => {
  for (const url of positiveExamples) {
    const decision = technicalFilter(url, url, allowed);
    assert.equal(decision.status, 'accepted', url);
  }
});

test('technical filter removes static scripts/fonts/styles/images/media but not JSON endpoints', () => {
  const cases: Array<[string, string]> = [
    ['https://gg.bet/assets/app.123.js', 'ASSET_SCRIPT'],
    ['https://gg.bet/assets/app.123.js.map', 'SOURCE_MAP'],
    ['https://gg.bet/fonts/inter.woff2', 'ASSET_FONT'],
    ['https://gg.bet/assets/site.css', 'ASSET_STYLESHEET'],
    ['https://gg.bet/assets/logo.svg', 'ASSET_IMAGE'],
    ['https://gg.bet/assets/intro.mp4', 'ASSET_MEDIA'],
  ];
  for (const [url, reason] of cases) {
    const decision = technicalFilter(url, 'https://gg.bet/', allowed);
    assert.equal(decision.status, 'rejected');
    assert.equal(decision.reason, reason);
  }

  assert.equal(technicalFilter('https://gg.bet/api/navigation.json', 'https://gg.bet/', allowed).status, 'accepted');
});

test('technical canonicalization drops tracking params but preserves business query and SPA hash route', () => {
  const business = technicalFilter(
    'https://betlabel1.com/en/bonus/rules?utm_source=x&category=casino&gclid=abc',
    'https://betlabel1.com/',
    allowed,
  );
  assert.equal(business.status, 'accepted');
  assert.equal(business.url, 'https://betlabel1.com/en/bonus/rules?category=casino');

  const spa = technicalFilter(
    'https://gg.bet/betting-welcome-bonus#!/player/profile-deposit',
    'https://gg.bet/',
    allowed,
  );
  assert.equal(spa.status, 'accepted');
  assert.equal(spa.url, 'https://gg.bet/betting-welcome-bonus#!/player/profile-deposit');
});

test('out-of-scope URLs are technical rejects', () => {
  const decision = technicalFilter('https://facebook.com/brand', 'https://gg.bet/', allowed);
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'OUT_OF_SCOPE_HOST');
});


test('allowed child host does not implicitly authorize its parent domain', () => {
  const decision = technicalFilter('https://example.com/private', 'https://casino.example.com/', ['casino.example.com']);
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'OUT_OF_SCOPE_HOST');
});

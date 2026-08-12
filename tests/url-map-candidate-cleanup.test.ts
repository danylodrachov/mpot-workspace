import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCleanDocumentUrlMap, classifyCandidateForNavigation } from '../src/research/url-map/candidate-cleanup.ts';
import { extractUrlLikeTokens, resolveCasinoRouteToken } from '../src/research/url-map/token-extractor.ts';
import type { RawUrlCandidate } from '../src/research/url-map/types.ts';

const host = new Set(['megarich.com']);

function candidate(rawUrl: string, sourceFamily: RawUrlCandidate['provenance']['sourceFamily'], label?: string): RawUrlCandidate {
  return {
    rawUrl,
    baseUrl: 'https://megarich.com/en',
    provenance: { sourceFamily, discoveredOn: 'https://megarich.com/en', label },
    observedAt: '2026-08-12T00:00:00.000Z',
  };
}

test('script token extractor rejects JavaScript/regex fragments from the MegaRich run', () => {
  const text = [
    '"/-("',
    '"/;(?!["',
    '"/(?:Once"',
    '"/[A-Z]/.test(t"',
    '"/;function"',
    '"/src/layout/DefaultLayout.vue"',
    '"/en/promo"',
    '"/en/games/category/live-casino"',
  ].join(' ');

  const tokens = extractUrlLikeTokens(text);
  assert.deepEqual(tokens.sort(), ['/en/games/category/live-casino', '/en/promo'].sort());
});

test('script route resolver keeps real same-host routes and rejects source/resource/API paths', () => {
  assert.equal(resolveCasinoRouteToken('/en/promo', 'https://megarich.com/en', host), 'https://megarich.com/en/promo');
  assert.equal(resolveCasinoRouteToken('/assets/js/app.js', 'https://megarich.com/en', host), null);
  assert.equal(resolveCasinoRouteToken('/src/layout/DefaultLayout.vue', 'https://megarich.com/en', host), null);
  assert.equal(resolveCasinoRouteToken('/api/player', 'https://megarich.com/en', host), null);
  assert.equal(resolveCasinoRouteToken('/:ids+', 'https://megarich.com/en', host), null);
});

test('DOM anchors are documents; preload/script hrefs are not', () => {
  assert.equal(classifyCandidateForNavigation(candidate('/en/promo', 'dom_navigation_url', 'a[href]'), host).disposition, 'document');
  assert.equal(classifyCandidateForNavigation(candidate('/en/promo', 'dom_url_attribute', 'a[href]'), host).disposition, 'document');
  assert.equal(classifyCandidateForNavigation(candidate('/assets/js/app.js', 'dom_url_attribute', 'script[src]'), host).disposition, 'resource');
  assert.equal(classifyCandidateForNavigation(candidate('/assets/js/app.js', 'document_metadata', 'link[rel=modulepreload]'), host).disposition, 'resource');
});

test('network/performance resources never enter navigation map', () => {
  const map = buildCleanDocumentUrlMap([
    candidate('https://megarich.com/en', 'entry_url'),
    candidate('https://megarich.com/fonts/font.woff2', 'network_source_url'),
    candidate('https://megarich.com/assets/js/app.js', 'performance_resource'),
    candidate('https://secure.livechatinc.com/customer/action/open_chat', 'network_document'),
    candidate('/en/promo', 'dom_navigation_url', 'a[href]'),
  ], host);
  assert.deepEqual(map.map(item => item.canonicalUrl), [
    'https://megarich.com/en',
    'https://megarich.com/en/promo',
  ]);
});

test('known candidate examples survive strict route-token resolution', () => {
  const examples = [
    'https://betlabel1.com/en/bonus/rules?category=casino',
    'https://gg.bet/betting-welcome-bonus#!/player/profile-deposit',
    'https://megarich.com/en/sport?bt-path=/live-section',
    'https://ws43--westace.com/en/payments',
  ];
  for (const value of examples) {
    const url = new URL(value);
    assert.equal(resolveCasinoRouteToken(value, url.origin, new Set([url.hostname])), url.toString());
  }
});

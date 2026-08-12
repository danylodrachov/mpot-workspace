import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAndDedupeUrlMap } from '../src/research/url-map/full-discovery.ts';
import type { RawUrlCandidate, SourceFamily } from '../src/research/url-map/types.ts';

function candidate(
  rawUrl: string,
  baseUrl = 'https://example.test/en/',
  sourceFamily: SourceFamily = 'dom_url_attribute',
): RawUrlCandidate {
  return {
    rawUrl,
    baseUrl,
    provenance: {
      sourceFamily,
      discoveredOn: baseUrl,
      label: 'fixture',
    },
    observedAt: '2026-08-12T00:00:00.000Z',
  };
}

test('URL-map resolution does not apply route, relevance, host, API, asset, game or landing filters', () => {
  const result = resolveAndDedupeUrlMap([
    candidate('/en'),
    candidate('/en'),
    candidate('/api/bonus?id=1&utm_source=test'),
    candidate('/games/individual-game-123'),
    candidate('/privacy-policy'),
    candidate('/responsible-gaming'),
    candidate('/assets/app.js', undefined, 'network_source_url'),
    candidate('https://external.example/path?q=1'),
    candidate('/welcome-bonus#!/player/profile-cashier-withdraw'),
    candidate('mailto:test@example.test'),
    candidate('not a valid http url', 'not a valid base'),
  ]);

  const urls = result.map(item => item.canonicalUrl);

  assert.deepEqual(urls, [
    'https://example.test/api/bonus?id=1&utm_source=test',
    'https://example.test/assets/app.js',
    'https://example.test/en',
    'https://example.test/games/individual-game-123',
    'https://example.test/privacy-policy',
    'https://example.test/responsible-gaming',
    'https://example.test/welcome-bonus#!/player/profile-cashier-withdraw',
    'https://external.example/path?q=1',
  ]);
});

test('duplicate canonical URL keeps one map row and merges provenance', () => {
  const result = resolveAndDedupeUrlMap([
    candidate('/promo', 'https://example.test/', 'dom_url_attribute'),
    candidate('https://example.test/promo', 'https://example.test/', 'sitemap_page_url'),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].canonicalUrl, 'https://example.test/promo');
  assert.deepEqual(
    result[0].provenance.map(item => item.sourceFamily).sort(),
    ['dom_url_attribute', 'sitemap_page_url'],
  );
});

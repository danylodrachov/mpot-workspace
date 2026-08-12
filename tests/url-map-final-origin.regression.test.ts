import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfiguredFallbackSitemapUrls } from '../src/research/url-map/full-discovery.ts';
import { discoverFromSeedWithoutCrawl } from '../src/research/url-map/seed-discovery.ts';

test('configured sitemap probes cover both input and final redirected origin', () => {
  assert.deepEqual(
    buildConfiguredFallbackSitemapUrls(
      'https://megarich.com/en',
      'https://megarich22.co/',
      ['/sitemap.xml', '/sitemap_index.xml'],
    ),
    [
      'https://megarich.com/sitemap.xml',
      'https://megarich.com/sitemap_index.xml',
      'https://megarich22.co/sitemap.xml',
      'https://megarich22.co/sitemap_index.xml',
    ],
  );
});

test('browser-confirmed final redirect host joins deterministic seed scope', async () => {
  let evaluateCall = 0;
  const page = {
    request: {
      get: async () => { throw new Error('unexpected technical-source request'); },
    },
    url: () => 'https://megarich22.co/',
    addInitScript: async () => {},
    on: () => {},
    off: () => {},
    goto: async () => ({
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForTimeout: async () => {},
    evaluate: async () => {
      evaluateCall += 1;
      if (evaluateCall === 1) {
        return {
          title: 'MegaRich',
          bodyText: 'Casino',
          matchedSelectors: [],
          currentUrl: 'https://megarich22.co/',
        };
      }
      return {
        attrs: [],
        metadata: [],
        inlineScripts: [],
        performanceUrls: [],
        historyRoutes: [],
        currentUrl: 'https://megarich22.co/',
      };
    },
  };

  const result = await discoverFromSeedWithoutCrawl(page as never, 'https://megarich.com/en');
  assert.ok(result.allowedHosts.includes('megarich.com'));
  assert.ok(result.allowedHosts.includes('megarich22.co'));
  assert.equal(result.finalEntryUrl, 'https://megarich22.co/');
});

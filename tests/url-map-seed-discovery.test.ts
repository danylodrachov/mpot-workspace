import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverFromSeedWithoutCrawl,
  resolveCasinoRouteToken,
  scanObservedTechnicalSources,
  shouldScanObservedTechnicalSource,
  type ApiRequestContextLike,
  type PageLike,
  type RequestLike,
} from '../src/research/url-map/index.ts';

test('cross-origin observed CDN script is eligible for technical scanning', () => {
  assert.equal(
    shouldScanObservedTechnicalSource({
      url: 'https://traincdn.com/assets/app.abc123.js',
      resourceType: 'script',
      discoveredOn: 'https://betlbl.com/en',
    }),
    true,
  );
});

test('CDN route tokens resolve against casino origin and external navigation URLs are discarded', () => {
  const allowed = new Set(['betlbl.com']);
  assert.equal(
    resolveCasinoRouteToken('/en/mobile', 'https://betlbl.com/en', allowed),
    'https://betlbl.com/en/mobile',
  );
  assert.equal(
    resolveCasinoRouteToken('en/bonus/rules', 'https://betlbl.com/en', allowed),
    'https://betlbl.com/en/bonus/rules',
  );
  assert.equal(
    resolveCasinoRouteToken('https://evil.example/steal', 'https://betlbl.com/en', allowed),
    null,
  );
});

test('technical scanner fetches observed cross-origin bundle but emits only casino-domain candidates', async () => {
  const request: ApiRequestContextLike = {
    async get(url) {
      assert.equal(url, 'https://traincdn.com/assets/app.js');
      return {
        ok: () => true,
        status: () => 200,
        headers: () => ({ 'content-type': 'application/javascript' }),
        body: async () => Buffer.from(`
          const mobile = "/en/mobile";
          const promo = "https://betlbl.com/en/bonus/rules";
          const vendor = "https://traincdn.com/other.js";
          const external = "https://evil.example/path";
        `),
      };
    },
  };

  const result = await scanObservedTechnicalSources(
    request,
    [{
      url: 'https://traincdn.com/assets/app.js',
      resourceType: 'script',
      discoveredOn: 'https://betlbl.com/en',
    }],
    'https://betlbl.com/en',
    new Set(['betlbl.com']),
  );

  const urls = new Set(result.candidates.map(candidate => candidate.rawUrl));
  assert.ok(urls.has('https://betlbl.com/en/mobile'));
  assert.ok(urls.has('https://betlbl.com/en/bonus/rules'));
  assert.equal([...urls].some(url => new URL(url).hostname === 'traincdn.com'), false);
  assert.equal([...urls].some(url => new URL(url).hostname === 'evil.example'), false);
  assert.deepEqual(result.errors, []);
});

test('seed discovery performs exactly one page navigation and scans observed CDN resources', async () => {
  let requestListener: ((request: RequestLike) => void) | undefined;
  const gotoCalls: string[] = [];
  const fetched: string[] = [];

  const page: PageLike = {
    request: {
      async get(url) {
        fetched.push(url);
        return {
          ok: () => true,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/javascript' }),
          body: async () => Buffer.from('const a="/en/mobile"; const b="https://outside.example/x";'),
        };
      },
    },
    url: () => 'https://betlbl.com/en',
    async addInitScript() {},
    on(_event, listener) { requestListener = listener; },
    off() { requestListener = undefined; },
    async goto(url) {
      gotoCalls.push(url);
      requestListener?.({ url: () => url, resourceType: () => 'document' });
      requestListener?.({ url: () => 'https://traincdn.com/assets/app.js', resourceType: () => 'script' });
      return { status: () => 200 };
    },
    async waitForTimeout() {},
    async evaluate<T>() {
      return {
        attrs: [
          { value: '/en/bonus/rules', label: 'a[href]' },
          { value: 'https://traincdn.com/assets/app.js', label: 'script[src]' },
        ],
        metadata: [],
        inlineScripts: [],
        performanceUrls: ['https://traincdn.com/assets/app.js'],
        historyRoutes: [],
      } as T;
    },
  };

  const result = await discoverFromSeedWithoutCrawl(page, 'https://betlbl.com/en');

  assert.deepEqual(gotoCalls, ['https://betlbl.com/en']);
  assert.deepEqual(fetched, ['https://traincdn.com/assets/app.js']);
  assert.ok(result.rawCandidates.some(candidate => candidate.rawUrl === '/en/bonus/rules'));
  assert.ok(result.rawCandidates.some(candidate => candidate.rawUrl === 'https://betlbl.com/en/mobile'));
  assert.equal(
    result.rawCandidates.some(candidate => candidate.rawUrl === 'https://outside.example/x'),
    false,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFrozenSeedUrls } from '../src/research/url-map/full-discovery.ts';
import {
  classifySeedAccessGate,
  discoverFromSeedWithoutCrawl,
  SeedAccessBlockedError,
  SeedHttpStatusError,
  withStableDocumentRead,
} from '../src/research/url-map/seed-discovery.ts';

test('frozen seed set contains entry + explicit seeds and does not infer discovered URLs', () => {
  const seeds = buildFrozenSeedUrls('https://west-ace.com/', {
    allowedHosts: ['ws43--westace.com'],
    seedUrls: ['https://ws43--westace.com/en/payments'],
  });

  assert.deepEqual(seeds, [
    'https://west-ace.com/',
    'https://ws43--westace.com/en/payments',
  ]);
});

test('allowed host roots are seeded only when explicitly enabled', () => {
  assert.deepEqual(
    buildFrozenSeedUrls('https://west-ace.com/', {
      allowedHosts: ['ws43--westace.com'],
      seedAllowedHostRoots: true,
    }),
    ['https://west-ace.com/', 'https://ws43--westace.com/'],
  );

  assert.deepEqual(
    buildFrozenSeedUrls('https://west-ace.com/', {
      allowedHosts: ['ws43--westace.com'],
      seedAllowedHostRoots: false,
    }),
    ['https://west-ace.com/'],
  );
});

test('Cloudflare challenge signals classify seed as blocked', () => {
  const result = classifySeedAccessGate({
    title: 'Just a moment...',
    bodyText: 'Cloudflare is checking your browser before accessing the site.',
    matchedSelectors: ['#challenge-running'],
    currentUrl: 'https://example.test/',
  });

  assert.equal(result?.kind, 'cloudflare_challenge');
  assert.ok(result?.evidence.includes('selector:#challenge-running'));
});

test('Cloudflare 5xx error page classifies seed as blocked from HTTP evidence', () => {
  const result = classifySeedAccessGate({
    title: 'Service unavailable',
    bodyText: 'Temporary upstream failure',
    matchedSelectors: [],
    currentUrl: 'https://example.test/',
    httpStatus: 503,
    responseHeaders: {
      server: 'cloudflare',
      'cf-ray': 'example-ray',
    },
  });

  assert.equal(result?.kind, 'cloudflare_error_page');
  assert.ok(result?.evidence.includes('http_status:503'));
  assert.ok(result?.evidence.includes('header:Cloudflare'));
});

test('generic 5xx response is a typed seed HTTP error, never a complete discovery', async () => {
  const page = {
    request: {
      get: async () => {
        throw new Error('unexpected request');
      },
    },
    url: () => 'https://example.test/',
    addInitScript: async () => {},
    on: () => {},
    off: () => {},
    goto: async () => ({
      status: () => 503,
      headers: () => ({ server: 'nginx' }),
    }),
    waitForTimeout: async () => {},
    evaluate: async () => ({
      title: 'Service unavailable',
      bodyText: 'Temporary upstream failure',
      matchedSelectors: [],
      currentUrl: 'https://example.test/',
    }),
  };

  await assert.rejects(
    discoverFromSeedWithoutCrawl(page as never, 'https://example.test/'),
    (error: unknown) =>
      error instanceof SeedHttpStatusError &&
      error.code === 'SEED_HTTP_ERROR' &&
      error.httpStatus === 503,
  );
});

test('Cloudflare 5xx response is a typed blocked seed', async () => {
  const page = {
    request: {
      get: async () => {
        throw new Error('unexpected request');
      },
    },
    url: () => 'https://example.test/',
    addInitScript: async () => {},
    on: () => {},
    off: () => {},
    goto: async () => ({
      status: () => 522,
      headers: () => ({ server: 'cloudflare', 'cf-ray': 'example-ray' }),
    }),
    waitForTimeout: async () => {},
    evaluate: async () => ({
      title: 'Connection timed out',
      bodyText: 'Error code 522. Cloudflare. Connection timed out.',
      matchedSelectors: [],
      currentUrl: 'https://example.test/',
    }),
  };

  await assert.rejects(
    discoverFromSeedWithoutCrawl(page as never, 'https://example.test/'),
    (error: unknown) =>
      error instanceof SeedAccessBlockedError &&
      error.kind === 'cloudflare_error_page',
  );
});

test('stable document read retries execution-context navigation race', async () => {
  let reads = 0;
  let waits = 0;
  const page = {
    waitForTimeout: async () => {
      waits += 1;
    },
  };

  const value = await withStableDocumentRead(page, async () => {
    reads += 1;
    if (reads < 3) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    return 'stable';
  });

  assert.equal(value, 'stable');
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('stable document read does not retry unrelated failures', async () => {
  let reads = 0;
  const page = { waitForTimeout: async () => {} };

  await assert.rejects(
    withStableDocumentRead(page, async () => {
      reads += 1;
      throw new Error('selector engine failure');
    }),
    /selector engine failure/,
  );
  assert.equal(reads, 1);
});

test('ordinary page is not classified as access gate', () => {
  assert.equal(classifySeedAccessGate({
    title: 'Casino',
    bodyText: 'Welcome bonus and games',
    matchedSelectors: [],
    currentUrl: 'https://example.test/en',
  }), null);
});

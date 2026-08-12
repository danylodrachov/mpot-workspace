import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFrozenSeedUrls } from '../src/research/url-map/full-discovery.ts';
import { classifySeedAccessGate } from '../src/research/url-map/seed-discovery.ts';

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

test('ordinary page is not classified as access gate', () => {
  assert.equal(classifySeedAccessGate({
    title: 'Casino',
    bodyText: 'Welcome bonus and games',
    matchedSelectors: [],
    currentUrl: 'https://example.test/en',
  }), null);
});

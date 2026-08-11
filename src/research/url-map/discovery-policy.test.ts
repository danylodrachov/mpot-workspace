import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRecursiveTraversal } from './discovery-policy.ts';

test('fallback mode does not crawl when sitemap exposes page URLs', () => {
  assert.deepEqual(decideRecursiveTraversal('fallback', 1), { run: false });
  assert.deepEqual(decideRecursiveTraversal('fallback', 1000), { run: false });
});

test('fallback mode crawls only when sitemap exposes zero page URLs', () => {
  assert.deepEqual(decideRecursiveTraversal('fallback', 0), {
    run: true,
    reason: 'NO_USABLE_SITEMAP_URLS',
  });
});

test('never and always are explicit overrides', () => {
  assert.deepEqual(decideRecursiveTraversal('never', 0), { run: false });
  assert.deepEqual(decideRecursiveTraversal('always', 1000), {
    run: true,
    reason: 'EXPLICIT_RECURSIVE_MODE',
  });
});

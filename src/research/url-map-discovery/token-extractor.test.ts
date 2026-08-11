import assert from 'node:assert/strict';
import test from 'node:test';
import { extractUrlTokens } from './token-extractor.ts';

test('extracts route table values but not source-code/assets/socket garbage', () => {
  const text = String.raw`
    const routes = ['/en/promo','/en/page/terms-and-conditions','/en/games/category/live-casino'];
    const layout = '/src/layout/DefaultLayout.vue';
    const a = '/assets/js/chunk-foo.js';
    const b = '/engine.io';
    const c = '/socket.io';
    const template = '/src/layout/${'${layout}'}Layout.vue';
    const absolute = 'https://example.test/en/payments';
  `;
  const values = extractUrlTokens(text);
  assert(values.includes('/en/promo'));
  assert(values.includes('/en/page/terms-and-conditions'));
  assert(values.includes('/en/games/category/live-casino'));
  assert(values.includes('https://example.test/en/payments'));
  assert(!values.some(v => v.includes('DefaultLayout.vue')));
  assert(!values.some(v => v.includes('chunk-foo.js')));
  assert(!values.includes('/engine.io'));
  assert(!values.includes('/socket.io'));
});

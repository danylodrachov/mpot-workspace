import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildCleanDocumentUrlMap } from '../src/research/url-map/candidate-cleanup.ts';
import type { RawUrlCandidate } from '../src/research/url-map/types.ts';

test('existing MegaRich raw run no longer turns JS/resource noise into navigation URLs', async () => {
  const raw = JSON.parse(await readFile(new URL('./fixtures/megarich-source-url-list.json', import.meta.url), 'utf8')) as RawUrlCandidate[];
  const map = buildCleanDocumentUrlMap(raw, new Set(['megarich.com']));
  const urls = map.map(item => item.canonicalUrl);

  assert.ok(urls.includes('https://megarich.com/en'));
  assert.ok(!urls.some(url => /\/assets\/|\/fonts\/|\/favicons\//.test(url)));
  assert.ok(!urls.some(url => /\/;function|\/\[A-Z\]|\/\(\?:|\/src\//.test(url)));
  assert.ok(!urls.some(url => url.includes('livechatinc.com')));
  assert.deepEqual(urls, ['https://megarich.com/en']);
});

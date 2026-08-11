import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIRequestContextLike, APIResponseLike } from './types.ts';
import { scanTechnicalSources } from './technical-source-scan.ts';

class FakeResponse implements APIResponseLike {
  private readonly code: number;
  private readonly payload: string;
  private readonly contentType: string;
  constructor(code: number, payload: string, contentType: string) { this.code = code; this.payload = payload; this.contentType = contentType; }
  ok(): boolean { return this.code >= 200 && this.code < 300; }
  status(): number { return this.code; }
  headers(): Record<string, string> { return { 'content-type': this.contentType }; }
  async text(): Promise<string> { return this.payload; }
  async body(): Promise<Buffer> { return Buffer.from(this.payload); }
  async dispose(): Promise<void> {}
}

class FakeRequest implements APIRequestContextLike {
  readonly requested: string[] = [];
  async get(url: string): Promise<APIResponseLike> {
    this.requested.push(url);
    if (url.endsWith('/app.js')) return new FakeResponse(200, `const r=['/en/promo','/en/page/bonus-terms','/src/layout/DefaultLayout.vue','/engine.io'];`, 'application/javascript');
    if (url.endsWith('/config.json')) return new FakeResponse(200, `{"routes":["/en/games/category/live-casino","/en/sport"]}`, 'application/json');
    throw new Error(`unexpected fetch: ${url}`);
  }
}

test('explicit re-fetch scans text sources and never fetches image/font noise', async () => {
  const request = new FakeRequest();
  const result = await scanTechnicalSources(request, [
    'https://example.test/assets/logo.png',
    'https://example.test/fonts/site.woff2',
    'https://example.test/assets/app.js',
    'https://example.test/api/config.json',
  ], 'https://example.test/en', new Set(['example.test']));

  assert.deepEqual(request.requested.sort(), [
    'https://example.test/api/config.json',
    'https://example.test/assets/app.js',
  ]);
  const urls = result.candidates.map(c => c.rawUrl);
  for (const expected of ['/en/promo','/en/page/bonus-terms','/en/games/category/live-casino','/en/sport']) assert(urls.includes(expected), expected);
  assert(!urls.some(v => v.includes('DefaultLayout.vue')));
  assert(!urls.includes('/engine.io'));
  assert.equal(result.errors.length, 0);
});

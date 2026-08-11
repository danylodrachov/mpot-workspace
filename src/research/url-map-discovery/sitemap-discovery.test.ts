import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIRequestContextLike, APIResponseLike } from './types.ts';
import { discoverSitemaps } from './sitemap-discovery.ts';

class FakeResponse implements APIResponseLike {
  private readonly code: number;
  private readonly payload: string;
  private readonly headerMap: Record<string, string>;
  constructor(code: number, payload: string, headerMap: Record<string, string> = { 'content-type': 'application/xml' }) { this.code = code; this.payload = payload; this.headerMap = headerMap; }
  ok(): boolean { return this.code >= 200 && this.code < 300; }
  status(): number { return this.code; }
  headers(): Record<string, string> { return this.headerMap; }
  async text(): Promise<string> { return this.payload; }
  async body(): Promise<Buffer> { return Buffer.from(this.payload); }
  async dispose(): Promise<void> {}
}

class FakeRequest implements APIRequestContextLike {
  readonly requested: string[] = [];
  private readonly routes: Map<string, FakeResponse>;
  constructor(routes: Map<string, FakeResponse>) { this.routes = routes; }
  async get(url: string): Promise<APIResponseLike> {
    this.requested.push(url);
    return this.routes.get(url) ?? new FakeResponse(404, '', { 'content-type': 'text/plain' });
  }
}

test('robots -> sitemap index -> child sitemap yields document URLs only', async () => {
  const routes = new Map<string, FakeResponse>([
    ['https://example.test/robots.txt', new FakeResponse(200, 'User-agent: *\nSitemap: https://example.test/sitemap_index.xml\n', { 'content-type': 'text/plain' })],
    ['https://example.test/sitemap_index.xml', new FakeResponse(200, '<sitemapindex><sitemap><loc>https://example.test/sitemap-pages.xml</loc></sitemap></sitemapindex>')],
    ['https://example.test/sitemap-pages.xml', new FakeResponse(200, '<urlset><url><loc>https://example.test/en/promo</loc></url><url><loc>https://example.test/en/page/terms-and-conditions</loc></url></urlset>')],
  ]);
  const request = new FakeRequest(routes);
  const result = await discoverSitemaps(request, 'https://example.test/en', new Set(['example.test']));

  assert.deepEqual(result.candidates.map(c => c.rawUrl).sort(), [
    'https://example.test/en/page/terms-and-conditions',
    'https://example.test/en/promo',
  ]);
  assert(!result.candidates.some(c => /sitemap/i.test(c.rawUrl)));
  assert.equal(result.coverage.find(r => r.sourceFamily === 'robots_sitemap')?.candidateCount, 1);
  assert.equal(result.coverage.find(r => r.sourceFamily === 'robots_sitemap')?.status, 'complete');
  assert.equal(result.coverage.find(r => r.sourceFamily === 'sitemap_url')?.status, 'complete');
});

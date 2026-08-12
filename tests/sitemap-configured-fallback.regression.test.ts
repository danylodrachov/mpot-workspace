import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverSitemaps, type ApiRequestLike, type SeedObservation } from '../src/research/sitemap-discovery.ts';

class FakeResponse {
  private readonly requestedUrl: string;
  private readonly code: number;
  private readonly bodyText: string;
  private readonly contentType: string;

  constructor(requestedUrl: string, code: number, bodyText: string, contentType = 'application/xml') {
    this.requestedUrl = requestedUrl;
    this.code = code;
    this.bodyText = bodyText;
    this.contentType = contentType;
  }
  status(): number { return this.code; }
  headers(): Record<string, string> { return { 'content-type': this.contentType }; }
  body(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.bodyText)); }
  url(): string { return this.requestedUrl; }
}

test('configured fallback sitemap path has truthful configured_fallback provenance', async () => {
  const request: ApiRequestLike = {
    async get(url: string) {
      if (url === 'https://example.test/robots.txt') return new FakeResponse(url, 404, '', 'text/plain');
      if (url === 'https://example.test/sitemap.xml') {
        return new FakeResponse(url, 200, '<?xml version="1.0"?><urlset><url><loc>https://example.test/payments</loc></url></urlset>');
      }
      return new FakeResponse(url, 404, '', 'text/plain');
    },
  };
  const seed: SeedObservation = {
    requested_url: 'https://example.test/',
    final_url: 'https://example.test/',
    navigation_status: 'ok',
    http_status: 200,
    content_type: 'text/html',
    main_response_body: null,
    link_header_candidates: [],
    rendered_dom_candidates: [],
    document_text_candidates: [],
    network_candidates: [],
    configured_fallback_candidates: ['https://example.test/sitemap.xml'],
    error_reason: null,
  };

  const result = await discoverSitemaps(request, 'https://example.test/', seed);
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(result.page_urls, ['https://example.test/payments']);
  assert.deepEqual(result.root_sitemaps[0]?.discovered_by, ['configured_fallback']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverSitemaps, type ApiRequestLike, type SeedObservation } from '../src/research/sitemap-discovery.ts';

class FakeResponse {
  constructor(
    private readonly requestedUrl: string,
    private readonly code: number,
    private readonly bodyText: string,
    private readonly contentType = 'application/xml',
  ) {}
  status(): number { return this.code; }
  headers(): Record<string, string> { return { 'content-type': this.contentType }; }
  body(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.bodyText)); }
  url(): string { return this.requestedUrl; }
}

function seed(): SeedObservation {
  return {
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
}

test('API-blocked sitemap is retried through browser navigation', async () => {
  const request: ApiRequestLike = {
    async get(url: string) {
      if (url === 'https://example.test/robots.txt') return new FakeResponse(url, 404, '', 'text/plain');
      if (url === 'https://example.test/sitemap.xml') return new FakeResponse(url, 403, '<html>Forbidden</html>', 'text/html');
      return new FakeResponse(url, 404, '', 'text/plain');
    },
  };
  const browserCalls: string[] = [];
  const result = await discoverSitemaps(request, 'https://example.test/', seed(), {
    browserFallback: async url => {
      browserCalls.push(url);
      return {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        body: Buffer.from('<?xml version="1.0"?><urlset><url><loc>https://example.test/payments</loc></url></urlset>'),
        finalUrl: url,
      };
    },
  });

  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(browserCalls, ['https://example.test/sitemap.xml']);
  assert.deepEqual(result.page_urls, ['https://example.test/payments']);
  const attempt = result.attempts.find(item => item.url === 'https://example.test/sitemap.xml');
  assert.equal(attempt?.status, 'ok');
  assert.equal(attempt?.fetch_method, 'browser_navigation');
  assert.equal(attempt?.fallback_from_http_status, 403);
});

test('ordinary sitemap 404 does not trigger browser fallback', async () => {
  const request: ApiRequestLike = { async get(url: string) { return new FakeResponse(url, 404, '', 'text/plain'); } };
  let calls = 0;
  await discoverSitemaps(request, 'https://example.test/', seed(), {
    browserFallback: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(calls, 0);
});

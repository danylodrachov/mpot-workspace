import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  discoverSitemaps,
  parseLinkHeaderSitemaps,
  parseRobotsSitemaps,
  parseSitemapDocument,
  type ApiRequestLike,
  type ApiResponseLike,
  type SeedObservation,
} from './sitemap-discovery.ts';

class MockResponse implements ApiResponseLike {
  private readonly statusCode: number;
  private readonly payload: Buffer;
  private readonly responseHeaders: Record<string, string>;
  private readonly finalUrl?: string;

  constructor(
    statusCode: number,
    text: string | Buffer,
    contentType = 'application/xml',
    finalUrl?: string,
    extraHeaders: Record<string, string> = {},
  ) {
    this.statusCode = statusCode;
    this.payload = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    this.responseHeaders = { 'content-type': contentType, ...extraHeaders };
    this.finalUrl = finalUrl;
  }

  status(): number { return this.statusCode; }
  headers(): Record<string, string> { return this.responseHeaders; }
  async body(): Promise<Buffer> { return this.payload; }
  url(): string { return this.finalUrl ?? ''; }
}

function mockRequest(routes: Record<string, MockResponse>): ApiRequestLike & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async get(url: string): Promise<ApiResponseLike> {
      requested.push(url);
      return routes[url] ?? new MockResponse(404, 'not found', 'text/plain', url);
    },
  };
}

function seed(overrides: Partial<SeedObservation> = {}): SeedObservation {
  return {
    requested_url: 'https://example.com/',
    final_url: 'https://example.com/',
    navigation_status: 'ok',
    http_status: 200,
    content_type: 'text/html',
    main_response_body: Buffer.from('<html></html>'),
    link_header_candidates: [],
    rendered_dom_candidates: [],
    document_text_candidates: [],
    network_candidates: [],
    error_reason: null,
    ...overrides,
  };
}

test('parses robots Sitemap directives case-insensitively and keeps arbitrary sitemap paths', () => {
  assert.deepEqual(
    parseRobotsSitemaps(
      'User-agent: *\nSitemap: https://example.com/internal/maps/catalogue-feed-2026\nsitemap: /generated/site-map?id=42',
      'https://example.com/robots.txt',
    ),
    [
      'https://example.com/internal/maps/catalogue-feed-2026',
      'https://example.com/generated/site-map?id=42',
    ],
  );
});

test('parses Link rel=sitemap without requiring a fixed filename', () => {
  assert.deepEqual(
    parseLinkHeaderSitemaps('</generated/site-map?id=42>; rel="sitemap", </feed>; rel="alternate"', 'https://example.com/'),
    ['https://example.com/generated/site-map?id=42'],
  );
});

test('parses XML sitemap index/urlset plus RSS, Atom and plain text sitemap formats', () => {
  assert.deepEqual(
    parseSitemapDocument('<sitemapindex><sitemap><loc>https://example.com/posts.xml</loc></sitemap></sitemapindex>', 'application/xml'),
    { kind: 'sitemap_index', locations: ['https://example.com/posts.xml'] },
  );
  assert.deepEqual(
    parseSitemapDocument('<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc></url></urlset>', 'application/xml'),
    { kind: 'urlset', locations: ['https://example.com/a?x=1&y=2'] },
  );
  assert.deepEqual(
    parseSitemapDocument('<rss><channel><item><link>https://example.com/rss-page</link></item></channel></rss>', 'application/rss+xml'),
    { kind: 'rss', locations: ['https://example.com/rss-page'] },
  );
  assert.deepEqual(
    parseSitemapDocument('<feed><entry><link href="https://example.com/atom-page" /></entry></feed>', 'application/atom+xml'),
    { kind: 'atom', locations: ['https://example.com/atom-page'] },
  );
  assert.deepEqual(
    parseSitemapDocument('https://example.com/a\nhttps://example.com/b\n', 'text/plain'),
    { kind: 'text', locations: ['https://example.com/a', 'https://example.com/b'] },
  );
});

test('robots -> arbitrary sitemap index -> child XML; page URLs are recorded but never fetched', async () => {
  const root = 'https://example.com/internal/maps/catalogue-feed-2026';
  const child = 'https://cdn.example.net/maps/casino-categories-august';
  const pageUrl = 'https://example.com/promotions/summer';
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(200, `Sitemap: ${root}`, 'text/plain', 'https://example.com/robots.txt'),
    [root]: new MockResponse(200, `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`, 'application/xml', root),
    [child]: new MockResponse(200, `<urlset><url><loc>${pageUrl}</loc></url></urlset>`, 'application/xml', child),
  });

  const result = await discoverSitemaps(request, 'https://example.com', seed());
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;

  assert.deepEqual(result.root_sitemaps, [{ url: root, discovered_by: ['robots'] }]);
  assert.deepEqual(result.page_urls, [pageUrl]);
  assert.equal(result.category_sitemaps.length, 1);
  assert.equal(result.category_sitemaps[0]?.url, child);
  assert.equal(request.requested.includes(pageUrl), false);
});

test('discovers an arbitrary sitemap URL observed in rendered seed DOM when robots has none', async () => {
  const root = 'https://example.com/custom/generated/map?tenant=no';
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(200, 'User-agent: *', 'text/plain', 'https://example.com/robots.txt'),
    [root]: new MockResponse(200, '<urlset><url><loc>https://example.com/payments</loc></url></urlset>', 'application/xml', root),
  });

  const result = await discoverSitemaps(request, 'https://example.com', seed({ rendered_dom_candidates: [root] }));
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(result.root_sitemaps, [{ url: root, discovered_by: ['rendered_dom'] }]);
});

test('discovers an arbitrary sitemap URL from an observed Link header/network signal', async () => {
  const root = 'https://maps.example.net/catalog?id=99';
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(404, 'not found', 'text/plain', 'https://example.com/robots.txt'),
    [root]: new MockResponse(200, '<urlset><url><loc>https://example.com/casino</loc></url></urlset>', 'application/xml', root),
  });

  const result = await discoverSitemaps(request, 'https://example.com', seed({ link_header_candidates: [root], network_candidates: [root] }));
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(result.root_sitemaps, [{ url: root, discovered_by: ['link_header', 'network_observation'] }]);
});

test('supports gzip-compressed sitemap bodies', async () => {
  const root = 'https://example.com/generated-map';
  const xml = '<urlset><url><loc>https://example.com/gz</loc></url></urlset>';
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(200, `Sitemap: ${root}`, 'text/plain', 'https://example.com/robots.txt'),
    [root]: new MockResponse(200, gzipSync(Buffer.from(xml)), 'application/gzip', root),
  });
  const result = await discoverSitemaps(request, 'https://example.com', seed());
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(result.page_urls, ['https://example.com/gz']);
});

test('does not probe any guessed sitemap fallback path and reports not-discoverable honestly', async () => {
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(200, 'User-agent: *\nDisallow:', 'text/plain', 'https://example.com/robots.txt'),
  });

  const result = await discoverSitemaps(request, 'https://example.com', seed());
  assert.equal(result.status, 'not_discovered');
  if (result.status !== 'not_discovered') return;
  assert.equal(result.reason.code, 'SITEMAP_NOT_DISCOVERABLE');
  assert.deepEqual(request.requested, ['https://example.com/robots.txt']);
  assert.equal(result.reason.limitations.some(value => value.includes('No guessed/hardcoded sitemap paths')), true);
});

test('treats the supplied input document itself as a sitemap without re-fetching it', async () => {
  const input = 'https://example.com/custom-feed';
  const request = mockRequest({
    'https://example.com/robots.txt': new MockResponse(404, 'missing', 'text/plain', 'https://example.com/robots.txt'),
  });
  const result = await discoverSitemaps(request, input, seed({
    requested_url: input,
    final_url: input,
    content_type: 'application/xml',
    main_response_body: Buffer.from('<urlset><url><loc>https://example.com/a</loc></url></urlset>'),
  }));

  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  assert.deepEqual(result.root_sitemaps, [{ url: input, discovered_by: ['input_document'] }]);
  assert.equal(request.requested.includes(input), false);
});

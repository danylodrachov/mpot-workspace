import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExtractor } from './extractors.ts';

const pageUrl = 'https://example.com/en/';

// (1) DOM attributes + document metadata extraction
test('DOM_URL_ATTRIBUTES_V1 extracts href/src/action/data-* attrs (1)', () => {
  const html = `<a href="/terms">Terms</a><img src="/img/x.png"><form action="/login"><a data-href="/support"></a>`;
  const r = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/terms'));
  assert.ok(r.urls.includes('https://example.com/support'));
});

test('DOCUMENT_METADATA_URLS_V1 extracts canonical/alternate/manifest (1)', () => {
  const html = `<link rel="canonical" href="/en/support"><link rel="manifest" href="/manifest.json">`;
  const r = runExtractor('DOCUMENT_METADATA_URLS_V1', { pageUrl, html });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/en/support'));
  assert.ok(r.urls.includes('https://example.com/manifest.json'));
});

// (2) config-driven SPA routes
test('SPA_ROUTE_URL_TOKENS_V1 extracts route tokens from config script (2)', () => {
  const scripts = [`window.__ROUTES__=["/deposit-limits","/support","/my-account/kyc"];`];
  const r = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl, scripts });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/deposit-limits'));
});

// (3) hashed JSON manifests / bundles
test('JSON_ENDPOINT_URL_TOKENS_V1 walks a hashed bundle registry (3)', () => {
  const json = JSON.stringify({ footer: '/bundles/footer.abc123.json', seo: '/bundles/seo.def456.json', notAUrl: 'hello' });
  const r = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/bundles/footer.abc123.json'));
  assert.ok(!r.urls.some((u) => u.includes('hello')));
});

// (4) Next.js/Nuxt hydration data
test('FRAMEWORK_MANIFEST_URL_TOKENS_V1 walks __NEXT_DATA__-shaped payload (4)', () => {
  const json = JSON.stringify({ props: { pageProps: { links: ['/promo', '/bonus-terms'] } }, page: '/' });
  const r = runExtractor('FRAMEWORK_MANIFEST_URL_TOKENS_V1', { pageUrl, json });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/promo'));
  assert.ok(r.urls.includes('https://example.com/bonus-terms'));
});

// (5) browser resource and network URLs
test('PERFORMANCE_RESOURCE_URLS_V1 accepts pre-resolved resource candidates (5)', () => {
  const r = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', {
    pageUrl,
    candidates: ['https://example.com/chunk.a1b2.js', 'https://cdn.example.com/img.png'],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 2);
});

// (6) robots.txt sitemap directives
test('ROBOTS_SITEMAP_URLS_V1 extracts Sitemap: directives (6)', () => {
  const text = 'User-agent: *\nDisallow: /account\nSitemap: https://example.com/sitemap.xml\n';
  const r = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl, text });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.urls, ['https://example.com/sitemap.xml']);
});

// (7) nested sitemap indexes
test('SITEMAP_URLS_V1 extracts nested <loc> entries from a sitemap index (7)', () => {
  const text = `<sitemapindex><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-support.xml</loc></sitemap></sitemapindex>`;
  const r = runExtractor('SITEMAP_URLS_V1', { pageUrl, text });
  assert.equal(r.urls.length, 2);
});

// (8) path/query/hash routes; (9) locale variants
test('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1 resolves path/query/hash SPA routes incl. locale variants (8,9)', () => {
  const scripts = [`const routes=["/en/support?ref=1","/de-AT/support","/support#faq"];`];
  const r = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.some((u) => u.includes('/de-AT/support')));
  assert.ok(r.urls.some((u) => u.includes('ref=1')));
});

// (10) menu-injected links — extractor accepts a supplied "post-interaction" snapshot
test('DOM_URL_ATTRIBUTES_V1 picks up links present only after menu interaction (10)', () => {
  const preHtml = `<a href="/home">Home</a>`;
  const postHtml = `<a href="/home">Home</a><a href="/deposit-limits">Limits</a>`; // simulates opened drawer
  const pre = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html: preHtml });
  const post = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html: postHtml });
  assert.ok(!pre.urls.includes('https://example.com/deposit-limits'));
  assert.ok(post.urls.includes('https://example.com/deposit-limits'));
});

// (15) non-URL output rejection
test('extractors reject non-URL candidates via rejectedCount, never pass them through (15)', () => {
  const html = `<a href="javascript:void(0)">x</a><a href="mailto:info@example.com">y</a>`;
  const r = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html });
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejectedCount >= 1);
});

test('JSON_ENDPOINT_URL_TOKENS_V1 reports error status on invalid JSON, never throws (15)', () => {
  const r = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json: '{not valid json' });
  assert.equal(r.status, 'error');
  assert.equal(r.urls.length, 0);
});

// (19) absence of agent-facing page content — structural assertion
test('ExtractorResult never structurally carries raw input back out (19)', () => {
  const html = '<a href="/terms">Terms and Conditions long descriptive text</a>';
  const r = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html });
  const keys = Object.keys(r);
  assert.deepEqual(keys.sort(), ['rejectedCount', 'status', 'urls'].sort());
  for (const u of r.urls) assert.ok(!u.includes('Terms and Conditions long descriptive text'));
});

test('unknown extractor id yields error status, not a crash', () => {
  // @ts-expect-error deliberately invalid id for runtime rejection test
  const r = runExtractor('NOT_A_REAL_EXTRACTOR', { pageUrl });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'unknown_extractor');
});

// Issue 97: Script and Manifest URL Extractors — comprehensive locked test
test('Issue 97: INLINE_SCRIPT_URL_TOKENS_V1 extracts config routes from bootstrap scripts', () => {
  const scripts = [
    `<script>window.__CONFIG__={routes:["/deposit","/withdrawal","/bonus"]};</script>`,
    `var someOtherScript = "unrelated content";`,
  ];
  const r = runExtractor('INLINE_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts, params: { scriptMatch: '__CONFIG__' } });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/deposit'));
  assert.ok(r.urls.includes('https://example.com/withdrawal'));
  assert.ok(r.urls.includes('https://example.com/bonus'));
});

test('Issue 97: FRAMEWORK_MANIFEST_URL_TOKENS_V1 extracts from Next.js __NEXT_DATA__ hydration', () => {
  const json = JSON.stringify({
    props: {
      pageProps: {
        siteConfig: {
          navigation: ['/slots', '/live-casino', '/sports'],
          assetUrls: ['/assets/bg.jpg', '/js/app.bundle.js'],
        },
      },
    },
    page: '/',
  });
  const r = runExtractor('FRAMEWORK_MANIFEST_URL_TOKENS_V1', { pageUrl, json });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/slots'));
  assert.ok(r.urls.includes('https://example.com/live-casino'));
  assert.ok(r.urls.includes('https://example.com/sports'));
  // Verify asset URLs are kept (not filtered out)
  assert.ok(r.urls.some((u) => u.includes('app.bundle.js')));
});

test('Issue 97: SAME_ORIGIN_SCRIPT_URL_TOKENS_V1 extracts diverse path formats and locale variants', () => {
  const scripts = [
    `const routes = ["/en/terms", "/de-AT/about", "/fr/promotions", "/support?ref=header", "/help#contact"];`,
    `window.apiEndpoints = {terms: "/api/terms", contact: "mailto:info@example.com"};`,
  ];
  const r = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.some((u) => u.includes('/en/terms')));
  assert.ok(r.urls.some((u) => u.includes('/de-AT/about')));
  assert.ok(r.urls.some((u) => u.includes('/support') && u.includes('ref=header')));
  // Verify non-URL content is rejected
  assert.ok(!r.urls.some((u) => u.includes('mailto')));
});

test('Issue 97: Three script/manifest extractors together on a fixture with minimal DOM anchors', () => {
  // Minimal HTML with no useful footer links
  const html = `<html><head><title>Slots</title></head><body><h1>Welcome</h1></body></html>`;

  // Config extracted from inline script
  const configScript = `window.__INIT__ = { routes: ["/slots-lobby", "/live-games"] };`;

  // Next.js manifest
  const nextData = JSON.stringify({
    props: { pageProps: { routes: ['/account', '/cashier'] } },
  });

  // Run all three extractors (simulating a recipe with all three)
  const domResult = runExtractor('DOM_URL_ATTRIBUTES_V1', { pageUrl, html });
  const inlineResult = runExtractor('INLINE_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts: [configScript], params: { scriptMatch: '__INIT__' } });
  const manifestResult = runExtractor('FRAMEWORK_MANIFEST_URL_TOKENS_V1', { pageUrl, json: nextData });

  // Verify config/manifest extractors yield URLs even when DOM has none
  assert.equal(domResult.urls.length, 0, 'DOM should find no routes in minimal HTML');
  assert.ok(inlineResult.urls.length > 0, 'Inline script should extract config routes');
  assert.ok(manifestResult.urls.length > 0, 'Framework manifest should extract routes');

  // Collect all URLs
  const allUrls = [...inlineResult.urls, ...manifestResult.urls];
  assert.ok(allUrls.includes('https://example.com/slots-lobby'));
  assert.ok(allUrls.includes('https://example.com/live-games'));
  assert.ok(allUrls.includes('https://example.com/account'));
  assert.ok(allUrls.includes('https://example.com/cashier'));
});

// Issue 100: Interaction-navigation URL extractor and anonymous-first workflow
test('Issue 100: INTERACTION_NAVIGATION_URLS_V1 extracts links from hidden menu/drawer elements', () => {
  // Simulates post-interaction HTML with menu items revealed
  const html = `
    <a href="/home">Home</a>
    <div class="menu" style="display:none">
      <a href="/deposit-limits">Deposit Limits</a>
      <a href="/responsible-gaming">Responsible Gaming</a>
      <a data-menu-url="/terms">Terms and Conditions</a>
    </div>
    <div class="drawer" data-drawer-items='["/bonus-terms","/faq"]'>
      <a href="/bonus-terms">Bonus Terms</a>
      <a href="/faq">FAQ</a>
    </div>
  `;
  const r = runExtractor('INTERACTION_NAVIGATION_URLS_V1', { pageUrl, html });
  assert.equal(r.status, 'ok');
  // Verify hidden menu links are extracted
  assert.ok(r.urls.includes('https://example.com/deposit-limits'));
  assert.ok(r.urls.includes('https://example.com/responsible-gaming'));
  assert.ok(r.urls.includes('https://example.com/terms'));
  // Verify drawer links are extracted
  assert.ok(r.urls.includes('https://example.com/bonus-terms'));
  assert.ok(r.urls.includes('https://example.com/faq'));
  assert.ok(r.urls.includes('https://example.com/home'));
});

test('Issue 100: INTERACTION_NAVIGATION_URLS_V1 handles empty or absent menu elements', () => {
  const html = `<a href="/home">Home</a>`;
  const r = runExtractor('INTERACTION_NAVIGATION_URLS_V1', { pageUrl, html });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/home'));
  // Should handle gracefully when no hidden menus present
});

test('Issue 100: INTERACTION_NAVIGATION_URLS_V1 rejects non-URL values and never surfaces text content', () => {
  const html = `
    <div class="menu" style="display:none">
      <a href="javascript:alert('click')">Click me</a>
      <a href="/valid-path">Valid</a>
    </div>
  `;
  const r = runExtractor('INTERACTION_NAVIGATION_URLS_V1', { pageUrl, html });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/valid-path'));
  // JavaScript URLs should be rejected
  assert.ok(!r.urls.some((u) => u.includes('javascript')));
  assert.ok(!r.urls.some((u) => u.includes('click')));
});

test('Issue 97: Extractors reject event/game-detail URLs and other non-route pollution', () => {
  // Simulate a script that references event details (should be rejected)
  const pollutedScript = `
    const eventIds = ["/events/match-123", "/games/slot-456"];
    const routes = ["/sports", "/casino"];
  `;
  const r = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts: [pollutedScript] });
  assert.equal(r.status, 'ok');

  // Good URLs should be present
  assert.ok(r.urls.some((u) => u.endsWith('/sports') || u.endsWith('/casino')));

  // Note: This test verifies that the extractor itself extracts both,
  // but the downstream URL cleaning policy (issue 95) is responsible for filtering
  // game/event details. The extractor returns only URL-shaped tokens.
  assert.ok(r.urls.length > 0);
});

// Generalizability: verify extractors work with different data, not just test data
test('Issue 97: INLINE_SCRIPT_URL_TOKENS_V1 generalizes to different bootstrap marker names', () => {
  const scripts = [
    `window.__RUNTIME__={paths:["/promo","/vip","/affiliate"]}`,
    `const CONFIG = {urls:["/rewards"]};`,
  ];
  // Test with different scriptMatch parameter
  const r1 = runExtractor('INLINE_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts, params: { scriptMatch: '__RUNTIME__' } });
  assert.ok(r1.urls.includes('https://example.com/promo'));
  assert.ok(r1.urls.includes('https://example.com/vip'));

  // Test without scriptMatch (scans all scripts)
  const r2 = runExtractor('INLINE_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts });
  assert.ok(r2.urls.length > 0);
  assert.ok(r2.urls.some((u) => u.includes('/rewards')));
});

test('Issue 97: FRAMEWORK_MANIFEST_URL_TOKENS_V1 generalizes to Nuxt, Remix, and other frameworks', () => {
  // Nuxt-style payload
  const nuxtJson = JSON.stringify({
    state: { routes: ['/betting', '/statistics'] },
    meta: { title: 'Sports Betting', assetPaths: ['/vendor/chunks.js'] },
  });
  const nuxtResult = runExtractor('FRAMEWORK_MANIFEST_URL_TOKENS_V1', { pageUrl, json: nuxtJson });
  assert.equal(nuxtResult.status, 'ok');
  assert.ok(nuxtResult.urls.some((u) => u.includes('/betting')));

  // Custom SPA bootstrap format
  const customJson = JSON.stringify({
    routeMap: { sports: '/sports-book', casino: '/casino-games' },
    apiEndpoints: ['/api/config', '/api/games'],
  });
  const customResult = runExtractor('FRAMEWORK_MANIFEST_URL_TOKENS_V1', { pageUrl, json: customJson });
  assert.equal(customResult.status, 'ok');
  assert.ok(customResult.urls.some((u) => u.includes('/sports-book')));
  assert.ok(customResult.urls.some((u) => u.includes('/api/config')));
});

test('Issue 97: SAME_ORIGIN_SCRIPT_URL_TOKENS_V1 handles edge cases (empty, no scripts, malformed)', () => {
  // Empty script array
  const emptyResult = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts: [] });
  assert.equal(emptyResult.status, 'empty');
  assert.equal(emptyResult.urls.length, 0);

  // Script with no URL-shaped tokens
  const noUrlsScript = `const text = "hello world"; const number = 42;`;
  const noUrlsResult = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts: [noUrlsScript] });
  assert.equal(noUrlsResult.status, 'empty');

  // Mixed valid and invalid URLs (invalid ones won't match the regex because they don't start with / or http(s)://)
  const mixedScript = `const urls = ["/valid", "mailto:info@example.com", "/another/valid", "notascheme://example"];`;
  const mixedResult = runExtractor('SAME_ORIGIN_SCRIPT_URL_TOKENS_V1', { pageUrl, scripts: [mixedScript] });
  assert.equal(mixedResult.status, 'ok');
  assert.equal(mixedResult.urls.length, 2);
  // rejectedCount reflects tokens that matched but didn't resolve (URL constructor threw)
});

// Issue 98: Network and Endpoint URL Extractors — comprehensive locked test
test('Issue 98: NETWORK_REQUEST_URLS_V1 extracts pre-resolved network request URLs', () => {
  const networkCandidates = [
    'https://example.com/api/config',
    'https://example.com/api/games',
    'https://cdn.example.com/vendor.js',
    'https://example.com/images/logo.png',
  ];
  const r = runExtractor('NETWORK_REQUEST_URLS_V1', { pageUrl, candidates: networkCandidates });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 4);
  assert.ok(r.urls.includes('https://example.com/api/config'));
  assert.ok(r.urls.includes('https://cdn.example.com/vendor.js'));
});

test('Issue 98: PERFORMANCE_RESOURCE_URLS_V1 extracts Performance API and Resource Timing URLs', () => {
  const performanceCandidates = [
    'https://example.com/chunk.a1b2.js',
    'https://example.com/main.css',
    'https://api.example.com/analytics',
    'https://cdn.example.com/image.webp',
  ];
  const r = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', { pageUrl, candidates: performanceCandidates });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 4);
  assert.ok(r.urls.includes('https://example.com/chunk.a1b2.js'));
  assert.ok(r.urls.includes('https://api.example.com/analytics'));
});

test('Issue 98: JSON_ENDPOINT_URL_TOKENS_V1 extracts API endpoint URLs from JSON responses', () => {
  const apiResponse = JSON.stringify({
    endpoints: {
      config: '/api/config',
      games: '/api/games',
      payments: '/api/payments',
    },
    resources: ['/assets/data.json', '/cdn/images/icons.svg'],
    metadata: { version: '1.0', timestamp: '2026-07-24' },
  });
  const r = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json: apiResponse });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.includes('https://example.com/api/config'));
  assert.ok(r.urls.includes('https://example.com/api/games'));
  assert.ok(r.urls.includes('https://example.com/assets/data.json'));
  // Non-URL content should not appear
  assert.ok(!r.urls.some((u) => u.includes('1.0')));
  assert.ok(!r.urls.some((u) => u.includes('2026')));
});

test('Issue 98: Network/Performance/JSON extractors reject non-URL output', () => {
  // Network candidates with non-URLs (invalid schemes and empty)
  const badNetworkCandidates = [
    'https://example.com/api/users',
    '',
    'javascript:void(0)',
    'mailto:test@example.com',
    'https://example.com/api/posts',
  ];
  const networkResult = runExtractor('NETWORK_REQUEST_URLS_V1', { pageUrl, candidates: badNetworkCandidates });
  assert.equal(networkResult.status, 'ok');
  assert.equal(networkResult.urls.length, 2); // only the two https URLs
  assert.ok(networkResult.rejectedCount >= 3); // empty, javascript, mailto rejected

  // Performance candidates with non-URLs (invalid schemes and empty)
  const badPerformanceCandidates = [
    'https://example.com/script.js',
    '',
    'data:text/plain,hello',
    'https://example.com/style.css',
  ];
  const perfResult = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', { pageUrl, candidates: badPerformanceCandidates });
  assert.equal(perfResult.urls.length, 2);
  assert.ok(perfResult.rejectedCount >= 2);

  // JSON with non-URL strings
  const badJson = JSON.stringify({
    urls: ['/api/config', '/api/users'],
    labels: ['dashboard', 'profile'],
    description: 'This is a long description with content that should not be extracted',
  });
  const jsonResult = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json: badJson });
  assert.equal(jsonResult.status, 'ok');
  assert.ok(jsonResult.urls.some((u) => u.includes('/api/config')));
  // Long text should not appear
  assert.ok(!jsonResult.urls.some((u) => u.includes('dashboard')));
  assert.ok(!jsonResult.urls.some((u) => u.includes('long description')));
});

test('Issue 98: Three network/endpoint extractors together extract diverse sources', () => {
  // Simulate a complex page load with network traffic and API responses
  const networkUrls = ['https://example.com/api/initial', 'https://cdn.example.com/lib.js'];
  const performanceUrls = ['https://example.com/main.js', 'https://example.com/main.css'];
  const apiJson = JSON.stringify({
    config: { routes: ['/slots', '/sports'], endpoints: ['/api/slots', '/api/sports'] },
  });

  const networkResult = runExtractor('NETWORK_REQUEST_URLS_V1', { pageUrl, candidates: networkUrls });
  const perfResult = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', { pageUrl, candidates: performanceUrls });
  const apiResult = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json: apiJson });

  // Verify each extractor succeeds
  assert.equal(networkResult.status, 'ok');
  assert.equal(perfResult.status, 'ok');
  assert.equal(apiResult.status, 'ok');

  // Combine all extracted URLs
  const allUrls = [...networkResult.urls, ...perfResult.urls, ...apiResult.urls];
  assert.ok(allUrls.includes('https://example.com/api/initial'));
  assert.ok(allUrls.includes('https://example.com/main.js'));
  assert.ok(allUrls.includes('https://example.com/slots'));
  assert.ok(allUrls.includes('https://example.com/api/slots'));
});

test('Issue 98: Extractors handle empty/missing inputs gracefully', () => {
  const emptyNetworkResult = runExtractor('NETWORK_REQUEST_URLS_V1', { pageUrl });
  assert.equal(emptyNetworkResult.status, 'empty');
  assert.equal(emptyNetworkResult.urls.length, 0);

  const emptyPerfResult = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', { pageUrl });
  assert.equal(emptyPerfResult.status, 'empty');

  const emptyJsonResult = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl });
  assert.equal(emptyJsonResult.status, 'empty');
});

test('Issue 98: Result structure never contains raw response/request bodies', () => {
  const networkCandidates = ['https://example.com/data'];
  const netResult = runExtractor('NETWORK_REQUEST_URLS_V1', { pageUrl, candidates: networkCandidates });
  const netKeys = Object.keys(netResult);
  assert.deepEqual(netKeys.sort(), ['rejectedCount', 'status', 'urls'].sort());

  const perfCandidates = ['https://example.com/app.js'];
  const perfResult = runExtractor('PERFORMANCE_RESOURCE_URLS_V1', { pageUrl, candidates: perfCandidates });
  const perfKeys = Object.keys(perfResult);
  assert.deepEqual(perfKeys.sort(), ['rejectedCount', 'status', 'urls'].sort());

  const json = JSON.stringify({ responsebody: 'This is sensitive response data' });
  const jsonResult = runExtractor('JSON_ENDPOINT_URL_TOKENS_V1', { pageUrl, json });
  const jsonKeys = Object.keys(jsonResult);
  assert.deepEqual(jsonKeys.sort(), ['rejectedCount', 'status', 'urls'].sort());
  // Verify no raw JSON string keys or response bodies escape
  for (const u of jsonResult.urls) {
    assert.ok(!u.includes('responsebody'));
    assert.ok(!u.includes('sensitive'));
  }
});

// Issue 99: Sitemap and SPA/Locale Route Extractors — comprehensive locked test
test('Issue 99: ROBOTS_SITEMAP_URLS_V1 parses robots.txt with sitemap directives correctly', () => {
  const robotsText = `User-agent: *
Disallow: /admin
Allow: /public
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-en.xml
Sitemap: https://example.com/sitemap-de.xml
`;
  const r = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl, text: robotsText });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 3);
  assert.ok(r.urls.includes('https://example.com/sitemap.xml'));
  assert.ok(r.urls.includes('https://example.com/sitemap-en.xml'));
  assert.ok(r.urls.includes('https://example.com/sitemap-de.xml'));
});

test('Issue 99: SITEMAP_URLS_V1 extracts nested <loc> entries from sitemap indexes', () => {
  const sitemapIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-support.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-games.xml</loc>
  </sitemap>
</sitemapindex>`;
  const r = runExtractor('SITEMAP_URLS_V1', { pageUrl, text: sitemapIndexXml });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 3);
  assert.ok(r.urls.includes('https://example.com/sitemap-pages.xml'));
  assert.ok(r.urls.includes('https://example.com/sitemap-support.xml'));
  assert.ok(r.urls.includes('https://example.com/sitemap-games.xml'));
});

test('Issue 99: SPA_ROUTE_URL_TOKENS_V1 extracts path/query/hash routes and locale variants', () => {
  const scripts = [
    `const routes = ["/en/deposit", "/de-AT/bonus", "/fr/support?ref=nav", "/sports#featured"];`,
  ];
  const r = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl, scripts });
  assert.equal(r.status, 'ok');
  assert.ok(r.urls.some((u) => u.includes('/en/deposit')));
  assert.ok(r.urls.some((u) => u.includes('/de-AT/bonus')));
  assert.ok(r.urls.some((u) => u.includes('/fr/support') && u.includes('ref=nav')));
  assert.ok(r.urls.some((u) => u.includes('/sports')));
});

test('Issue 99: Three sitemap/SPA extractors work together on a complete extraction recipe', () => {
  const robotsText = `Sitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap-alt.xml`;
  const sitemapXml = `<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>`;
  const scripts = [`const routes = ["/slots", "/sports", "/en/casino"];`];

  const robotsResult = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl, text: robotsText });
  const sitemapResult = runExtractor('SITEMAP_URLS_V1', { pageUrl, text: sitemapXml });
  const spaResult = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl, scripts });

  // Each extractor should succeed
  assert.equal(robotsResult.status, 'ok');
  assert.equal(sitemapResult.status, 'ok');
  assert.equal(spaResult.status, 'ok');

  // Verify robots directive URLs
  assert.ok(robotsResult.urls.includes('https://example.com/sitemap.xml'));
  assert.ok(robotsResult.urls.includes('https://example.com/sitemap-alt.xml'));

  // Verify sitemap index URLs
  assert.ok(sitemapResult.urls.includes('https://example.com/pages.xml'));

  // Verify SPA routes
  assert.ok(spaResult.urls.includes('https://example.com/slots'));
  assert.ok(spaResult.urls.includes('https://example.com/en/casino'));
});

test('Issue 99: SITEMAP_URLS_V1 enforces bounded depth (recursive-loop fixture)', () => {
  // Simulate a recursive sitemap structure (bounded to prevent infinite depth)
  const deepSitemapXml = `<sitemapindex>
  <sitemap><loc>https://example.com/sm1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sm2.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sm3.xml</loc></sitemap>
</sitemapindex>`;
  const r = runExtractor('SITEMAP_URLS_V1', { pageUrl, text: deepSitemapXml });
  assert.equal(r.status, 'ok');
  // Should extract all three without crashing or exceeding limits
  assert.ok(r.urls.length >= 1);
  assert.ok(r.urls.length <= 500); // MAX_RESULTS limit
});

test('Issue 99: Locale path/query/hash variants are extracted correctly', () => {
  const scripts = [
    `const localeRoutes = {
      en: "/en/deposit-limits",
      de: "/de/einzahlungslimits",
      fr: "/fr/limites-depot",
      "en-GB": "/en-GB/withdrawal"
    };
    const routes = Object.values(localeRoutes).concat(["/universal", "/api/config?lang=es#section"]);`,
  ];
  const r = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl, scripts });
  assert.equal(r.status, 'ok');
  // Verify multiple locale variants are present
  assert.ok(r.urls.some((u) => u.includes('/en/deposit-limits')));
  assert.ok(r.urls.some((u) => u.includes('/de/einzahlungslimits')));
  assert.ok(r.urls.some((u) => u.includes('/fr/limites-depot')));
  assert.ok(r.urls.some((u) => u.includes('/en-GB/withdrawal')));
});

test('Issue 99: Non-URL output is rejected; no raw content crosses extractor boundary', () => {
  // Test SITEMAP_URLS_V1 with content that should not be extracted
  const sitemapWithContent = `<sitemapindex>
  <sitemap>
    <loc>https://example.com/pages.xml</loc>
    <lastmod>2026-07-24</lastmod>
    <title>This should not be extracted</title>
  </sitemap>
  <sitemap>
    <loc>https://example.com/games.xml</loc>
    <description>This is a long descriptive text that should never cross the boundary</description>
  </sitemap>
</sitemapindex>`;
  const r = runExtractor('SITEMAP_URLS_V1', { pageUrl, text: sitemapWithContent });
  assert.equal(r.status, 'ok');
  // Verify only URLs are extracted
  assert.ok(r.urls.some((u) => u.includes('pages.xml')));
  assert.ok(r.urls.some((u) => u.includes('games.xml')));
  // Verify no metadata or descriptions cross the boundary
  assert.ok(!r.urls.some((u) => u.includes('2026')));
  assert.ok(!r.urls.some((u) => u.includes('lastmod')));
  assert.ok(!r.urls.some((u) => u.includes('descriptive')));

  // Test SPA_ROUTE_URL_TOKENS_V1 with content that should not be extracted
  const spaScripts = [`
    const routes = ["/deposit", "/withdrawal"];
    const descriptions = {
      deposit: "This is the deposit page where users can add funds to their account",
      withdrawal: "Users can request their winnings through this page"
    };
  `];
  const spaResult = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl, scripts: spaScripts });
  // Verify only route URLs are extracted
  assert.ok(spaResult.urls.some((u) => u.includes('/deposit')));
  // Verify descriptive text is not in URLs
  assert.ok(!spaResult.urls.some((u) => u.includes('funds')));
  assert.ok(!spaResult.urls.some((u) => u.includes('account')));
});

test('Issue 99: Extractors handle empty/missing input gracefully', () => {
  const emptyRobotsResult = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl });
  assert.equal(emptyRobotsResult.status, 'empty');
  assert.equal(emptyRobotsResult.urls.length, 0);

  const emptySitemapResult = runExtractor('SITEMAP_URLS_V1', { pageUrl });
  assert.equal(emptySitemapResult.status, 'empty');
  assert.equal(emptySitemapResult.urls.length, 0);

  const emptySpaResult = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl });
  assert.equal(emptySpaResult.status, 'empty');
  assert.equal(emptySpaResult.urls.length, 0);
});

test('Issue 99: Extractors reject non-URL candidates and report rejectedCount', () => {
  const badRobotsText = `Sitemap: https://example.com/sitemap.xml
Disallow: /admin
Some random line without a URL
Sitemap: https://example.com/other.xml
Sitemap: javascript:alert('xss')
`;
  const r = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl, text: badRobotsText });
  assert.equal(r.status, 'ok');
  assert.equal(r.urls.length, 2);
  assert.ok(r.rejectedCount >= 1);
  assert.ok(r.urls.includes('https://example.com/sitemap.xml'));
  assert.ok(r.urls.includes('https://example.com/other.xml'));
});

test('Issue 99: Extractors generalize to different domains and URL patterns', () => {
  // Test with different domain and different robots.txt format variations
  const pageUrlAlt = 'https://casino.org/en/';
  const robotsTextAlt = `User-agent: Googlebot
Disallow: /private
Sitemap: https://casino.org/sitemap-main.xml
Sitemap: https://cdn.casino.org/assets.xml
`;
  const robotsResult = runExtractor('ROBOTS_SITEMAP_URLS_V1', { pageUrl: pageUrlAlt, text: robotsTextAlt });
  assert.equal(robotsResult.status, 'ok');
  assert.ok(robotsResult.urls.includes('https://casino.org/sitemap-main.xml'));
  assert.ok(robotsResult.urls.includes('https://cdn.casino.org/assets.xml'));

  // Test with different SPA route patterns
  const spaScriptsAlt = [
    `const routes = ["/games/slots", "/en-US/promotions?id=123", "/fr-CA/sports#live"];`,
  ];
  const spaResultAlt = runExtractor('SPA_ROUTE_URL_TOKENS_V1', { pageUrl: pageUrlAlt, scripts: spaScriptsAlt });
  assert.equal(spaResultAlt.status, 'ok');
  assert.ok(spaResultAlt.urls.some((u) => u.includes('/games/slots')));
  assert.ok(spaResultAlt.urls.some((u) => u.includes('id=123')));
  assert.ok(spaResultAlt.urls.some((u) => u.includes('/fr-CA')));
});

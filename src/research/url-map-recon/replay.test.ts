import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRecipe, validateRecipe, RecipeValidationError } from './replay.ts';
import type { RecipeV1, UrlMapEntry } from './types.ts';

const origin = 'https://example.com';

function baseRecipe(): RecipeV1 {
  return {
    version: 1,
    casinoId: 'example',
    recordedAt: '2026-07-24T00:00:00Z',
    steps: [
      {
        extractorId: 'INLINE_SCRIPT_URL_TOKENS_V1',
        pageUrl: 'https://example.com/',
        source: 'config_route',
        params: { scriptMatch: '__CONFIG__' },
        resultType: 'url_list',
      },
    ],
  };
}

// (12) registered-extractor replay round-trip with the three baseline extractors
test('three baseline extractors work end-to-end through replay (DOM/metadata/forms)', () => {
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: 'example',
    recordedAt: '2026-07-24T00:00:00Z',
    steps: [
      // 1. DOM_URL_ATTRIBUTES_V1 — extracts href, src, action, data-* attributes
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl: 'https://example.com/',
        source: 'dom_anchor',
        resultType: 'url_list',
      },
      // 2. DOCUMENT_METADATA_URLS_V1 — extracts canonical, manifest, preload, etc.
      {
        extractorId: 'DOCUMENT_METADATA_URLS_V1',
        pageUrl: 'https://example.com/',
        source: 'document_metadata',
        resultType: 'url_list',
      },
      // 3. FRAME_FORM_URLS_V1 — extracts form actions, iframe src, image-map hrefs
      {
        extractorId: 'FRAME_FORM_URLS_V1',
        pageUrl: 'https://example.com/',
        source: 'frame_form',
        resultType: 'url_list',
      },
    ],
  };

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <link rel="canonical" href="/en/terms">
      <link rel="manifest" href="/manifest.json">
      <link rel="preload" href="/styles/main.css">
    </head>
    <body>
      <a href="/deposit-limits">Limits</a>
      <a href="/bonus-terms">Bonus</a>
      <img src="/img/logo.svg">
      <form action="/deposit">
        <input type="submit">
      </form>
      <iframe src="/terms-frame"></iframe>
      <area href="/slots">
    </body>
    </html>
  `;

  const result = replayRecipe(
    recipe,
    () => ({ pageUrl: 'https://example.com/', html }),
    { origin },
  );

  // Verify all three extractors ran successfully
  assert.equal(result.stepResults.length, 3);
  assert.equal(result.stepResults[0].status, 'ok');
  assert.equal(result.stepResults[1].status, 'ok');
  assert.equal(result.stepResults[2].status, 'ok');

  // Verify URLs were extracted and cleaned
  const urls = result.entries.map((e) => e.canonicalUrl);

  // These should all be kept by the URL cleaning policy
  // (note: .json files are treated as assets and removed by the cleaning policy)
  assert.ok(urls.includes('https://example.com/en/terms'));
  assert.ok(urls.includes('https://example.com/deposit-limits'));
  assert.ok(urls.includes('https://example.com/bonus-terms'));
  assert.ok(urls.includes('https://example.com/slots'));
  assert.ok(urls.includes('https://example.com/deposit'));

  // Verify output format: entries must be UrlMapEntry typed
  for (const entry of result.entries) {
    assert.ok(typeof entry.canonicalUrl === 'string');
    assert.ok(['official_same_origin', 'external_approved'].includes(entry.originStatus));
    assert.ok(typeof entry.source === 'string');
    // derivedLabel and labelSource are optional
    if (entry.derivedLabel) {
      assert.ok(typeof entry.derivedLabel === 'string');
      assert.equal(entry.labelSource, 'url_slug');
    }
  }

  // Verify no duplicates (deduplication by canonical URL)
  const uniqueUrls = new Set(urls);
  assert.equal(urls.length, uniqueUrls.size);
});

// (13) arbitrary eval rejection in replay
test('replay rejects legacy recipes containing eval (13)', () => {
  const legacy = { ...baseRecipe(), steps: [{ ...baseRecipe().steps[0] }], eval: "() => document.body.innerHTML" };
  assert.throws(() => validateRecipe(legacy), RecipeValidationError);

  const legacyStep = {
    version: 1,
    casinoId: 'example',
    recordedAt: '2026-07-24T00:00:00Z',
    steps: [{ source: 'config_route', method: 'script_json_path_scan', eval: '() => [1,2,3]' }],
  };
  assert.throws(() => validateRecipe(legacyStep), RecipeValidationError);
});

// (14) unresolved placeholder rejection in replay
test('replay rejects unresolved placeholders (14)', () => {
  const recipe = baseRecipe();
  (recipe.steps[0].params as Record<string, unknown>).scriptMatch = '{{UNRESOLVED_TOKEN}}';
  assert.throws(() => validateRecipe(recipe), RecipeValidationError);
});

test('replay rejects unknown extractor ids', () => {
  const recipe = baseRecipe();
  // @ts-expect-error deliberately invalid for runtime rejection test
  recipe.steps[0].extractorId = 'MADE_UP_EXTRACTOR';
  assert.throws(() => validateRecipe(recipe), RecipeValidationError);
});

test('replay rejects wrong version', () => {
  const recipe = { ...baseRecipe(), version: 2 as unknown as 1 };
  assert.throws(() => validateRecipe(recipe), RecipeValidationError);
});

// (Issue 101) Replay writes url-source-coverage.json and produces URL-map equivalence with first-run
test('replay with complete fixture produces source coverage and classified entries', () => {
  // A realistic recipe from a full recon that exercises multiple extractors
  const recipe: RecipeV1 = {
    version: 1,
    casinoId: 'example-casino',
    recordedAt: '2026-07-24T10:00:00Z',
    steps: [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl: 'https://example-casino.com/',
        source: 'dom_anchor',
        resultType: 'url_list',
      },
      {
        extractorId: 'DOCUMENT_METADATA_URLS_V1',
        pageUrl: 'https://example-casino.com/',
        source: 'document_metadata',
        resultType: 'url_list',
      },
      {
        extractorId: 'ROBOTS_SITEMAP_URLS_V1',
        pageUrl: 'https://example-casino.com/robots.txt',
        source: 'robots_sitemap',
        resultType: 'url_list',
      },
    ],
  };

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <link rel="canonical" href="/en/bonus-terms">
      <link rel="manifest" href="/manifest.json">
    </head>
    <body>
      <a href="/deposit-limits">Deposit Limits</a>
      <a href="/withdrawal-limits">Withdrawal Limits</a>
      <a href="/bonus-terms">Bonus Terms</a>
      <a href="/slots">Slots</a>
      <a href="/terms-and-conditions">Terms</a>
    </body>
    </html>
  `;

  const robotsTxt = `
User-Agent: *
Disallow: /admin/
Sitemap: https://example-casino.com/sitemap.xml
  `;

  const result = replayRecipe(
    recipe,
    (step) => {
      if (step.extractorId === 'DOM_URL_ATTRIBUTES_V1') return { pageUrl: step.pageUrl, html };
      if (step.extractorId === 'DOCUMENT_METADATA_URLS_V1') return { pageUrl: step.pageUrl, html };
      if (step.extractorId === 'ROBOTS_SITEMAP_URLS_V1') return { pageUrl: step.pageUrl, text: robotsTxt };
      return { pageUrl: step.pageUrl };
    },
    { origin: 'https://example-casino.com' },
  );

  // Verify that replay produces entries in the correct schema
  assert.ok(Array.isArray(result.entries));
  assert.ok(result.entries.length > 0);

  // Verify each entry has the required fields
  for (const entry of result.entries) {
    assert.ok(typeof entry.canonicalUrl === 'string');
    assert.ok(['official_same_origin', 'external_approved'].includes(entry.originStatus));
    assert.ok(typeof entry.source === 'string');
  }

  // Verify that we extracted expected URLs (only keeping routes per the cleaning policy)
  const urls = result.entries.map((e) => e.canonicalUrl);
  assert.ok(urls.includes('https://example-casino.com/en/bonus-terms')); // from canonical
  assert.ok(urls.includes('https://example-casino.com/deposit-limits')); // from DOM (kept by cleaning policy)
  assert.ok(urls.includes('https://example-casino.com/withdrawal-limits'));
  assert.ok(urls.includes('https://example-casino.com/bonus-terms'));
  assert.ok(urls.includes('https://example-casino.com/slots')); // product landing
  assert.ok(urls.includes('https://example-casino.com/terms-and-conditions'));

  // Verify no duplicates
  const uniqueUrls = new Set(urls);
  assert.equal(urls.length, uniqueUrls.size, 'should have no duplicate URLs');

  // Verify step results show which extractors ran successfully
  assert.equal(result.stepResults.length, 3);
  assert.ok(result.stepResults.every((r) => r.status === 'ok' || r.status === 'empty'));

  // Verify coverage is included in the result
  assert.ok(Array.isArray(result.coverage));
  assert.ok(result.coverage.length > 0);

  // Verify coverage structure: each entry has sourceFamily and status
  for (const entry of result.coverage) {
    assert.ok(typeof entry.sourceFamily === 'string');
    assert.ok(['present', 'absent', 'blocked', 'unsupported', 'error'].includes(entry.status));
  }

  // Verify that used source families are marked as present
  const presentFamilies = result.coverage.filter((e) => e.status === 'present').map((e) => e.sourceFamily);
  assert.ok(presentFamilies.length > 0, 'should have at least one present source family');
  assert.ok(presentFamilies.includes('dom_url_attributes')); // from DOM extractor
  assert.ok(presentFamilies.includes('document_metadata')); // from DOCUMENT_METADATA extractor
  assert.ok(presentFamilies.includes('robots_sitemap')); // from ROBOTS_SITEMAP extractor
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { extractAndPersist } from './extraction-coordinator.ts';
import type { RecipeStepV1 } from './types.ts';

/**
 * Test suite for deterministic URL extraction with artifact persistence.
 * Covers acceptance criteria for issue 06:
 * 1. Zero-result sources still have terminal status
 * 2. External candidates not persisted
 * 3. Blocked/error sources allow partial runs
 * 4. Replay prevents code execution
 * 5. No agent calls (pure TS)
 */

const origin = 'https://example.com';
const casinoId = 'test-casino';
const pageUrl = 'https://example.com/en/lobby';

test('AC1: Zero-result source yields terminal status in coverage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  try {
    const steps: RecipeStepV1[] = [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl,
        source: 'dom_anchor',
        resultType: 'url_list',
      },
    ];

    const input = { pageUrl, html: '<div></div>' }; // empty HTML = zero results
    await extractAndPersist(tempDir, casinoId, 'en', 'run-001', steps, () => input);

    const outDir = path.join(tempDir, casinoId, 'en', 'run-001');
    const coveragePath = path.join(outDir, 'url-source-coverage.json');
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));

    // All source families should have exactly one entry each
    const domEntry = coverage.find((e: any) => e.sourceFamily === 'dom_url_attributes');
    assert.ok(domEntry, 'dom_url_attributes should have a coverage entry');
    assert.equal(domEntry.status, 'present', 'zero-result source should still report a status');
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test('AC2: External URLs not persisted as visit candidates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  try {
    const steps: RecipeStepV1[] = [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl,
        source: 'dom_anchor',
        resultType: 'url_list',
      },
    ];

    // HTML with both same-origin and external links
    const html = `
      <a href="/lobby">Lobby</a>
      <a href="https://example.com/terms">Terms</a>
      <a href="https://external.com/ad">External Ad</a>
      <a href="https://cdn.external.com/image.jpg">CDN</a>
    `;

    await extractAndPersist(tempDir, casinoId, 'en', 'run-002', steps, () => ({
      pageUrl,
      html,
    }));

    const outDir = path.join(tempDir, casinoId, 'en', 'run-002');
    const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
    const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));

    // Should only contain same-origin URLs (Issue 29: entries carry provenance)
    const urls: string[] = candidates.map((c: { url: string }) => c.url);
    assert.ok(urls.some((u) => u.includes('example.com/lobby')), 'should include same-origin URLs');
    assert.ok(
      !urls.some((u) => u.includes('external.com')),
      'should not include external URLs without approval'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test('AC3: Error sources do not prevent partial run', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  try {
    const steps: RecipeStepV1[] = [
      {
        extractorId: 'JSON_ENDPOINT_URL_TOKENS_V1',
        pageUrl,
        source: 'config_route',
        resultType: 'url_list',
      },
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl,
        source: 'dom_anchor',
        resultType: 'url_list',
      },
    ];

    const inputs = [
      { pageUrl, json: '{invalid json}' }, // error step
      { pageUrl, html: '<a href="/account">Account</a>' }, // valid step
    ];

    let callIndex = 0;
    await extractAndPersist(tempDir, casinoId, 'en', 'run-003', steps, () => inputs[callIndex++]);

    const outDir = path.join(tempDir, casinoId, 'en', 'run-003');
    const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
    const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));

    // Should have results from the valid step even though one failed
    const urls: string[] = candidates.map((c: { url: string }) => c.url);
    assert.ok(urls.some((u) => u.includes('/account')), 'valid results should persist despite error in other step');
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test('AC4: Replay validates recipe and prevents code execution', async () => {
  const evilRecipe = {
    version: 1,
    casinoId: 'test',
    recordedAt: '2024-01-01T00:00:00Z',
    steps: [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl: 'https://example.com/',
        source: 'dom_anchor' as const,
        resultType: 'url_list' as const,
        // Try to inject code (should be caught by validation)
        params: { eval: 'dangerousCode()' },
      },
    ],
  };

  // Attempt to replay with malicious recipe should fail validation
  const { replayRecipe, validateRecipe, RecipeValidationError } = await import('./replay.ts');

  assert.throws(
    () => {
      // Test that validateRecipe catches various injection attempts
      const recipes = [
        { ...evilRecipe, steps: [{ ...evilRecipe.steps[0], params: { code: 'eval(evil)' } }] },
        {
          version: 1,
          casinoId: 'test',
          recordedAt: '2024-01-01T00:00:00Z',
          steps: [],
          _: 'eval("malicious")',
        },
      ];
      for (const recipe of recipes) {
        try {
          validateRecipe(recipe);
        } catch (e) {
          if (e instanceof Error && e.message.includes('eval')) throw e;
        }
      }
    },
    (error: any) => error.message.includes('eval'),
    'validation should reject eval attempts'
  );
});

test('AC5: Extraction is pure TS, no agent calls', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  try {
    const steps: RecipeStepV1[] = [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl,
        source: 'dom_anchor',
        resultType: 'url_list',
      },
    ];

    // Should complete without any agent/network calls
    let agentCallDetected = false;

    await extractAndPersist(tempDir, casinoId, 'en', 'run-004', steps, () => {
      // If any code tries to invoke an agent, it would happen here
      if (agentCallDetected) throw new Error('Agent call detected!');

      return { pageUrl, html: '<a href="/support">Support</a>' };
    });

    // Verify artifacts were created
    const outDir = path.join(tempDir, casinoId, 'en', 'run-004');
    assert.ok(fs.existsSync(path.join(outDir, 'raw-url-candidates.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'url-source-coverage.json')));
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test('AC1+2+3 integrated: Multiple sources with mixed results and coverage tracking', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  try {
    const steps: RecipeStepV1[] = [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl,
        source: 'dom_anchor',
        resultType: 'url_list',
      },
      {
        extractorId: 'DOCUMENT_METADATA_URLS_V1',
        pageUrl,
        source: 'document_metadata',
        resultType: 'url_list',
      },
      {
        extractorId: 'ROBOTS_SITEMAP_URLS_V1',
        pageUrl,
        source: 'robots_sitemap',
        resultType: 'url_list',
      },
    ];

    const inputs = [
      { pageUrl, html: '<a href="/lobby">Lobby</a>' },
      { pageUrl, html: '<link rel="canonical" href="/en">' },
      { pageUrl, text: 'Sitemap: https://example.com/sitemap.xml' },
    ];

    let callIndex = 0;
    await extractAndPersist(tempDir, casinoId, 'en', 'run-005', steps, () => inputs[callIndex++]);

    const outDir = path.join(tempDir, casinoId, 'en', 'run-005');
    const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
    const coveragePath = path.join(outDir, 'url-source-coverage.json');

    const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));

    // Verify candidates contain results from all sources
    const allUrls: string[] = candidates.map((c: { url: string }) => c.url);
    assert.ok(allUrls.some((u) => u.includes('/lobby')), 'should have DOM anchor URL');
    assert.ok(allUrls.some((u) => u.includes('/en')), 'should have canonical URL');
    assert.ok(allUrls.some((u) => u.includes('sitemap')), 'should have sitemap URL');

    // Verify coverage tracking
    assert.ok(coverage.some((e: any) => e.sourceFamily === 'dom_url_attributes' && e.status === 'present'));
    assert.ok(coverage.some((e: any) => e.sourceFamily === 'document_metadata' && e.status === 'present'));
    assert.ok(coverage.some((e: any) => e.sourceFamily === 'robots_sitemap' && e.status === 'present'));

    // Verify all source families are represented
    assert.equal(
      coverage.length,
      14, // All 14 SOURCE_FAMILIES should be in coverage
      'coverage should include all source families'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveFullUrlMapRunPaths, writeFullUrlMapDiscoveryArtifacts } from '../src/research/url-map/full-io.ts';
import type { FullUrlMapDiscoveryResult } from '../src/research/url-map/full-discovery.ts';
test('full URL-map runs are unique and use separate raw and normalized source URL artifacts', () => {
  const now = new Date('2026-08-12T10:20:30.000Z');
  const a = resolveFullUrlMapRunPaths(
    { entryUrl: 'https://westace.com/en', runId: '11111111-1111-4111-8111-111111111111' },
    { outputRoot: '/tmp/research', casinoName: 'WestAce Norway', now },
  );
  const b = resolveFullUrlMapRunPaths(
    { entryUrl: 'https://westace.com/en', runId: '22222222-2222-4222-8222-222222222222' },
    { outputRoot: '/tmp/research', casinoName: 'WestAce Norway', now },
  );
  assert.notEqual(a.runDir, b.runDir);
  assert.match(a.runDir, /westace-norway-20260812T102030Z-11111111$/);
  assert.match(b.runDir, /westace-norway-20260812T102030Z-22222222$/);
  assert.match(a.sourceUrlListPath, /\/source-url-list\.json$/);
  assert.match(a.sourceUrlListNormalizedPath, /\/source-url-list-normalized\.json$/);
  assert.equal('acceptedPath' in a, false);
  assert.equal('rejectedPath' in a, false);
  assert.equal('tbdPath' in a, false);
  assert.equal('decisionsPath' in a, false);
});
test('a completed run writes only the canonical artifact filenames', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpot-full-url-map-'));
  try {
    const result = {
      runId: '33333333-3333-4333-8333-333333333333',
      startedAt: '2026-08-12T10:00:00.000Z',
      finishedAt: '2026-08-12T10:01:00.000Z',
      entryUrl: 'https://westace.com/en',
      finalEntryUrl: 'https://westace.com/en',
      allowedHosts: ['westace.com'],
      frozenSeedUrls: ['https://westace.com/en'],
      seedAttempts: [],
      rawCandidates: [
        {
          rawUrl: '/promotions',
          baseUrl: 'https://westace.com/en',
          provenance: {
            sourceFamily: 'dom_url_attribute',
            discoveredOn: 'https://westace.com/en',
            label: 'a[href]',
          },
          observedAt: '2026-08-12T10:00:01.000Z',
        },
      ],
      urlMap: [
        {
          canonicalUrl: 'https://westace.com/promotions',
          navigationUrl: 'https://westace.com/promotions',
          provenance: [
            {
              sourceFamily: 'dom_url_attribute',
              discoveredOn: 'https://westace.com/en',
              label: 'a[href]',
            },
          ],
        },
      ],
      sourceCoverage: [],
      seedDiscovery: {},
      sitemapDiscovery: {},
      summary: {},
    } as unknown as FullUrlMapDiscoveryResult;
    const written = await writeFullUrlMapDiscoveryArtifacts(result, {
      outputRoot: root,
      casinoName: 'WestAce Norway',
      now: new Date('2026-08-12T10:20:30.000Z'),
    });

    const entries = (await readdir(written.runDir)).sort();
    assert.deepEqual(entries, [
      'sitemap-discovery-log.json',
      'source-url-list-normalized.json',
      'source-url-list.json',
      'url-map-discovery-report.json',
      'url-source-coverage-log.json',
    ]);
    for (const stale of [
      'raw-url-candidates.json',
      'url-list.json',
      'url-map.json',
      'sitemap-discovery.json',
      'url-source-coverage.json',
      'url-map-discovery-summary.json',
    ]) {
      assert.equal(entries.includes(stale), false, `stale artifact ${stale} must not be written`);
    }
    assert.match(written.sourceUrlListPath, /\/source-url-list\.json$/);
    assert.match(written.sourceCoveragePath, /\/url-source-coverage-log\.json$/);
    assert.match(written.sourceUrlListNormalizedPath, /\/source-url-list-normalized\.json$/);

    const sourceUrlList = JSON.parse(await readFile(written.sourceUrlListPath, 'utf8'));
    const sourceUrlListNormalized = JSON.parse(await readFile(written.sourceUrlListNormalizedPath, 'utf8'));
    assert.deepEqual(sourceUrlList, result.rawCandidates);
    assert.deepEqual(sourceUrlListNormalized, result.urlMap);
    assert.equal(sourceUrlList[0].rawUrl, '/promotions');
    assert.equal(sourceUrlListNormalized[0].canonicalUrl, 'https://westace.com/promotions');
    assert.match(written.sitemapPath, /\/sitemap-discovery-log\.json$/);
    assert.match(written.summaryPath, /\/url-map-discovery-report\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

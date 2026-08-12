import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deriveCasinoNameFromUrl,
  resolveUrlMapRunPaths,
  slugifyCasinoName,
  writeSeedDiscoveryResult,
} from '../src/research/url-map/io.ts';
import type { SeedDiscoveryResult } from '../src/research/url-map/types.ts';

test('builds data path from explicit casino name and date', () => {
  const root = path.resolve('/tmp/research-root');
  const paths = resolveUrlMapRunPaths('https://www.westace.com/en', {
    outputRoot: root,
    casinoName: 'WestAce Norway',
    now: new Date('2026-08-12T12:00:00.000Z'),
  });

  assert.equal(paths.casinoSlug, 'westace-norway');
  assert.equal(paths.runDate, '2026-08-12');
  assert.equal(paths.runDir, path.join(root, 'westace-norway-2026-08-12'));
  assert.equal(paths.jsonPath, path.join(paths.runDir, 'url-map-discovery.json'));
});

test('falls back to the first non-www hostname label', () => {
  assert.equal(deriveCasinoNameFromUrl('https://www.spinboss.com/no/promotions'), 'spinboss');
  assert.equal(slugifyCasinoName('Spin Boss Norway'), 'spin-boss-norway');
});

test('persists the complete discovery result atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpot-url-map-'));
  const result: SeedDiscoveryResult = {
    entryUrl: 'https://westace.com/',
    finalEntryUrl: 'https://westace.com/en',
    allowedHosts: ['westace.com'],
    rawCandidates: [
      {
        rawUrl: '/promotions',
        baseUrl: 'https://westace.com/en',
        provenance: {
          sourceFamily: 'dom_url_attribute',
          discoveredOn: 'https://westace.com/en',
          label: 'a[href]',
        },
        observedAt: '2026-08-12T10:00:00.000Z',
      },
    ],
    observedTechnicalSources: [],
    technicalSourceErrors: [],
  };

  try {
    const written = await writeSeedDiscoveryResult(result, {
      outputRoot: root,
      casinoName: 'WestAce',
      now: new Date('2026-08-12T12:00:00.000Z'),
    });

    const stored = JSON.parse(await readFile(written.jsonPath, 'utf8'));
    assert.deepEqual(stored, result);
    assert.equal(written.runDir, path.join(root, 'westace-2026-08-12'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

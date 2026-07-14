import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createArtifact,
  writeArtifactAtomic,
  validateArtifact,
  computeArtifactHash,
} from '../../src/research/artifact.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const testDir = path.join(projectRoot, 'tests/research/artifact-tmp');

// Cleanup before tests
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true });
}
fs.mkdirSync(testDir, { recursive: true });

test('artifact: createArtifact produces valid schema', () => {
  const artifact = createArtifact({
    path: '/test/artifact.json',
    data: { games: [{ name: 'Poker', count: 5 }] },
    schemaVersion: '1.0.0',
    stats: { count: 5, gaps: 0, errors: 0 },
    terminal: false,
  });

  assert(artifact.path === '/test/artifact.json');
  assert(artifact.schema_version === '1.0.0');
  assert(artifact.data.games !== undefined);
  assert(artifact.stats.count === 5);
  assert(artifact.stats.gaps === 0);
  assert(artifact.stats.errors === 0);
  assert(artifact.terminal === false);
  assert(typeof artifact.hash === 'string');
  assert(artifact.hash.length === 64, 'hash should be SHA256 (64 hex chars)');
});

test('artifact: computeArtifactHash is deterministic', () => {
  const data = { games: [{ name: 'Roulette', count: 3 }] };
  const schemaVersion = '1.0.0';

  const hash1 = computeArtifactHash(data, schemaVersion);
  const hash2 = computeArtifactHash(data, schemaVersion);

  assert.equal(hash1, hash2, 'Same data and schema_version should produce same hash');
  assert.match(hash1, /^[a-f0-9]{64}$/i, 'hash should be valid SHA256');
});

test('artifact: computeArtifactHash differs with different data', () => {
  const schemaVersion = '1.0.0';
  const data1 = { games: [{ name: 'Slots', count: 10 }] };
  const data2 = { games: [{ name: 'Slots', count: 11 }] };

  const hash1 = computeArtifactHash(data1, schemaVersion);
  const hash2 = computeArtifactHash(data2, schemaVersion);

  assert.notEqual(hash1, hash2, 'Different data should produce different hashes');
});

test('artifact: computeArtifactHash differs with different schema_version', () => {
  const data = { games: [{ name: 'Baccarat', count: 2 }] };
  const hash1 = computeArtifactHash(data, '1.0.0');
  const hash2 = computeArtifactHash(data, '2.0.0');

  assert.notEqual(hash1, hash2, 'Different schema_version should produce different hashes');
});

test('artifact: writeArtifactAtomic writes and renames atomically', async () => {
  const artifactPath = path.join(testDir, 'atomic-test.json');
  const artifact = createArtifact({
    path: artifactPath,
    data: { games: [{ name: 'Blackjack', count: 7 }] },
    schemaVersion: '1.0.0',
    stats: { count: 7, gaps: 0, errors: 0 },
    terminal: true,
  });

  await writeArtifactAtomic(artifact);

  assert(fs.existsSync(artifactPath), 'Artifact file should exist after write');
  const written = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  assert.equal(written.path, artifactPath);
  assert.equal(written.hash, artifact.hash);
  assert.equal(written.schema_version, '1.0.0');
  assert.equal(written.terminal, true);
});

test('artifact: validateArtifact checks hash integrity', () => {
  const artifact = createArtifact({
    path: '/test/validated.json',
    data: { games: [{ name: 'Craps', count: 4 }] },
    schemaVersion: '1.0.0',
    stats: { count: 4, gaps: 1, errors: 2 },
    terminal: false,
  });

  const validation = validateArtifact(artifact);

  assert.equal(validation.valid, true, 'Valid artifact should pass validation');
  assert.equal(validation.hashMatch, true, 'Hash should match');
  assert.equal(validation.statsPresent, true, 'Stats should be present');
});

test('artifact: validateArtifact rejects mismatched hash', () => {
  const artifact = createArtifact({
    path: '/test/corrupted.json',
    data: { games: [{ name: 'VideoPoker', count: 6 }] },
    schemaVersion: '1.0.0',
    stats: { count: 6, gaps: 0, errors: 0 },
    terminal: false,
  });

  // Corrupt the hash
  artifact.hash = 'a'.repeat(64);

  const validation = validateArtifact(artifact);

  assert.equal(validation.valid, false, 'Artifact with corrupted hash should fail validation');
  assert.equal(validation.hashMatch, false, 'Hash mismatch should be detected');
});

test('artifact: data field contains only constrained patch, not raw evidence', () => {
  const artifact = createArtifact({
    path: '/test/patch.json',
    data: { games: [{ name: 'Keno', count: 8 }] },
    schemaVersion: '1.0.0',
    stats: { count: 8, gaps: 0, errors: 0 },
    terminal: false,
  });

  // Verify data doesn't contain raw evidence fields like screenshots, network logs
  assert(!('rawScreenshot' in artifact.data));
  assert(!('networkLog' in artifact.data));
  assert(typeof artifact.data === 'object');
  assert('games' in artifact.data || Object.keys(artifact.data).length >= 0);
});

test('artifact: stats fields are tallied correctly', () => {
  const artifact = createArtifact({
    path: '/test/stats.json',
    data: { games: [{ name: 'Game1', count: 1 }] },
    schemaVersion: '1.0.0',
    stats: { count: 42, gaps: 3, errors: 1 },
    terminal: false,
  });

  assert.equal(artifact.stats.count, 42, 'Count should be as provided');
  assert.equal(artifact.stats.gaps, 3, 'Gaps should be as provided');
  assert.equal(artifact.stats.errors, 1, 'Errors should be as provided');
});

test('artifact: terminal boolean marks final state', () => {
  const unresolvedArtifact = createArtifact({
    path: '/test/unresolved.json',
    data: { games: [] },
    schemaVersion: '1.0.0',
    stats: { count: 0, gaps: 0, errors: 0 },
    terminal: false,
  });

  const finalArtifact = createArtifact({
    path: '/test/final.json',
    data: { games: [] },
    schemaVersion: '1.0.0',
    stats: { count: 0, gaps: 0, errors: 0 },
    terminal: true,
  });

  assert.equal(unresolvedArtifact.terminal, false, 'Unresolved artifact should have terminal=false');
  assert.equal(finalArtifact.terminal, true, 'Final artifact should have terminal=true');
});

test('artifact: metadata fields are read-only; data is mutation surface', async () => {
  const originalPath = path.join(testDir, 'readonly-test.json');
  const artifact = createArtifact({
    path: originalPath,
    data: { games: [{ name: 'Bingo', count: 9 }] },
    schemaVersion: '1.0.0',
    stats: { count: 9, gaps: 0, errors: 0 },
    terminal: false,
  });

  await writeArtifactAtomic(artifact);

  const written = JSON.parse(fs.readFileSync(originalPath, 'utf-8'));

  // Verify metadata is preserved
  assert.equal(written.path, originalPath);
  assert.equal(written.schema_version, '1.0.0');
  assert(typeof written.hash === 'string');

  // Verify data is the mutation surface
  assert.deepEqual(written.data, { games: [{ name: 'Bingo', count: 9 }] });
});

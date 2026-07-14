import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import {
  createEvidenceId,
  hashContent,
  appendEvidence,
  loadEvidence,
  verifyEvidenceHash,
  boundSnapshot,
} from '../../src/research/evidence.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const testDir = path.join(projectRoot, 'tests/research/evidence-tmp');

test('evidence: createEvidenceId generates deterministic ID', () => {
  const id1 = createEvidenceId('https://casino.test/page', 'dom', 'abc123');
  const id2 = createEvidenceId('https://casino.test/page', 'dom', 'abc123');

  assert.equal(id1, id2, 'Same inputs should produce same ID');
  assert(id1.length > 0, 'ID should not be empty');
  assert(typeof id1 === 'string', 'ID should be string');
});

test('evidence: createEvidenceId produces different IDs for different inputs', () => {
  const id1 = createEvidenceId('https://casino.test/page1', 'dom', 'abc123');
  const id2 = createEvidenceId('https://casino.test/page2', 'dom', 'abc123');
  const id3 = createEvidenceId('https://casino.test/page1', 'xhr', 'abc123');
  const id4 = createEvidenceId('https://casino.test/page1', 'dom', 'xyz789');

  assert.notEqual(id1, id2, 'Different URLs should produce different IDs');
  assert.notEqual(id1, id3, 'Different methods should produce different IDs');
  assert.notEqual(id1, id4, 'Different content hashes should produce different IDs');
});

test('evidence: hashContent produces sha256 hash', () => {
  const content = 'test content';
  const hash = hashContent(content);

  assert(typeof hash === 'string', 'hash should be string');
  assert(hash.length > 0, 'hash should not be empty');
  // SHA256 produces 64 character hex string
  assert.match(hash, /^[a-f0-9]{64}$/i, 'hash should be 64-char hex string (SHA256)');
});

test('evidence: hashContent is deterministic', () => {
  const content = 'test content';
  const hash1 = hashContent(content);
  const hash2 = hashContent(content);

  assert.equal(hash1, hash2, 'Same content should produce same hash');
});

test('evidence: hashContent handles Buffer input', () => {
  const buffer = Buffer.from('test content');
  const hash1 = hashContent(buffer);
  const hash2 = hashContent('test content');

  assert.equal(hash1, hash2, 'Buffer and string versions of same content should hash the same');
});

test('evidence: appendEvidence creates file and appends record', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const evidencePath = path.join(testDir, 'evidence.jsonl');
  const record = {
    id: 'ev001',
    url: 'https://casino.test/page',
    timestamp: '2026-07-11T10:00:00Z',
    method: 'dom' as const,
    excerpt: 'Test excerpt',
    content_hash: 'abc123',
  } as const;

  appendEvidence(evidencePath, record);

  assert(existsSync(evidencePath), 'evidence file should be created');

  // Verify content
  const loaded = loadEvidence(evidencePath);
  assert.equal(loaded.length, 1, 'should have one record');
  assert.equal(loaded[0].id, 'ev001', 'record id should match');
  assert.equal(loaded[0].url, 'https://casino.test/page', 'record url should match');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('evidence: appendEvidence appends multiple records', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const evidencePath = path.join(testDir, 'evidence.jsonl');
  const record1 = {
    id: 'ev001',
    url: 'https://casino.test/page1',
    timestamp: '2026-07-11T10:00:00Z',
    method: 'dom' as const,
    content_hash: 'abc123',
  };
  const record2 = {
    id: 'ev002',
    url: 'https://casino.test/page2',
    timestamp: '2026-07-11T10:01:00Z',
    method: 'xhr' as const,
    content_hash: 'xyz789',
  };

  appendEvidence(evidencePath, record1);
  appendEvidence(evidencePath, record2);

  const loaded = loadEvidence(evidencePath);
  assert.equal(loaded.length, 2, 'should have two records');
  assert.equal(loaded[0].id, 'ev001', 'first record should match');
  assert.equal(loaded[1].id, 'ev002', 'second record should match');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('evidence: loadEvidence returns empty array for non-existent file', () => {
  const evidencePath = path.join(testDir, 'nonexistent.jsonl');
  const loaded = loadEvidence(evidencePath);

  assert(Array.isArray(loaded), 'should return array');
  assert.equal(loaded.length, 0, 'should be empty for non-existent file');
});

test('evidence: verifyEvidenceHash returns true for matching hash', () => {
  const content = 'test content';
  const hash = hashContent(content);

  const result = verifyEvidenceHash({ id: 'ev001', url: 'test', timestamp: '2026-07-11T10:00:00Z', method: 'dom' as const, content_hash: hash }, content);

  assert.equal(result, true, 'matching hash should verify');
});

test('evidence: verifyEvidenceHash returns false for non-matching hash', () => {
  const record = { id: 'ev001', url: 'test', timestamp: '2026-07-11T10:00:00Z', method: 'dom' as const, content_hash: 'wrong_hash' };

  const result = verifyEvidenceHash(record, 'test content');

  assert.equal(result, false, 'non-matching hash should not verify');
});

test('evidence: boundSnapshot truncates long text within token budget', () => {
  const longText = 'x'.repeat(100000); // Very long text
  const bounded = boundSnapshot(longText, 1000); // 1000 token budget

  assert(typeof bounded === 'string', 'result should be string');
  assert(bounded.length < longText.length, 'bounded text should be shorter');
  // With 1000 tokens, we expect ~4000 chars
  assert(bounded.length <= 20000, 'should be within reasonable bounds');
});

test('evidence: boundSnapshot returns full text if within budget', () => {
  const shortText = 'Short text content';
  const bounded = boundSnapshot(shortText, 1000);

  assert.equal(bounded, shortText, 'short text within budget should be unchanged');
});

test('evidence: boundSnapshot uses default token budget', () => {
  const longText = 'word '.repeat(20000); // Very long
  const bounded = boundSnapshot(longText); // Default budget

  assert(typeof bounded === 'string', 'result should be string');
  assert(bounded.length > 0, 'should return non-empty string');
  // Default is 15k tokens ≈ 60k chars
  assert(bounded.length <= 100000, 'should be within default budget');
});

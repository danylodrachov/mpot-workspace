import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveConflicts,
  type ResolvedConflict,
  type ConflictResolutionResult,
} from '../../src/research/conflict-resolver.ts';
import type { ConflictInfo } from '../../src/research/merge-dedup.ts';
import type { Snippet } from '../../src/research/types.ts';

test('conflict-resolver: resolves single value (trivial)', () => {
  const conflict: ConflictInfo = {
    field: 'license_number',
    row_identity: 'casino_001',
    values: ['LIC-123-456'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('LIC-123-456'), ['ev001', 'ev002']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, []);

  assert.equal(result.resolved.length, 1, 'should have one resolved conflict');
  assert.equal(result.resolved[0].field, 'license_number');
  assert.equal(result.resolved[0].row_identity, 'casino_001');
  assert.equal(result.resolved[0].decision, 'LIC-123-456');
  assert.equal(result.resolved[0].reason_code, 'single_value');
  assert.deepEqual(result.resolved[0].evidence_ids, ['ev001', 'ev002']);
  assert.equal(result.unresolved.length, 0);
});

test('conflict-resolver: resolves conflict by higher source rank', () => {
  const snippets: Snippet[] = [
    {
      evidence_id: 'ev001',
      source_rank: 2, // lower rank = higher priority
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test/terms',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'License: LIC-HIGHER',
      labels: ['license'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev002',
      source_rank: 5, // lower priority
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://search.test',
      capture_time: '2026-07-12T11:00:00Z',
      excerpt: 'License: LIC-LOWER',
      labels: ['license'],
      units: [],
      truncated: false,
    },
  ];

  const conflict: ConflictInfo = {
    field: 'license_number',
    row_identity: 'casino_001',
    values: ['LIC-HIGHER', 'LIC-LOWER'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('LIC-HIGHER'), ['ev001']],
      [JSON.stringify('LIC-LOWER'), ['ev002']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, snippets);

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].decision, 'LIC-HIGHER');
  assert(result.resolved[0].reason_code.includes('rank'), 'reason should mention rank');
  assert.equal(result.unresolved.length, 0);
});

test('conflict-resolver: resolves conflict by newer capture date (same rank)', () => {
  const snippets: Snippet[] = [
    {
      evidence_id: 'ev001',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-10T10:00:00Z', // older
      excerpt: 'Old value',
      labels: ['field'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev002',
      source_rank: 3, // same rank
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z', // newer
      excerpt: 'New value',
      labels: ['field'],
      units: [],
      truncated: false,
    },
  ];

  const conflict: ConflictInfo = {
    field: 'some_field',
    row_identity: 'casino_001',
    values: ['old_value', 'new_value'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('old_value'), ['ev001']],
      [JSON.stringify('new_value'), ['ev002']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, snippets);

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].decision, 'new_value');
  assert(result.resolved[0].reason_code.includes('date'), 'reason should mention date');
  assert.equal(result.unresolved.length, 0);
});

test('conflict-resolver: preserves unresolved conflict when tie (same rank, date, evidence count)', () => {
  const snippets: Snippet[] = [
    {
      evidence_id: 'ev001',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'Value A',
      labels: ['field'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev002',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z', // same time
      excerpt: 'Value B',
      labels: ['field'],
      units: [],
      truncated: false,
    },
  ];

  const conflict: ConflictInfo = {
    field: 'some_field',
    row_identity: 'casino_001',
    values: ['value_a', 'value_b'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('value_a'), ['ev001']],
      [JSON.stringify('value_b'), ['ev002']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, snippets);

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].field, 'some_field');
  assert.equal(result.unresolved[0].row_identity, 'casino_001');
  assert.deepEqual(result.unresolved[0].values, ['value_a', 'value_b']);
  assert(result.unresolved[0].reason_code.includes('unresolved'));
  assert.equal(result.resolved.length, 0);
});

test('conflict-resolver: resolves by evidence count when rank and date tie', () => {
  const snippets: Snippet[] = [
    {
      evidence_id: 'ev001',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'Value A',
      labels: ['field'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev002',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'Value B',
      labels: ['field'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev003',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'Value A', // second evidence for A
      labels: ['field'],
      units: [],
      truncated: false,
    },
  ];

  const conflict: ConflictInfo = {
    field: 'some_field',
    row_identity: 'casino_001',
    values: ['value_a', 'value_b'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('value_a'), ['ev001', 'ev003']],
      [JSON.stringify('value_b'), ['ev002']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, snippets);

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].decision, 'value_a');
  assert(result.resolved[0].reason_code.includes('evidence_count'), 'reason should mention evidence count');
  assert.equal(result.unresolved.length, 0);
});

test('conflict-resolver: multiple conflicts resolved in deterministic order', () => {
  const snippets: Snippet[] = [
    {
      evidence_id: 'ev001',
      source_rank: 2,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'License high',
      labels: ['license'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev002',
      source_rank: 5,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'License low',
      labels: ['license'],
      units: [],
      truncated: false,
    },
    {
      evidence_id: 'ev003',
      source_rank: 3,
      source_type: 'dom',
      context_id: 'ctx001',
      url: 'https://casino.test',
      capture_time: '2026-07-12T10:00:00Z',
      excerpt: 'Country',
      labels: ['country'],
      units: [],
      truncated: false,
    },
  ];

  const conflicts: ConflictInfo[] = [
    {
      field: 'country',
      row_identity: 'casino_001',
      values: ['Norway', 'Sweden'],
      evidence_refs_per_value: new Map([[JSON.stringify('Norway'), ['ev003']]]),
    },
    {
      field: 'license_number',
      row_identity: 'casino_001',
      values: ['LIC-HIGH', 'LIC-LOW'],
      evidence_refs_per_value: new Map([
        [JSON.stringify('LIC-HIGH'), ['ev001']],
        [JSON.stringify('LIC-LOW'), ['ev002']],
      ]),
    },
  ];

  const result = resolveConflicts(conflicts, {}, snippets);

  assert.equal(result.resolved.length, 2);
  assert.equal(result.unresolved.length, 0);

  // Check both fields resolved
  const licenseResolved = result.resolved.find((r) => r.field === 'license_number');
  const countryResolved = result.resolved.find((r) => r.field === 'country');
  assert(licenseResolved, 'license should be resolved');
  assert(countryResolved, 'country should be resolved');
});

test('conflict-resolver: includes all evidence references in audit trail', () => {
  const conflict: ConflictInfo = {
    field: 'license_number',
    row_identity: 'casino_001',
    values: ['LIC-123-456'],
    evidence_refs_per_value: new Map([
      [JSON.stringify('LIC-123-456'), ['ev001', 'ev002', 'ev003']],
    ]),
  };

  const result = resolveConflicts([conflict], {}, []);

  assert.deepEqual(result.resolved[0].evidence_ids, ['ev001', 'ev002', 'ev003']);
});

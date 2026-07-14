import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mergeExtractorOutput, writeConflictsJson, readConflictsJson } from '../../src/research/merge.ts';
import { ConflictRecordSchema } from '../../src/research/types.ts';
import { validateResearchData } from '../../src/research/validator.ts';
import type { ResearchData, ConflictRecord } from '../../src/research/types.ts';

test('issue 77: ConflictRecord schema has required fields per issue 70', () => {
  const conflict: ConflictRecord = {
    field: 'game_rating',
    old_value: 4.5,
    new_value: 4.8,
    evidence_ids: ['ev001', 'ev002'],
    timestamp: '2024-01-01T00:00:00Z',
  };

  const result = ConflictRecordSchema.safeParse(conflict);
  assert.strictEqual(result.success, true, 'ConflictRecord should validate');
  assert.deepEqual(result.data?.field, 'game_rating');
  assert.deepEqual(result.data?.old_value, 4.5);
  assert.deepEqual(result.data?.new_value, 4.8);
  assert.deepEqual(result.data?.evidence_ids, ['ev001', 'ev002']);
});

test('issue 77: ConflictRecord requires all fields (no optional row_key)', () => {
  // This should fail because old required field names don't exist anymore
  const invalidConflict = {
    field: 'license',
    row_key: 'row-1', // old field - should not exist
    existing_value: 'MGA',
    incoming_value: 'Curaçao',
    source_url: 'https://example.com',
    timestamp: '2024-01-01T00:00:00Z',
  };

  const result = ConflictRecordSchema.safeParse(invalidConflict);
  assert.strictEqual(result.success, false, 'Old field names should fail');
});

test('issue 77: Merge operation handles null-fill-only semantics', () => {
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            game_name: 'Slots101',
            rating: null, // null field to be filled
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          game_name: 'value',
          rating: 'not_found_after_budget',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'games',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway', game_name: 'Slots101' },
        values: { rating: 4.7 },
        source_refs: ['ev001'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://test.com');

  const row = result.categories.games.rows[0];
  assert.equal(row.rating, 4.7, 'null field should be filled');
  assert.equal(conflicts.length, 0, 'null-fill should not create conflict');
});

test('issue 77: Merge detects identical non-null values (coalesce, no-op)', () => {
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            game_name: 'Slots101',
            rating: 4.5,
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          game_name: 'value',
          rating: 'value',
        },
        evidence_refs: {
          rating: ['ev001'],
        },
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'games',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway', game_name: 'Slots101' },
        values: { rating: 4.5 }, // Same value
        source_refs: ['ev002'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://test.com');

  assert.equal(conflicts.length, 0, 'identical values should not create conflict');
  assert.equal(result.categories.games.rows[0].rating, 4.5, 'value should remain unchanged');
});

test('issue 77: Merge detects conflicts for differing non-null values', () => {
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            game_name: 'Slots101',
            rating: 4.5,
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          game_name: 'value',
          rating: 'value',
        },
        evidence_refs: {
          rating: ['ev001'],
        },
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'games',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway', game_name: 'Slots101' },
        values: { rating: 4.8 }, // Different value
        source_refs: ['ev002', 'ev003'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://test.com');

  assert.equal(conflicts.length, 1, 'differing values should create conflict');
  assert.equal(conflicts[0].field, 'rating', 'field name should be correct');
  assert.equal(conflicts[0].old_value, 4.5, 'old value should be recorded');
  assert.equal(conflicts[0].new_value, 4.8, 'new value should be recorded');
  assert.deepEqual(conflicts[0].evidence_ids, ['ev002', 'ev003'], 'evidence IDs should be preserved');
  assert.match(conflicts[0].timestamp, /\d{4}-\d{2}-\d{2}T/, 'timestamp should be ISO 8601');
  assert.equal(result.categories.games.rows[0].rating, 4.5, 'old value should NOT be overwritten');
});

test('issue 77: Conflicts written to conflicts.json atomically', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'merge-test-'));

  try {
    const conflicts: ConflictRecord[] = [
      {
        field: 'rating',
        old_value: 4.5,
        new_value: 4.8,
        evidence_ids: ['ev001', 'ev002'],
        timestamp: '2024-01-01T00:00:00Z',
      },
      {
        field: 'payment_method',
        old_value: 'card',
        new_value: 'wallet',
        evidence_ids: ['ev003'],
        timestamp: '2024-01-01T00:00:01Z',
      },
    ];

    const conflictsPath = join(tmpDir, 'conflicts.json');
    writeConflictsJson(conflicts, conflictsPath);

    // Verify file exists and contains correct data
    assert.strictEqual(existsSync(conflictsPath), true, 'conflicts.json should be created');

    const readBack = readFileSync(conflictsPath, 'utf-8');
    const parsed = JSON.parse(readBack);

    assert.strictEqual(parsed.length, 2, 'should have 2 conflicts');
    assert.equal(parsed[0].field, 'rating');
    assert.equal(parsed[1].field, 'payment_method');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('issue 77: readConflictsJson handles missing file gracefully', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'merge-test-'));

  try {
    const conflictsPath = join(tmpDir, 'nonexistent-conflicts.json');
    const conflicts = readConflictsJson(conflictsPath);

    assert.deepEqual(conflicts, [], 'should return empty array for missing file');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('issue 77: Evidence link preservation in ConflictRecord', () => {
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            game_name: 'Slots101',
            rating: 4.5,
          },
        ],
        terminal_status: {
          game_name: 'value',
          rating: 'value',
        },
        evidence_refs: {
          rating: ['old-ev-001'],
        },
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'games',
    ops: [
      {
        op: 'upsert_row',
        match: { game_name: 'Slots101' },
        values: { rating: 4.8 },
        source_refs: ['new-ev-001', 'new-ev-002', 'new-ev-003'],
      },
    ],
  };

  const { conflicts } = mergeExtractorOutput(data, output, 'https://test.com');

  assert.equal(conflicts.length, 1, 'should have conflict');
  assert.deepEqual(
    conflicts[0].evidence_ids,
    ['new-ev-001', 'new-ev-002', 'new-ev-003'],
    'evidence IDs for new values should be preserved'
  );
});

test('issue 77: Validator gate detects conflicts correctly', () => {
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            game_name: 'Slots101',
            rating: 4.5,
          },
        ],
        terminal_status: {
          game_name: 'value',
          rating: 'value',
        },
        evidence_refs: {
          game_name: ['ev001'],
          rating: ['ev001'],
        },
        conflicts: [
          {
            field: 'rating',
            old_value: 4.5,
            new_value: 4.8,
            evidence_ids: ['ev002'],
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      },
    },
  };

  const result = validateResearchData(data, new Map(), []);

  // Should have a gate result for silent_overwrite_detection
  const silentOverwriteGate = result.gate_results.find(g => g.gate === 'silent_overwrite_detection');
  assert.ok(silentOverwriteGate, 'should have silent_overwrite_detection gate');
  assert.strictEqual(silentOverwriteGate?.passed, true, 'gate should pass for valid conflicts');
});

test('issue 77: E2E test - merge conflicting game ratings', () => {
  // Simulate collecting conflicting game ratings from different sources
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'e2e-test',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      games: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            game_name: 'Roulette',
            rating: 4.2, // First source gave 4.2
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          game_name: 'value',
          rating: 'value',
        },
        evidence_refs: {
          casino: ['ev001'],
          country: ['ev001'],
          game_name: ['ev001'],
          rating: ['ev001'],
        },
        conflicts: [],
      },
    },
  };

  // Second source gives different rating
  const output: any = {
    category: 'games',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway', game_name: 'Roulette' },
        values: { rating: 4.7 }, // Second source gave 4.7
        source_refs: ['ev002'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://source2.com');

  // Verify merge doesn't overwrite
  assert.equal(result.categories.games.rows[0].rating, 4.2, 'original rating preserved');

  // Verify conflicts recorded
  assert.equal(conflicts.length, 1, 'should have conflict record');
  assert.equal(conflicts[0].field, 'rating');
  assert.equal(conflicts[0].old_value, 4.2);
  assert.equal(conflicts[0].new_value, 4.7);
  assert.deepEqual(conflicts[0].evidence_ids, ['ev002']);

  // Verify conflicts persisted to file
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  try {
    const conflictsPath = join(tmpDir, 'conflicts.json');
    writeConflictsJson(conflicts, conflictsPath);

    const readBack = readFileSync(conflictsPath, 'utf-8');
    const persisted = JSON.parse(readBack);

    assert.equal(persisted.length, 1, 'conflicts.json should contain one conflict');
    assert.equal(persisted[0].field, 'rating');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

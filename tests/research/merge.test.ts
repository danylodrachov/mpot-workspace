import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeExtractorOutput, normalizeValue } from '../../src/research/merge.ts';
import { compileRubricFromJson } from '../../src/research/rubric-compiler.ts';

test('merge: mergeExtractorOutput performs null-fill-only merge', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'license', type: 'text' },
    ],
  });

  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            license: null, // Null field to be filled
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          license: 'not_found_after_budget',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'casinos',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway' },
        values: { license: 'LIC123' },
        source_refs: ['ev001'],
      },
    ],
  };

  const { data: result } = mergeExtractorOutput(data, output, 'https://test.com/page');

  const row = result.categories.casinos.rows[0];
  assert.equal(row.license, 'LIC123', 'null field should be filled');
  assert.equal(row.casino, 'TestCasino', 'existing fields should be unchanged');
});

test('merge: mergeExtractorOutput skips identical non-null values', () => {
  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            license: 'LIC123',
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          license: 'value',
        },
        evidence_refs: { license: ['ev001'] },
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'casinos',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway' },
        values: { license: 'LIC123' }, // Same value
        source_refs: ['ev002'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://test.com/page');

  assert.equal(conflicts.length, 0, 'identical values should not create conflicts');
  assert.equal(result.categories.casinos.rows[0].license, 'LIC123', 'value should remain');
});

test('merge: mergeExtractorOutput detects conflicts on differing non-null values', () => {
  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [
          {
            casino: 'TestCasino',
            country: 'Norway',
            license: 'LICOLD',
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          license: 'value',
        },
        evidence_refs: { license: ['ev001'] },
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'casinos',
    ops: [
      {
        op: 'upsert_row',
        match: { casino: 'TestCasino', country: 'Norway' },
        values: { license: 'LICNEW' }, // Different value
        source_refs: ['ev002'],
      },
    ],
  };

  const { data: result, conflicts } = mergeExtractorOutput(data, output, 'https://test.com/page');

  assert.equal(conflicts.length, 1, 'differing non-null values should create conflict');
  assert.equal(conflicts[0].field, 'license', 'conflict should name the field');
  assert.equal(conflicts[0].old_value, 'LICOLD', 'conflict should record old value');
  assert.equal(conflicts[0].new_value, 'LICNEW', 'conflict should record new value');
  assert.equal(result.categories.casinos.rows[0].license, 'LICOLD', 'existing value should not be overwritten');
});

test('merge: mergeExtractorOutput deduplicates by logical key', () => {
  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      communication_managers: {
        rows: [
          {
            email: 'old@casino.test',
            name: null, // Null name to be filled
          },
        ],
        terminal_status: {
          email: 'value',
          name: 'not_found_after_budget',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'communication_managers',
    ops: [
      {
        op: 'upsert_row',
        match: { email: 'old@casino.test' }, // Same email
        values: { name: 'Updated Manager' }, // Should fill null name
        source_refs: ['ev001'],
      },
    ],
  };

  const { data: result } = mergeExtractorOutput(data, output, 'https://test.com/page');

  assert.equal(result.categories.communication_managers.rows.length, 1, 'should have one row (merged, not new)');
  assert.equal(result.categories.communication_managers.rows[0].name, 'Updated Manager', 'matching logical key with null field should merge');
});

test('merge: mergeExtractorOutput creates new row for new logical key', () => {
  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      communication_managers: {
        rows: [
          {
            email: 'old@casino.test',
            name: 'Old Manager',
          },
        ],
        terminal_status: {
          email: 'value',
          name: 'value',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const output: any = {
    category: 'communication_managers',
    ops: [
      {
        op: 'upsert_row',
        match: { email: 'new@casino.test' }, // Different email
        values: { name: 'New Manager' },
        source_refs: ['ev001'],
      },
    ],
  };

  const { data: result } = mergeExtractorOutput(data, output, 'https://test.com/page');

  assert.equal(result.categories.communication_managers.rows.length, 2, 'should have two rows');
  assert(result.categories.communication_managers.rows.some((r: any) => r.email === 'new@casino.test'), 'should have new row');
});

test('merge: normalizeValue trims strings', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [{ name: 'field', type: 'text' }],
  });
  const col = rubric.columns[0];

  const result = normalizeValue('  spaced text  ', col);

  assert.equal(result, 'spaced text', 'should trim whitespace');
});

test('merge: normalizeValue parses numbers from strings', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [{ name: 'count', type: 'number' }],
  });
  const col = rubric.columns[0];

  const result = normalizeValue('123', col);

  assert.equal(result, 123, 'should parse string to number');
  assert.equal(typeof result, 'number', 'result should be number type');
});

test('merge: normalizeValue returns null for non-numeric strings for number columns', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [{ name: 'count', type: 'number' }],
  });
  const col = rubric.columns[0];

  const result = normalizeValue('not-a-number', col);

  assert.equal(result, null, 'non-numeric should return null for number columns');
});

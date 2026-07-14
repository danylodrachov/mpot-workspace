import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseExtractorOutput, filterValidOps, validatePatchOp } from '../../src/research/patch-ops.ts';
import { compileRubricFromJson } from '../../src/research/rubric-compiler.ts';

test('patch-ops: parseExtractorOutput parses valid JSON', () => {
  const json = `{
    "category": "casinos",
    "ops": [
      {
        "op": "upsert_row",
        "match": {"casino": "Test", "country": "Norway"},
        "values": {"license": "LIC123"},
        "source_refs": ["ev001"]
      }
    ]
  }`;

  const result = parseExtractorOutput(json);

  assert.equal(result.category, 'casinos', 'category should match');
  assert.equal(result.ops.length, 1, 'should have one op');
  assert.equal(result.ops[0].op, 'upsert_row', 'op type should match');
});

test('patch-ops: parseExtractorOutput strips json fence markers', () => {
  const json = `\`\`\`json
{
  "category": "casinos",
  "ops": [
    {
      "op": "upsert_row",
      "match": {"casino": "Test"},
      "values": {"license": "LIC123"},
      "source_refs": ["ev001"]
    }
  ]
}
\`\`\``;

  const result = parseExtractorOutput(json);

  assert.equal(result.category, 'casinos', 'should parse despite fence markers');
  assert.equal(result.ops.length, 1, 'should have one op');
});

test('patch-ops: parseExtractorOutput handles cross_category_ops', () => {
  const json = `{
    "category": "casinos",
    "ops": [],
    "cross_category_ops": [
      {
        "op": "upsert_row",
        "match": {"email": "test@casino.com"},
        "values": {"name": "Manager"},
        "source_refs": ["ev001"],
        "category": "communication_managers"
      }
    ]
  }`;

  const result = parseExtractorOutput(json);

  assert(result.cross_category_ops, 'should have cross_category_ops');
  assert.equal(result.cross_category_ops.length, 1, 'should have one cross-category op');
});

test('patch-ops: validatePatchOp returns true for valid op', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'license', type: 'text' },
    ],
  });

  const op = {
    op: 'upsert_row' as const,
    match: { casino: 'Test', country: 'Norway' },
    values: { license: 'LIC123' },
    source_refs: ['ev001'],
  };

  const result = validatePatchOp(op, rubric);

  assert.equal(result.valid, true, 'valid op should validate');
});

test('patch-ops: validatePatchOp rejects unknown field names', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
    ],
  });

  const op = {
    op: 'upsert_row' as const,
    match: { casino: 'Test', country: 'Norway' },
    values: { unknown_field: 'value' }, // Unknown field
    source_refs: ['ev001'],
  };

  const result = validatePatchOp(op, rubric);

  assert.equal(result.valid, false, 'op with unknown field should not validate');
  assert(result.reason?.includes('unknown') || result.reason?.includes('field'), 'reason should mention unknown field');
});

test('patch-ops: validatePatchOp rejects operator-field writes', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'enum', values: ['Norway', 'Sweden'] },
    ],
    operator_fields: ['country'],
  });

  const op = {
    op: 'upsert_row' as const,
    match: { casino: 'Test' },
    values: { country: 'Norway' }, // Operator field
    source_refs: ['ev001'],
  };

  const result = validatePatchOp(op, rubric);

  assert.equal(result.valid, false, 'op writing to operator field should not validate');
  assert(result.reason?.includes('operator'), 'reason should mention operator field');
});

test('patch-ops: validatePatchOp rejects type mismatches', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'year', type: 'number' },
    ],
  });

  const op = {
    op: 'upsert_row' as const,
    match: { casino: 'Test' },
    values: { year: 'not-a-number' }, // Type mismatch
    source_refs: ['ev001'],
  };

  const result = validatePatchOp(op, rubric);

  assert.equal(result.valid, false, 'op with type mismatch should not validate');
});

test('patch-ops: validatePatchOp rejects out-of-scope enum values', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'enum', values: ['Norway', 'Sweden'] },
    ],
  });

  const op = {
    op: 'upsert_row' as const,
    match: { casino: 'Test' },
    values: { country: 'InvalidCountry' }, // Out of scope
    source_refs: ['ev001'],
  };

  const result = validatePatchOp(op, rubric);

  assert.equal(result.valid, false, 'op with out-of-scope enum value should not validate');
});

test('patch-ops: filterValidOps separates valid and rejected ops', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'license', type: 'text' },
    ],
  });

  const ops = [
    {
      op: 'upsert_row' as const,
      match: { casino: 'Test' },
      values: { license: 'LIC123' }, // Valid
      source_refs: ['ev001'],
    },
    {
      op: 'upsert_row' as const,
      match: { casino: 'Test2' },
      values: { unknown_field: 'value' }, // Invalid
      source_refs: ['ev002'],
    },
  ];

  const { valid, rejected } = filterValidOps(ops, rubric);

  assert.equal(valid.length, 1, 'should have 1 valid op');
  assert.equal(rejected.length, 1, 'should have 1 rejected op');
  assert.equal(valid[0].values.license, 'LIC123', 'valid op should have correct value');
  assert(rejected[0].reason, 'rejected op should have reason');
});

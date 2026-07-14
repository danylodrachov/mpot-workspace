import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRubricFromJson, validateValueAgainstRubric } from '../../../src/research/rubric-compiler.ts';
import { parseExtractorOutput, filterValidOps } from '../../../src/research/patch-ops.ts';
import { mergeExtractorOutput } from '../../../src/research/merge.ts';
import type { CompiledRubric, ResearchData } from '../../../src/research/types.ts';

const __dirname = join(fileURLToPath(import.meta.url), '..');

test('integration: compiler-to-merge full pipeline', () => {
  // Load test rubric
  const rubricJson = JSON.parse(
    readFileSync(join(__dirname, '../../../src/research/__fixtures__/test-rubric.json'), 'utf-8'),
  );

  // Compile rubric (test data structure: test_category with 'name' text and 'status' enum)
  const compiledRubric: CompiledRubric = compileRubricFromJson(rubricJson);

  // Verify compilation
  assert.equal(compiledRubric.category, 'test_category', 'category matches');
  assert.equal(compiledRubric.columns.length, 2, 'columns compiled');
  assert.ok(
    compiledRubric.columns.some((c) => c.name === 'name' && c.type === 'text'),
    'text column present',
  );
  assert.ok(
    compiledRubric.columns.some((c) => c.name === 'status' && c.type === 'enum'),
    'enum column present',
  );

  // Build mock extractor output (simulating Haiku output)
  const mockExtractorJson: any = {
    category: 'test_category',
    ops: [
      {
        op: 'upsert_row',
        match: { name: 'Item1' },
        values: { status: 'active' },
        source_refs: ['ev001'],
      },
      {
        op: 'upsert_row',
        match: { name: 'Item2' },
        values: { status: 'inactive' },
        source_refs: ['ev002'],
      },
    ],
  };

  // Parse extractor output (validate JSON structure)
  const extractorOutput = parseExtractorOutput(JSON.stringify(mockExtractorJson));
  assert.equal(extractorOutput.category, 'test_category', 'category from extractor');
  assert.equal(extractorOutput.ops.length, 2, 'ops parsed');

  // Filter valid ops against compiled rubric (should pass validation)
  const { valid: validOps, rejected } = filterValidOps(extractorOutput.ops, compiledRubric);
  assert.equal(validOps.length, 2, 'ops validated against compiled rubric');
  assert.equal(rejected.length, 0, 'no ops rejected');

  // Validate individual ops
  for (const op of validOps) {
    assert.equal(op.op, 'upsert_row', 'op type correct');
    assert.ok(op.values.status, 'enum value present');
    // Validate enum value against rubric
    const statusColumn = compiledRubric.columns.find((c) => c.name === 'status');
    const isValid = validateValueAgainstRubric(statusColumn!, op.values.status);
    assert.ok(isValid, `enum value '${op.values.status}' is valid`);
  }

  // Merge into fresh research data
  const freshData: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'integration-test-001',
    started_at: new Date().toISOString(),
    categories: {
      test_category: {
        rows: [],
        terminal_status: {},
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const { data: mergedData, conflicts } = mergeExtractorOutput(
    freshData,
    extractorOutput,
    'https://test.local/page',
  );

  // Verify merge results
  assert.equal(mergedData.categories.test_category.rows.length, 2, 'rows merged');
  assert.equal(conflicts.length, 0, 'no conflicts');
  assert.deepEqual(mergedData.categories.test_category.rows[0].name, 'Item1', 'first row merged');
  assert.deepEqual(mergedData.categories.test_category.rows[1].name, 'Item2', 'second row merged');
  assert.deepEqual(mergedData.categories.test_category.rows[0].status, 'active', 'enum value merged');
  assert.deepEqual(mergedData.categories.test_category.rows[1].status, 'inactive', 'enum value merged');

  // Verify types/enums in merged data
  for (const row of mergedData.categories.test_category.rows) {
    assert.equal(typeof row.name, 'string', 'text field is string');
    const validStatuses = ['active', 'inactive'];
    assert.ok(validStatuses.includes(row.status as string), 'enum value valid');
  }
});

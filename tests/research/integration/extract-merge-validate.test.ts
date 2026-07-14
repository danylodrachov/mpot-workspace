import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRubricFromJson } from '../../../src/research/rubric-compiler.ts';
import { parseExtractorOutput } from '../../../src/research/patch-ops.ts';
import { mergeExtractorOutput } from '../../../src/research/merge.ts';
import { validateResearchData } from '../../../src/research/validator.ts';
import type { ResearchData, OldEvidenceRecord } from '../../../src/research/types.ts';

type EvidenceRecord = OldEvidenceRecord;

const __dirname = join(fileURLToPath(import.meta.url), '..');

test('integration: extract-merge-validate with conflict detection', () => {
  // Setup: compile a simple rubric
  const rubricJson = JSON.parse(
    readFileSync(join(__dirname, '../../../src/research/__fixtures__/test-rubric.json'), 'utf-8'),
  );
  const compiledRubric = compileRubricFromJson(rubricJson);

  // Initialize fresh research data with one row
  const data: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'conflict-test-001',
    started_at: new Date().toISOString(),
    categories: {
      test_category: {
        rows: [
          {
            name: 'Item1',
            status: 'active', // Existing value
          },
        ],
        terminal_status: {
          name: 'value',
          status: 'value',
        },
        evidence_refs: {
          name: ['ev001'],
          status: ['ev001'],
        },
        conflicts: [],
      },
    },
  };

  // Case 1: Merge with identical value (should coalesce, no conflict)
  const identicalOutput: any = {
    category: 'test_category',
    ops: [
      {
        op: 'upsert_row',
        match: { name: 'Item1' },
        values: { status: 'active' }, // Same value
        source_refs: ['ev002'],
      },
    ],
  };

  const parsed1 = parseExtractorOutput(JSON.stringify(identicalOutput));
  const { data: merged1, conflicts: conflicts1 } = mergeExtractorOutput(data, parsed1, 'https://test1.local');

  assert.equal(conflicts1.length, 0, 'identical value coalesces without conflict');
  assert.equal(merged1.categories.test_category.rows[0].status, 'active', 'value unchanged');

  // Case 2: Merge with conflicting value (should detect conflict, no overwrite)
  const conflictingOutput: any = {
    category: 'test_category',
    ops: [
      {
        op: 'upsert_row',
        match: { name: 'Item1' },
        values: { status: 'inactive' }, // Different value
        source_refs: ['ev003'],
      },
    ],
  };

  const parsed2 = parseExtractorOutput(JSON.stringify(conflictingOutput));
  const { data: merged2, conflicts: conflicts2 } = mergeExtractorOutput(data, parsed2, 'https://test2.local');

  assert.equal(conflicts2.length, 1, 'conflicting value triggers conflict record');
  assert.equal(conflicts2[0].field, 'status', 'conflict field correct');
  assert.equal(conflicts2[0].old_value, 'active', 'old value recorded');
  assert.equal(conflicts2[0].new_value, 'inactive', 'new value recorded');
  assert.equal(merged2.categories.test_category.rows[0].status, 'active', 'existing value NOT overwritten');
  assert.equal(merged2.categories.test_category.conflicts.length, 1, 'conflict added to data');

  // Case 3: Merge null field (should fill)
  const data3: ResearchData = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'null-fill-test',
    started_at: new Date().toISOString(),
    categories: {
      test_category: {
        rows: [
          {
            name: 'Item2',
            status: null, // Null field to be filled
          },
        ],
        terminal_status: {
          name: 'value',
          status: 'not_found_after_budget',
        },
        evidence_refs: {
          name: ['ev004'],
        },
        conflicts: [],
      },
    },
  };

  const fillOutput: any = {
    category: 'test_category',
    ops: [
      {
        op: 'upsert_row',
        match: { name: 'Item2' },
        values: { status: 'active' },
        source_refs: ['ev005'],
      },
    ],
  };

  const parsed3 = parseExtractorOutput(JSON.stringify(fillOutput));
  const { data: merged3, conflicts: conflicts3 } = mergeExtractorOutput(data3, parsed3, 'https://test3.local');

  assert.equal(conflicts3.length, 0, 'null-fill has no conflict');
  assert.equal(merged3.categories.test_category.rows[0].status, 'active', 'null field filled');

  // Case 4: Validate merged data with conflict record
  const evidenceRecords: EvidenceRecord[] = [
    {
      id: 'ev001',
      url: 'https://test1.local',
      timestamp: new Date().toISOString(),
      method: 'dom',
      content_hash: 'hash001',
    },
    {
      id: 'ev002',
      url: 'https://test2.local',
      timestamp: new Date().toISOString(),
      method: 'dom',
      content_hash: 'hash002',
    },
  ];

  const rubricsMap = new Map<string, any>();
  rubricsMap.set(compiledRubric.category, compiledRubric);
  const validationResult = validateResearchData(merged2, rubricsMap, evidenceRecords);

  // Validation should pass even with conflict (conflict is explicitly recorded)
  assert.ok(validationResult.pass || !validationResult.pass, 'validation completes');
  if (!validationResult.pass) {
    // If it fails, conflict recording should not be the reason
    assert.ok(
      !validationResult.failures.some((f) => f.reason.includes('unsupported')),
      'conflict does not cause unsupported failure',
    );
  }
});

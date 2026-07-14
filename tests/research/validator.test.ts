import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResearchData } from '../../src/research/validator.ts';
import { compileRubricFromJson } from '../../src/research/rubric-compiler.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');

test('validator: validateResearchData passes for complete valid data', () => {
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
            license: 'LIC123',
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          license: 'value',
        },
        evidence_refs: {
          casino: ['ev001'],
          country: ['ev001'],
          license: ['ev002'],
        },
        conflicts: [],
      },
    },
  };

  const evidence: any[] = [
    { id: 'ev001', url: 'test', timestamp: '2026-07-11T10:00:00Z', method: 'dom', content_hash: 'abc' },
    { id: 'ev002', url: 'test', timestamp: '2026-07-11T10:00:00Z', method: 'dom', content_hash: 'def' },
  ];

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, evidence);

  assert.equal(result.pass, true, 'valid complete data should pass');
  assert.equal(result.failures.length, 0, 'should have no failures');
});

test('validator: validateResearchData fails for missing terminal status', () => {
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
            license: 'LIC123',
          },
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          // Missing license status
        },
        evidence_refs: { casino: ['ev001'], country: ['ev001'] },
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, []);

  assert.equal(result.pass, false, 'missing terminal status should fail');
  assert(result.failures.some((f: any) => f.reason?.includes('terminal') || f.reason?.includes('status')), 'should mention terminal status');
});

test('validator: validateResearchData fails for duplicate logical key', () => {
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
          { casino: 'TestCasino', country: 'Norway', license: 'LIC123' },
          { casino: 'TestCasino', country: 'Norway', license: 'LIC456' }, // Duplicate key
        ],
        terminal_status: {
          casino: 'value',
          country: 'value',
          license: 'value',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, []);

  assert.equal(result.pass, false, 'duplicate logical key should fail');
  assert(result.failures.some((f: any) => f.reason?.includes('duplicate') || f.reason?.includes('key')), 'should mention duplicate');
});

test('validator: validateResearchData detects conflicts in category', () => {
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
        rows: [{ casino: 'TestCasino', country: 'Norway', license: 'LIC123' }],
        terminal_status: { casino: 'value', country: 'value', license: 'value' },
        evidence_refs: {
          casino: ['ev001'],
          country: ['ev001'],
          license: ['ev001'],
        },
        conflicts: [
          {
            field: 'license',
            existing_value: 'LIC123',
            incoming_value: 'LICDIFF',
            source_url: 'https://test.com',
            timestamp: '2026-07-11T10:00:00Z',
          },
        ],
      },
    },
  };

  const evidence: any[] = [
    { id: 'ev001', url: 'test', timestamp: '2026-07-11T10:00:00Z', method: 'dom', content_hash: 'abc' },
  ];

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, evidence);

  assert.equal(result.pass, false, 'data with conflicts should fail');
});

test('validator: validateResearchData fails for populated operator field', () => {
  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'notes', type: 'text' },
    ],
    operator_fields: ['notes'],
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
            notes: 'Operator notes', // Should not be populated
          },
        ],
        terminal_status: { casino: 'value', country: 'value', notes: 'operator_required' },
        evidence_refs: { casino: ['ev001'], country: ['ev001'] },
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, []);

  assert.equal(result.pass, false, 'operator field should not be populated');
});

test('validator: validateResearchData fails for missing evidence on populated field', () => {
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
        rows: [{ casino: 'TestCasino', country: 'Norway', license: 'LIC123' }],
        terminal_status: { casino: 'value', country: 'value', license: 'value' },
        evidence_refs: {
          casino: ['ev001'],
          country: ['ev001'],
          // Missing evidence for license
        },
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  const result = validateResearchData(data, rubricsMap, []);

  assert.equal(result.pass, false, 'populated field without evidence should fail');
});

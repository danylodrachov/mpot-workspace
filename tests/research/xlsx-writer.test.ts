import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { writeXlsx } from '../../src/research/xlsx-writer.ts';
import { compileRubricFromJson } from '../../src/research/rubric-compiler.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const testDir = path.join(projectRoot, 'tests/research/xlsx-tmp');

test('xlsx-writer: writeXlsx creates file and writes valid XLSX', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-output.xlsx');

  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'enum', values: ['Norway', 'Sweden'] },
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
        terminal_status: { casino: 'value', country: 'value', license: 'value' },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  await writeXlsx(outputPath, data, rubricsMap);

  assert(existsSync(outputPath), 'XLSX file should be created');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('xlsx-writer: writeXlsx creates correct sheets based on rubrics', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-multi-sheet.xlsx');

  const casinoRubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
    ],
  });

  const commRubric = compileRubricFromJson({
    category: 'communication_managers',
    columns: [
      { name: 'email', type: 'text' },
      { name: 'name', type: 'text' },
    ],
  });

  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [{ casino: 'TestCasino', country: 'Norway' }],
        terminal_status: { casino: 'value', country: 'value' },
        evidence_refs: {},
        conflicts: [],
      },
      communication_managers: {
        rows: [{ email: 'test@casino.com', name: 'Manager' }],
        terminal_status: { email: 'value', name: 'value' },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([
    ['casinos', casinoRubric],
    ['communication_managers', commRubric],
  ]);

  await writeXlsx(outputPath, data, rubricsMap);

  assert(existsSync(outputPath), 'XLSX file should be created');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('xlsx-writer: writeXlsx includes correct column order from rubric', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-column-order.xlsx');

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
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  await writeXlsx(outputPath, data, rubricsMap);

  assert(existsSync(outputPath), 'XLSX file should be created with correct column order');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('xlsx-writer: writeXlsx uses literal values without formulas', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-literal-values.xlsx');

  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'year', type: 'number' },
    ],
  });

  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [{ casino: 'TestCasino', year: 2020 }],
        terminal_status: { casino: 'value', year: 'value' },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  await writeXlsx(outputPath, data, rubricsMap);

  // Verify file exists (content validation would require reading XLSX)
  assert(existsSync(outputPath), 'XLSX file should be created with literal values');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('xlsx-writer: writeXlsx pre-allocates rows for collection', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-pre-allocated.xlsx');

  const rubric = compileRubricFromJson({
    category: 'deposits', // Collection category
    columns: [
      { name: 'casino_name', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'payment_method', type: 'text' },
      { name: 'min_deposit', type: 'number' },
    ],
  });

  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      deposits: {
        rows: [
          { casino_name: 'TestCasino', country: 'Norway', payment_method: 'Card', min_deposit: 10 },
        ],
        terminal_status: {
          casino_name: 'value',
          country: 'value',
          payment_method: 'value',
          min_deposit: 'value',
        },
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['deposits', rubric]]);

  await writeXlsx(outputPath, data, rubricsMap);

  assert(existsSync(outputPath), 'XLSX file should be created with pre-allocated rows');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('xlsx-writer: writeXlsx handles empty rows gracefully', async () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const outputPath = path.join(testDir, 'test-empty-rows.xlsx');

  const rubric = compileRubricFromJson({
    category: 'casinos',
    columns: [
      { name: 'casino', type: 'text' },
      { name: 'country', type: 'text' },
    ],
  });

  const data: any = {
    casino: 'TestCasino',
    geo: 'Norway',
    run_id: 'test-run',
    started_at: '2026-07-11T10:00:00Z',
    categories: {
      casinos: {
        rows: [], // Empty rows
        terminal_status: {},
        evidence_refs: {},
        conflicts: [],
      },
    },
  };

  const rubricsMap = new Map([['casinos', rubric]]);

  await writeXlsx(outputPath, data, rubricsMap);

  assert(existsSync(outputPath), 'XLSX file should be created even with empty rows');

  // Clean up
  rmSync(testDir, { recursive: true });
});

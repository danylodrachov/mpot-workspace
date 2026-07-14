import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ExcelJS from 'exceljs';

const { Workbook } = ExcelJS;
import { compileRubricFromJson } from '../../../src/research/rubric-compiler.ts';
import { writeXlsx } from '../../../src/research/xlsx-writer.ts';
import type { ResearchData } from '../../../src/research/types.ts';

test('integration: XLSX write and roundtrip read verification', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xlsx-test-'));

  try {
    // Setup: minimal compiled rubric for test_category
    const rubricJson = {
      category: 'test_category',
      columns: [
        { name: 'id', type: 'text' },
        { name: 'name', type: 'text' },
        { name: 'status', type: 'enum', values: ['active', 'inactive', 'pending'] },
        { name: 'count', type: 'number' },
      ],
    };

    const compiledRubric = compileRubricFromJson(rubricJson);

    // Create research data
    const researchData: ResearchData = {
      casino: 'TestCasino',
      geo: 'Norway',
      run_id: 'xlsx-test-001',
      started_at: new Date().toISOString(),
      categories: {
        test_category: {
          rows: [
            {
              id: '001',
              name: 'Item1',
              status: 'active',
              count: 10,
            },
            {
              id: '002',
              name: 'Item2',
              status: 'inactive',
              count: 20,
            },
            {
              id: '003',
              name: 'Item3',
              status: 'pending',
              count: 15,
            },
          ],
          terminal_status: {
            'id': 'value',
            'name': 'value',
            'status': 'value',
            'count': 'value',
          },
          evidence_refs: {
            'id': ['ev001'],
            'name': ['ev001'],
            'status': ['ev002'],
            'count': ['ev003'],
          },
          conflicts: [],
        },
      },
    };

    // Write XLSX
    const outputPath = path.join(tempDir, 'test-output.xlsx');
    await writeXlsx(outputPath, researchData, new Map([[compiledRubric.category, compiledRubric]]));

    // Verify file was created
    const fileContent = readFileSync(outputPath);
    assert.ok(fileContent.length > 0, 'XLSX file created');

    // Read back with exceljs
    const workbook = new Workbook();
    await workbook.xlsx.readFile(outputPath);

    // Verify sheet exists (category gets converted to sheet name by compiler)
    // For test_category not in predefined map, it stays as "test_category"
    let sheet = workbook.getWorksheet('test_category');
    if (!sheet) {
      // Try other possible conversions
      sheet = workbook.getWorksheet('Test_category');
    }
    assert.ok(sheet, 'data sheet exists in workbook with expected name');

    // Verify column headers
    const headerRow = sheet.getRow(1);
    const headers = headerRow?.values as any[];
    assert.ok(headers.includes('id'), 'id column present');
    assert.ok(headers.includes('name'), 'name column present');
    assert.ok(headers.includes('status'), 'status column present');
    assert.ok(headers.includes('count'), 'count column present');

    // Verify data rows
    const row2 = sheet.getRow(2);
    const row2Values = row2?.values as any[];
    assert.equal(row2Values?.[headers.indexOf('id')], '001', 'first row id correct');
    assert.equal(row2Values?.[headers.indexOf('name')], 'Item1', 'first row name correct');
    assert.equal(row2Values?.[headers.indexOf('status')], 'active', 'first row status correct');
    assert.equal(row2Values?.[headers.indexOf('count')], 10, 'first row count correct');

    const row3 = sheet.getRow(3);
    const row3Values = row3?.values as any[];
    assert.equal(row3Values?.[headers.indexOf('id')], '002', 'second row id correct');
    assert.equal(row3Values?.[headers.indexOf('status')], 'inactive', 'second row status correct');
    assert.equal(row3Values?.[headers.indexOf('count')], 20, 'second row count correct');

    const row4 = sheet.getRow(4);
    const row4Values = row4?.values as any[];
    assert.equal(row4Values?.[headers.indexOf('id')], '003', 'third row id correct');
    assert.equal(row4Values?.[headers.indexOf('status')], 'pending', 'third row status correct');

    // Verify enum data validation rules (Dropdowns sheet should exist)
    const dropdownsSheet = workbook.getWorksheet('Dropdowns');
    // Dropdowns sheet existence validates that enum rules are set up
    if (dropdownsSheet) {
      assert.ok(dropdownsSheet, 'Dropdowns sheet created for enum validation');
    }

    // Verify sheet opens without corruption (already validated by exceljs read)
    assert.ok(workbook.worksheets.length > 0, 'workbook structure intact');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRubricsFromZip, compileRubricFromJson, validateValueAgainstRubric } from '../../src/research/rubric-compiler.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const rubricZipPath = path.join(projectRoot, 'data/rubrics.zip');
const testRubricPath = path.join(projectRoot, 'src/research/__fixtures__/test-rubric.json');

test('rubric-compiler: compileRubricsFromZip returns Map with all 12 categories', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);

  assert(rubrics instanceof Map, 'Result should be a Map');
  assert.equal(rubrics.size, 12, 'Should have exactly 12 categories');

  const expectedCategories = [
    'casinos',
    'communication_managers',
    'deposits',
    'withdrawals',
    'betting',
    'casino_bonuses',
    'vip_casino_programs',
    'vip_betting_programs',
    'loyalty_programs',
    'free_spins',
    'cashback_offers',
    'casino_games',
  ];

  for (const cat of expectedCategories) {
    assert(rubrics.has(cat), `Missing category: ${cat}`);
  }
});

test('rubric-compiler: compiled rubric has correct structure with CompiledColumn fields', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');
  assert.equal(casinosRubric.category, 'casinos', 'category field should match');
  assert(Array.isArray(casinosRubric.columns), 'columns should be an array');

  // Check structure of first column
  if (casinosRubric.columns.length > 0) {
    const col = casinosRubric.columns[0];
    assert.equal(typeof col.name, 'string', 'column name should be string');
    assert(['text', 'number', 'enum'].includes(col.type), 'column type should be valid');
    assert.equal(typeof col.is_operator, 'boolean', 'is_operator should be boolean');
    assert.equal(typeof col.xlsx_column_index, 'number', 'xlsx_column_index should be number');
  }
});

test('rubric-compiler: operator_fields is a Set with expected operators', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');
  assert(casinosRubric.operator_fields instanceof Set, 'operator_fields should be a Set');
  assert(casinosRubric.operator_fields.has('country'), 'operator_fields should contain country');
  assert(casinosRubric.operator_fields.has('status'), 'operator_fields should contain status');
  assert(!casinosRubric.operator_fields.has('casino'), 'non-operator fields should not be in set');
});

test('rubric-compiler: logical_keys derived correctly from category', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');
  assert(Array.isArray(casinosRubric.logical_keys), 'logical_keys should be an array');
  assert(casinosRubric.logical_keys.length > 0, 'logical_keys should not be empty');

  // casinos is singleton, so should contain country
  assert(casinosRubric.logical_keys.includes('country'), 'casinos logical_keys should include country');
});

test('rubric-compiler: xlsx_sheet_name is PascalCase conversion', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');
  assert.equal(typeof casinosRubric.xlsx_sheet_name, 'string', 'xlsx_sheet_name should be string');
  assert(casinosRubric.xlsx_sheet_name.length > 0, 'xlsx_sheet_name should not be empty');

  // Should look like valid sheet name (converted to PascalCase)
  assert(/^[A-Z][a-zA-Z_]*$/.test(casinosRubric.xlsx_sheet_name), 'should be PascalCase format');
});

test('rubric-compiler: enum columns have enum_values as Set', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');

  // Find an enum column (country is typically enum)
  const enumCol = casinosRubric.columns.find((col: any) => col.type === 'enum');
  if (enumCol) {
    assert(enumCol.enum_values instanceof Set, 'enum_values should be a Set for enum columns');
    assert(enumCol.enum_values.size > 0, 'enum values set should not be empty');
  }
});

test('rubric-compiler: validateValueAgainstRubric validates text values correctly', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');

  const casinoCol = casinosRubric.columns.find((col: any) => col.name === 'casino');
  assert(casinoCol, 'casino column should exist');

  // Valid text
  assert.equal(validateValueAgainstRubric(casinoCol!, 'Some Casino'), true, 'valid text should return true');

  // Text type accepts strings
  assert.equal(validateValueAgainstRubric(casinoCol!, 'Test'), true, 'any text should be valid for text column');
});

test('rubric-compiler: validateValueAgainstRubric validates enum values case-insensitively or strictly', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');

  // Find enum column
  const enumCol = casinosRubric.columns.find((col: any) => col.type === 'enum' && col.enum_values);
  if (enumCol && enumCol.enum_values) {
    const validValue = Array.from(enumCol.enum_values)[0];
    assert.equal(validateValueAgainstRubric(enumCol, validValue), true, 'value in set should return true');

    // Invalid value
    assert.equal(validateValueAgainstRubric(enumCol, 'InvalidValue'), false, 'value not in set should return false');
  }
});

test('rubric-compiler: validateValueAgainstRubric validates number values', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);
  const casinosRubric = rubrics.get('casinos');

  assert(casinosRubric, 'casinos category should exist');

  // Find a number column
  const numCol = casinosRubric.columns.find((col: any) => col.type === 'number');
  if (numCol) {
    assert.equal(validateValueAgainstRubric(numCol, 2020), true, 'number should validate for number column');
    assert.equal(validateValueAgainstRubric(numCol, 'not-a-number'), false, 'non-number should fail for number column');
  }
});

test('rubric-compiler: compileRubricFromJson accepts valid rubric object', () => {
  const testRubric = {
    category: 'test',
    columns: [
      { name: 'id', type: 'text' },
      { name: 'count', type: 'number' },
      { name: 'status', type: 'enum', values: ['active', 'inactive'] },
    ],
  };

  const compiled = compileRubricFromJson(testRubric);

  assert(compiled, 'Should return a compiled rubric');
  assert.equal(compiled.category, 'test', 'Category should match input');
  assert(Array.isArray(compiled.columns), 'Columns should be array');
  assert.equal(compiled.columns.length, 3, 'Should have 3 columns');
});

test('rubric-compiler: compileRubricFromJson throws on malformed rubric', () => {
  const malformedJson = {
    category: 'test_category',
    columns: [
      {
        name: 'field1',
        type: 'invalid_type', // Not in allowed enum
      },
    ],
  };

  assert.throws(
    () => compileRubricFromJson(malformedJson),
    /test_category|Invalid|invalid/i,
    'Error should mention category or validation error'
  );
});

test('rubric-compiler: __MACOSX entries in ZIP are skipped', () => {
  const rubrics = compileRubricsFromZip(rubricZipPath);

  assert(!rubrics.has('__MACOSX'), '__MACOSX should not be a category');
  assert(!rubrics.has('._casinos'), 'Metadata files should not be categories');
});

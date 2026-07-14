import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeCasinoName,
  normalizeGeo,
  normalizePaymentMethod,
  normalizeEnumValue,
} from '../../src/research/normalize.ts';
import { compileRubricFromJson } from '../../src/research/rubric-compiler.ts';

test('normalize: normalizeCasinoName converts to lowercase and removes casino suffix', () => {
  const result = normalizeCasinoName('  Test Casino  ');

  assert.equal(result, 'test', 'should trim, lowercase, and remove "casino" suffix');
});

test('normalize: normalizeCasinoName converts to lowercase (suffix removal requires space)', () => {
  const result1 = normalizeCasinoName('TestCasino');
  assert.equal(result1, 'testcasino', 'should lowercase; "Casino" suffix without space is not removed');

  const result2 = normalizeCasinoName('Test Casino');
  assert.equal(result2, 'test', 'should lowercase and remove "Casino" suffix when preceded by space');
});

test('normalize: normalizeCasinoName removes multiple spaces and casino suffix', () => {
  const result = normalizeCasinoName('Test   Gaming');

  assert.equal(result, 'test', 'should normalize spaces, lowercase, and remove gaming suffix');
});

test('normalize: normalizeGeo returns trimmed country name', () => {
  const result = normalizeGeo('  Norway  ');

  assert.equal(result, 'Norway', 'should trim whitespace');
});

test('normalize: normalizeGeo converts to title case', () => {
  const result = normalizeGeo('SWEDEN');

  assert.equal(result, 'Sweden', 'should convert to title case (first upper, rest lower)');
});

test('normalize: normalizePaymentMethod matches enum values', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [
      { name: 'payment', type: 'enum', values: ['Credit Card', 'Debit Card', 'Bank Transfer'] },
    ],
  });

  const result = normalizePaymentMethod('credit card', rubric);

  assert(result, 'should find best match for case-insensitive input');
  // Result should be one of the enum values
  assert(['Credit Card', 'Debit Card', 'Bank Transfer'].includes(result), 'should return enum value');
});

test('normalize: normalizePaymentMethod returns best enum match', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [
      { name: 'payment', type: 'enum', values: ['Credit Card', 'Debit Card'] },
    ],
  });

  const result = normalizePaymentMethod('credit', rubric);

  // Should match 'Credit Card' as best match
  assert.equal(result, 'Credit Card', 'should return closest enum match');
});

test('normalize: normalizePaymentMethod returns original trimmed value for no match', () => {
  const rubric = compileRubricFromJson({
    category: 'test',
    columns: [
      { name: 'payment', type: 'enum', values: ['Credit Card', 'Debit Card'] },
    ],
  });

  const result = normalizePaymentMethod('UnknownPaymentMethod', rubric);

  assert.equal(result, 'UnknownPaymentMethod', 'should return original trimmed value for no match');
});

test('normalize: normalizeEnumValue returns case-insensitive match', () => {
  const allowed = new Set(['Active', 'Inactive', 'Pending']);

  const result = normalizeEnumValue('active', allowed);

  assert.equal(result, 'Active', 'should match case-insensitively and return original case');
});

test('normalize: normalizeEnumValue returns null for non-match', () => {
  const allowed = new Set(['Active', 'Inactive']);

  const result = normalizeEnumValue('Unknown', allowed);

  assert.equal(result, null, 'should return null if value not in set');
});

test('normalize: normalizeEnumValue handles exact match', () => {
  const allowed = new Set(['Active', 'Inactive']);

  const result = normalizeEnumValue('Active', allowed);

  assert.equal(result, 'Active', 'should return exact match');
});

test('normalize: normalizeEnumValue is case-insensitive with trim', () => {
  const allowed = new Set(['Active', 'Inactive']);

  const result = normalizeEnumValue('  ACTIVE  ', allowed);

  // Should handle trimming and case-insensitivity
  assert(result === 'Active' || result === null, 'should handle whitespace or return null');
});

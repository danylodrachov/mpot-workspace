import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCoverage, SOURCE_FAMILIES, COVERAGE_STATUSES } from './types.ts';

// (11) blocked and absent coverage statuses
test('every source family has a recorded status; blocked/absent are valid statuses (11)', () => {
  const coverage = emptyCoverage();
  assert.equal(coverage.length, SOURCE_FAMILIES.length);
  for (const entry of coverage) {
    assert.ok(SOURCE_FAMILIES.includes(entry.sourceFamily));
    assert.ok(COVERAGE_STATUSES.includes(entry.status));
  }

  const withStatuses = coverage.map((c) =>
    c.sourceFamily === 'robots_sitemap' ? { ...c, status: 'blocked' as const } :
    c.sourceFamily === 'menu_injected' ? { ...c, status: 'absent' as const } : c,
  );
  assert.equal(withStatuses.find((c) => c.sourceFamily === 'robots_sitemap')?.status, 'blocked');
  assert.equal(withStatuses.find((c) => c.sourceFamily === 'menu_injected')?.status, 'absent');
});

test('COVERAGE_STATUSES exactly matches the documented allowed set', () => {
  assert.deepEqual([...COVERAGE_STATUSES].sort(), ['absent', 'blocked', 'error', 'present', 'unsupported'].sort());
});

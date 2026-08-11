import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIGURED_SOURCE_FAMILIES, SourceCoverageTracker } from './source-coverage.ts';

test('every configured source family always has one terminal status', () => {
  const tracker = new SourceCoverageTracker();
  tracker.set('entry_url', 'complete', 1);
  const rows = tracker.finalize();
  assert.equal(rows.length, CONFIGURED_SOURCE_FAMILIES.length);
  assert.deepEqual(new Set(rows.map(r => r.sourceFamily)), new Set(CONFIGURED_SOURCE_FAMILIES));
  assert(rows.every(r => ['complete','absent','blocked','unsupported','error'].includes(r.status)));
  assert.equal(rows.find(r => r.sourceFamily === 'dom_url_attribute')?.status, 'unsupported');
});

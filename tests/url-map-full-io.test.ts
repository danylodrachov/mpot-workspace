import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFullUrlMapRunPaths } from '../src/research/url-map/full-io.ts';

test('full URL-map runs are unique and cannot overwrite a same-day seed result path', () => {
  const now = new Date('2026-08-12T10:20:30.000Z');
  const a = resolveFullUrlMapRunPaths(
    { entryUrl: 'https://westace.com/en', runId: '11111111-1111-4111-8111-111111111111' },
    { outputRoot: '/tmp/research', casinoName: 'WestAce Norway', now },
  );
  const b = resolveFullUrlMapRunPaths(
    { entryUrl: 'https://westace.com/en', runId: '22222222-2222-4222-8222-222222222222' },
    { outputRoot: '/tmp/research', casinoName: 'WestAce Norway', now },
  );

  assert.notEqual(a.runDir, b.runDir);
  assert.match(a.runDir, /westace-norway-20260812T102030Z-11111111$/);
  assert.match(b.runDir, /westace-norway-20260812T102030Z-22222222$/);
});

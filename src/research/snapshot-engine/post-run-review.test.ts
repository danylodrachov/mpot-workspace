import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateNetworkEvidenceIndex, PostRunReviewGateError } from './post-run-review.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'post-run-review-test-'));
}

test('CF-03: an absent network-evidence.jsonl is a backward-compatible no-op', async () => {
  const dir = tmpDir();
  const result = await validateNetworkEvidenceIndex(path.join(dir, 'network-evidence.jsonl'));
  assert.deepEqual(result, { present: false, records: [], capturedCount: 0 });
});

test('CF-03: a present index whose captured records all have existing bodies validates cleanly', async () => {
  const dir = tmpDir();
  const bodyPath = path.join(dir, 'body.json');
  fs.writeFileSync(bodyPath, '{"promotions":[]}');
  const indexPath = path.join(dir, 'network-evidence.jsonl');
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      schemaVersion: '1.0',
      observedOnPageUrl: 'https://example.test/promotions',
      requestUrl: 'https://example.test/api/v3/promotion/list',
      requestMethod: 'GET',
      resourceType: 'xhr',
      status: 200,
      contentType: 'application/json',
      capturedAt: new Date().toISOString(),
      bodyPath,
      bodySha256: 'abc',
      bodyBytes: 17,
      outcome: 'captured',
    }) + '\n',
  );

  const result = await validateNetworkEvidenceIndex(indexPath);
  assert.equal(result.present, true);
  assert.equal(result.capturedCount, 1);
  assert.equal(result.records.length, 1);
});

test('CF-03: a captured record whose body file is missing fails the review gate', async () => {
  const dir = tmpDir();
  const indexPath = path.join(dir, 'network-evidence.jsonl');
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      schemaVersion: '1.0',
      observedOnPageUrl: 'https://example.test/payments',
      requestUrl: 'https://example.test/api/cashbox/paymentsystem',
      requestMethod: 'GET',
      resourceType: 'fetch',
      status: 200,
      contentType: 'application/json',
      capturedAt: new Date().toISOString(),
      bodyPath: path.join(dir, 'does-not-exist.json'),
      bodySha256: 'abc',
      bodyBytes: 17,
      outcome: 'captured',
    }) + '\n',
  );

  await assert.rejects(async () => validateNetworkEvidenceIndex(indexPath), PostRunReviewGateError);
});

test('CF-03: skipped/timeout/error records never require a body file', async () => {
  const dir = tmpDir();
  const indexPath = path.join(dir, 'network-evidence.jsonl');
  const lines = ['skipped', 'timeout', 'error'].map((outcome) =>
    JSON.stringify({
      schemaVersion: '1.0',
      observedOnPageUrl: 'https://example.test/promotions',
      requestUrl: 'https://example.test/api/v3/bonus/list',
      requestMethod: 'GET',
      resourceType: 'xhr',
      status: 200,
      capturedAt: new Date().toISOString(),
      outcome,
      reason: `simulated ${outcome}`,
    }),
  );
  fs.writeFileSync(indexPath, lines.join('\n') + '\n');

  const result = await validateNetworkEvidenceIndex(indexPath);
  assert.equal(result.present, true);
  assert.equal(result.capturedCount, 0);
  assert.equal(result.records.length, 3);
});

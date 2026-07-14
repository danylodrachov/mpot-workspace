/**
 * Black-box acceptance test for issue #52 — fetch-to-day fetch-all + check-day thresholds.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only: the
 * write helper writes ONE file per item (fetch-all, not one-of-each), and the check-day gate
 * is presence-based (a quiet zero-email day still PASSES; only a never-built folder FAILS).
 *
 * Acceptance criteria (issue #52):
 *  - fetch-to-day writes all matching gmail + reply.io items (one file each)
 *  - check-day gate reflects fetch-all semantics (no false FAIL on a low-volume day)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { writeItems, fetchToRaw } from './fetch-to-day.ts';

const CHECK = fileURLToPath(new URL('../../bin/check-day.sh', import.meta.url));

/** Run check-day.sh against a chosen day dir via the DAY_DIR override. Returns exit code + output. */
function runCheck(dayDir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [CHECK], {
      env: { ...process.env, DAY_DIR: dayDir },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

test('writeItems writes ONE file per item — fetch-all, not one-of-each', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emails-'));
  const items = [
    { id: 'aaa', subject: 'one' },
    { id: 'bbb', subject: 'two' },
    { id: 'ccc', subject: 'three' },
  ];
  const paths = writeItems(dir, items, (it) => `gmail-${it.id}.json`);
  assert.equal(paths.length, 3, 'returns one path per item');
  const onDisk = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(onDisk.length, 3, 'three files written, not just the first');
  assert.deepEqual(onDisk.sort(), ['gmail-aaa.json', 'gmail-bbb.json', 'gmail-ccc.json']);
});

test('check-day PASSES on a quiet day: folders present, zero unread emails', () => {
  const day = mkdtempSync(join(tmpdir(), 'day-'));
  mkdirSync(join(day, 'inputs', 'raw'), { recursive: true });
  mkdirSync(join(day, 'inputs', 'clean'), { recursive: true });
  mkdirSync(join(day, 'outputs', 'emails'), { recursive: true });
  mkdirSync(join(day, 'outputs', 'tasks'), { recursive: true });
  // No files at all — a legitimate quiet day under fetch-all. Must NOT be a FAIL.
  const { code, out } = runCheck(day);
  assert.equal(code, 0, `quiet day must PASS (presence, not count). Output:\n${out}`);
  assert.match(out, /PASS/);
});

test('check-day FAILS only when the day folder was never built', () => {
  const missing = join(tmpdir(), 'nope-' + Date.now());
  const { code } = runCheck(missing);
  assert.equal(code, 1, 'a missing day folder is the real failure');
});

// ── tracer.fetch (issue #02) ─────────────────────────────────────────────────

test('tracer.fetch: stubbed fetchers → inputs/raw/{gmail,replyio,clickup}.json, no field loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracer-fetch-'));
  const gmailItems = [{ id: 'g1', subject: 'hello', from: 'a@b.com' }];
  const replyioItems = [{ id: 'r1', body: 'world', threadId: 't1' }];
  const clickupItems = [{ id: 'c1', name: 'task', status: 'Negotiation' }];

  await fetchToRaw(root, {
    gmail: () => Promise.resolve(gmailItems),
    replyio: () => Promise.resolve(replyioItems),
    clickup: () => Promise.resolve(clickupItems),
  });

  const rawDir = join(root, 'inputs', 'raw');
  assert.deepEqual(JSON.parse(readFileSync(join(rawDir, 'gmail.json'), 'utf8')), gmailItems, 'gmail: no field loss');
  assert.deepEqual(JSON.parse(readFileSync(join(rawDir, 'replyio.json'), 'utf8')), replyioItems, 'replyio: no field loss');
  assert.deepEqual(JSON.parse(readFileSync(join(rawDir, 'clickup.json'), 'utf8')), clickupItems, 'clickup: no field loss');
});

test('tracer.fetch: fetch writes nothing to outputs/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracer-fetch-'));
  await fetchToRaw(root, {
    gmail: () => Promise.resolve([{ id: 'g1' }]),
  });
  assert.equal(existsSync(join(root, 'outputs')), false, 'fetchToRaw must not touch outputs/');
});

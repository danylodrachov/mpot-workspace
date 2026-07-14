/**
 * Black-box acceptance test for issue #01 — message-keyed registry.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * messageKey builders, load/record/save roundtrip, on-disk location, join-map removal.
 *
 * Acceptance criteria (issue #01):
 *  1. messageKey(gmail) -> gmail:<id>; messageKey(replyio) -> replyio:<id>:<lastActivityDate>
 *  2. Fresh root: loadRegistry -> empty, has -> false. record + saveRegistry + loadRegistry
 *     roundtrip: has -> true, entry fields (incl. file/verdict) survive byte-exact.
 *  3. data/registry.json lands outside any data/<date>/ folder.
 *  4. join-map.ts no longer exists; npm run typecheck green (checked by CI, not here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixDir = fileURLToPath(new URL('./__fixtures__/tracer', import.meta.url));

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tracer-registry-'));
}

test('messageKey: gmail fixture message -> gmail:<its id>', async () => {
  const { messageKey } = await import('./registry.ts');

  const rawGmail = JSON.parse(readFileSync(join(fixDir, 'ckb-gmail.raw.json'), 'utf8'));
  const message = rawGmail.messages[1]; // msg_inbound_002

  assert.equal(messageKey('gmail', message), `gmail:${message.id}`);
});

test('messageKey: reply.io fixture record -> replyio:<id>:<lastActivityDate>', async () => {
  const { messageKey } = await import('./registry.ts');

  const rawReplyio = JSON.parse(readFileSync(join(fixDir, 'okb-reply.raw.json'), 'utf8'));
  const lastActivityDate = rawReplyio.raw.lastActivityDate;

  assert.equal(messageKey('replyio', rawReplyio), `replyio:${rawReplyio.id}:${lastActivityDate}`);
});

test('fresh root: loadRegistry empty, has false', async () => {
  const { loadRegistry, has } = await import('./registry.ts');
  const root = makeRoot();

  const reg = loadRegistry(root);
  assert.deepEqual(reg, {}, 'fresh registry is empty');
  assert.equal(has(reg, 'gmail:whatever'), false, 'has() false on empty registry');
});

test('record + saveRegistry + loadRegistry roundtrip: has true, fields byte-exact', async () => {
  const { loadRegistry, has, record, saveRegistry } = await import('./registry.ts');
  const root = makeRoot();

  const reg = loadRegistry(root);
  const key = 'replyio:396431314:2026-06-25T16:54Z';
  const entry = {
    thread_id: '396431314',
    task_id: '869cketmm',
    clickup_status: 'negotiation',
    file: 'data/2026-06-25/outputs/emails/replyio/396431314.json',
    verdict: 'data/2026-06-25/outputs/emails/replyio/396431314.verdict.json',
    redo_draft: false,
  };
  record(reg, key, entry);
  saveRegistry(root, reg);

  const reloaded = loadRegistry(root);
  assert.equal(has(reloaded, key), true, 'has() true after roundtrip');
  assert.deepEqual(reloaded[key], entry, 'entry fields survive byte-exact, including file/verdict');
});

test('data/registry.json lands outside any data/<date>/ folder', async () => {
  const { loadRegistry, record, saveRegistry } = await import('./registry.ts');
  const root = makeRoot();

  const reg = loadRegistry(root);
  record(reg, 'gmail:msg_x', {
    thread_id: '19e8cf79',
    task_id: null,
    clickup_status: null,
    file: null,
    verdict: null,
    redo_draft: null,
  });
  saveRegistry(root, reg);

  const expectedPath = join(root, 'data', 'registry.json');
  assert.ok(existsSync(expectedPath), `registry.json exists at ${expectedPath}`);
  assert.ok(!existsSync(join(root, 'data', '2026-07-03', 'registry.json')), 'not inside a day folder');
});

test('join-map.ts no longer exists', () => {
  const joinMapPath = fileURLToPath(new URL('./join-map.ts', import.meta.url));
  assert.equal(existsSync(joinMapPath), false, 'join-map.ts must be deleted');

  const joinMapTestPath = fileURLToPath(new URL('./join-map.test.ts', import.meta.url));
  assert.equal(existsSync(joinMapTestPath), false, 'join-map.test.ts must be deleted');
});

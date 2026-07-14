/**
 * Black-box test for the blocked-senders spam gate (2026-07-07): addresses listed in
 * `blocked-senders.json` must never reach an agent — the raw item is quarantined at clean()
 * with reason "blocked-sender" and never lands in `inputs/clean/*`. Matching is on the
 * NEWEST INBOUND message's sender address, exact + case-insensitive; display-name framing
 * ("Name <a@b>") is ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'blocked-senders-'));
  mkdirSync(join(root, 'inputs', 'raw'), { recursive: true });
  return root;
}

function gmailThread(threadId: string, from: string): unknown {
  return {
    threadId,
    messages: [{
      id: `msg_${threadId}`,
      threadId,
      from,
      subject: 'Hello',
      date: '2026-07-07T09:00:00.000Z',
      text: 'Some body text.',
      isOutbound: false,
      attachments: [],
    }],
  };
}

test('blocked sender (gmail): quarantined with reason blocked-sender, absent from clean output', async () => {
  const { clean } = await import('./index.ts');
  const root = makeRoot();

  const raw = [
    gmailThread('thread_spam_1', 'Wild Tokyo <INFO@WildTokyo.io>'),
    gmailThread('thread_spam_2', 'fred@fireflies.ai'),
    gmailThread('thread_ok_1', 'Sarah Editor <editor@techblog.com>'),
  ];
  writeFileSync(join(root, 'inputs', 'raw', 'gmail.json'), JSON.stringify(raw));

  await clean(root);

  const cleaned = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'gmail.json'), 'utf8'));
  assert.equal(cleaned.length, 1, 'only the non-blocked thread survives');
  assert.equal(cleaned[0].id, 'thread_ok_1');

  for (const id of ['thread_spam_1', 'thread_spam_2']) {
    const qPath = join(root, 'inputs', 'clean', '_quarantine', `${id}.json`);
    assert.ok(existsSync(qPath), `${id} quarantined`);
    const q = JSON.parse(readFileSync(qPath, 'utf8'));
    assert.equal(q.reason, 'blocked-sender');
  }
});

test('blocked sender (replyio): newest inbound from a listed address is quarantined', async () => {
  const { clean } = await import('./index.ts');
  const root = makeRoot();

  const raw = [{
    id: '7001',
    subject: 'Meeting notes',
    body: '<p>Your meeting recap</p>',
    from: 'fred@fireflies.ai',
    date: '2026-07-07T10:00:00Z',
    raw: { lastActivityDate: '2026-07-07T10:00:00Z' },
  }];
  writeFileSync(join(root, 'inputs', 'raw', 'replyio.json'), JSON.stringify(raw));

  await clean(root);

  const cleaned = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'replyio.json'), 'utf8'));
  assert.equal(cleaned.length, 0, 'blocked replyio item never reaches clean output');
  const q = JSON.parse(readFileSync(join(root, 'inputs', 'clean', '_quarantine', '7001.json'), 'utf8'));
  assert.equal(q.reason, 'blocked-sender');
});

test('config lists exactly the operator-supplied addresses', () => {
  const cfg = JSON.parse(
    readFileSync(new URL('./blocked-senders.json', import.meta.url), 'utf8'),
  ) as { senders: string[] };
  for (const s of [
    'info@wildtokyo.io',
    'team@mail.clickup.com',
    'no-reply@mail.instagram.com',
    'adil@teamseleqtgo.com',
    'fred@fireflies.ai',
  ]) {
    assert.ok(cfg.senders.includes(s), `${s} present in blocked-senders.json`);
  }
});

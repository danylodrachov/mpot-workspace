/**
 * Black-box acceptance test for issue #06 — splitter + verdict seeding.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * inputs/clean/* → split(root) → outputs/emails/<source>/<id>.json +
 * write-once <id>.verdict.json seeded with source/thread_id/sequence/media.
 *
 * Acceptance criteria (issue #06):
 *  - tracer.split: outputs/emails/<source>/<id>.json + verdict seeded with source/thread_id/sequence/media
 *  - Re-run does NOT overwrite an existing verdict
 *  - ClickUp verdict seeded board/task_id/task_name/current_lane, rest null
 *  - Seeded shape matches the verdict templates exactly (fields present, explicitly null)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tracer-split-'));
  mkdirSync(join(root, 'inputs', 'raw'), { recursive: true });
  mkdirSync(join(root, 'inputs', 'clean'), { recursive: true });
  return root;
}

const fixDir = fileURLToPath(new URL('./__fixtures__/tracer', import.meta.url));

const cleanReplyioThread = {
  id: '1001',
  subject: 'Re: Colaboración de guest post — VidaTech Blog',
  sequence: null,
  messages: [{
    date: '2026-06-23T09:15:00Z',
    from: 'maria.gonzalez@vidatechblog.com',
    isOutbound: false,
    body: 'Hola Daniel,\n\nGracias por tu propuesta. Nos interesa publicar el artículo.',
    attachments: [],
  }],
};

const cleanGmailThread = {
  id: 'thread_ckb_gmail_001',
  subject: 'Guest post opportunity — Digital Marketing',
  sequence: null,
  messages: [{
    date: '2026-06-23T14:30:00Z',
    from: 'editor@techblog.com',
    isOutbound: false,
    body: 'We published your article! Here is the live link: https://techblog.com/article',
    attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', size: 12345 }],
  }],
};

const cleanClickupTask = {
  id: 'task_okb_001',
  name: 'VidaTech Blog — María González',
  board: 'outreach',
  status: 'Negotiation',
  body: 'Initial outreach sent.',
};

// ── tracer.split ──────────────────────────────────────────────────────────────

test('tracer.split: clean → outputs/emails/<source>/<id>.json + verdict seeded with source/thread_id/sequence/media', async () => {
  const { split } = await import('./split.ts');
  const root = makeRoot();

  // Raw replyio (for media chain step 1 — company name)
  const rawReplyio = JSON.parse(readFileSync(join(fixDir, 'okb-reply.raw.json'), 'utf8'));
  writeFileSync(join(root, 'inputs', 'raw', 'replyio.json'), JSON.stringify([rawReplyio]));

  // Clean data
  writeFileSync(join(root, 'inputs', 'clean', 'replyio.json'), JSON.stringify([cleanReplyioThread]));
  writeFileSync(join(root, 'inputs', 'clean', 'gmail.json'), JSON.stringify([cleanGmailThread]));
  writeFileSync(join(root, 'inputs', 'clean', 'clickup.json'), JSON.stringify([cleanClickupTask]));

  await split(root);

  // replyio thread split file
  const rThread = JSON.parse(readFileSync(join(root, 'outputs', 'emails', 'replyio', '1001.json'), 'utf8'));
  assert.equal(rThread.id, '1001', 'replyio thread id');
  assert.equal(rThread.subject, cleanReplyioThread.subject, 'replyio thread subject');

  // replyio verdict seeded
  const rVerdict = JSON.parse(readFileSync(join(root, 'outputs', 'emails', 'replyio', '1001.verdict.json'), 'utf8'));
  assert.equal(rVerdict.source, 'replyio', 'verdict.source');
  assert.equal(rVerdict.thread_id, '1001', 'verdict.thread_id');
  // okb-reply.raw.json carries raw.sequence.name (issue #09 extended the fixture) — verdict.sequence
  // must surface it, not stay null.
  assert.equal(rVerdict.sequence, 'Guest Post Outreach — Q3', 'verdict.sequence carries raw.sequence.name');
  assert.ok(rVerdict.media !== null && rVerdict.media !== undefined, `verdict.media non-null; got: ${rVerdict.media}`);

  // gmail thread split file
  const gThread = JSON.parse(readFileSync(join(root, 'outputs', 'emails', 'gmail', 'thread_ckb_gmail_001.json'), 'utf8'));
  assert.equal(gThread.id, 'thread_ckb_gmail_001', 'gmail thread id');

  // gmail verdict seeded
  const gVerdict = JSON.parse(readFileSync(join(root, 'outputs', 'emails', 'gmail', 'thread_ckb_gmail_001.verdict.json'), 'utf8'));
  assert.equal(gVerdict.source, 'gmail', 'gmail verdict.source');
  assert.equal(gVerdict.thread_id, 'thread_ckb_gmail_001', 'gmail verdict.thread_id');
  assert.ok(gVerdict.media !== null && gVerdict.media !== undefined, `gmail verdict.media non-null; got: ${gVerdict.media}`);
});

// ── write-once: re-run does not overwrite ────────────────────────────────────

test('re-run does not overwrite an existing verdict', async () => {
  const { split } = await import('./split.ts');
  const root = makeRoot();

  const rawReplyio = JSON.parse(readFileSync(join(fixDir, 'okb-reply.raw.json'), 'utf8'));
  writeFileSync(join(root, 'inputs', 'raw', 'replyio.json'), JSON.stringify([rawReplyio]));
  writeFileSync(join(root, 'inputs', 'clean', 'replyio.json'), JSON.stringify([cleanReplyioThread]));

  // First run — seeds the verdict
  await split(root);

  const verdictPath = join(root, 'outputs', 'emails', 'replyio', '1001.verdict.json');
  const after1 = JSON.parse(readFileSync(verdictPath, 'utf8'));

  // Simulate agent fill: overwrite verdict with agent-written data
  const filled = { ...after1, label: 'outreach', reasoning: 'human-written reasoning' };
  writeFileSync(verdictPath, JSON.stringify(filled, null, 2));

  // Second run — must NOT overwrite
  await split(root);

  const after2 = JSON.parse(readFileSync(verdictPath, 'utf8'));
  assert.equal(after2.label, 'outreach', 'agent-written label preserved on re-run');
  assert.equal(after2.reasoning, 'human-written reasoning', 'agent-written reasoning preserved');
});

// ── ClickUp verdict seeded correctly ─────────────────────────────────────────

test('ClickUp verdict seeded board/task_id/task_name/current_lane, rest null', async () => {
  const { split } = await import('./split.ts');
  const root = makeRoot();

  writeFileSync(join(root, 'inputs', 'clean', 'clickup.json'), JSON.stringify([cleanClickupTask]));

  await split(root);

  const taskFile = JSON.parse(readFileSync(join(root, 'outputs', 'tasks', 'task_okb_001.json'), 'utf8'));
  assert.equal(taskFile.id, 'task_okb_001', 'task split file id');

  const verdict = JSON.parse(readFileSync(join(root, 'outputs', 'tasks', 'task_okb_001.verdict.json'), 'utf8'));
  assert.equal(verdict.board, 'outreach', 'verdict.board seeded');
  assert.equal(verdict.task_id, 'task_okb_001', 'verdict.task_id seeded');
  assert.equal(verdict.task_name, 'VidaTech Blog — María González', 'verdict.task_name seeded');
  assert.equal(verdict.current_lane, 'Negotiation', 'verdict.current_lane seeded');

  // Unseeded fields must be null
  assert.equal(verdict.reasoning, null, 'reasoning null');
  assert.equal(verdict.user_feedback, null, 'user_feedback null');
  assert.equal(verdict.AI_feedback, null, 'AI_feedback null');
  assert.equal(verdict.decision_data.package_size, null, 'decision_data.package_size null');
  assert.equal(verdict.decision_data.payment_terms, null, 'decision_data.payment_terms null');
  assert.equal(verdict.decision_data.correction_items, null, 'decision_data.correction_items null');
});

// ── seeded shape matches templates exactly ───────────────────────────────────

test('thread verdict shape matches messaging-subagent/verdict.template.json exactly', async () => {
  const { split } = await import('./split.ts');
  const root = makeRoot();

  writeFileSync(join(root, 'inputs', 'clean', 'replyio.json'), JSON.stringify([cleanReplyioThread]));

  await split(root);

  const verdict = JSON.parse(readFileSync(join(root, 'outputs', 'emails', 'replyio', '1001.verdict.json'), 'utf8'));

  // All template fields must be present
  assert.ok('source' in verdict, 'source field present');
  assert.ok('thread_id' in verdict, 'thread_id field present');
  assert.ok('sequence' in verdict, 'sequence field present');
  assert.ok('media' in verdict, 'media field present');
  assert.ok('label' in verdict, 'label field present');
  assert.ok('tc_covered' in verdict, 'tc_covered field present');
  assert.ok('decision_data' in verdict, 'decision_data field present');
  assert.ok('payment_terms' in verdict.decision_data, 'decision_data.payment_terms present');
  assert.ok('ready_for_qa' in verdict.decision_data, 'decision_data.ready_for_qa present');
  assert.ok('reasoning' in verdict, 'reasoning field present');
  assert.ok('draft' in verdict, 'draft field present');
  assert.ok('user_feedback' in verdict, 'user_feedback field present');
  assert.ok('AI_feedback' in verdict, 'AI_feedback field present');

  // Unseeded fields null
  assert.equal(verdict.label, null, 'label null');
  assert.equal(verdict.tc_covered, null, 'tc_covered null');
  assert.equal(verdict.decision_data.payment_terms, null, 'payment_terms null');
  assert.equal(verdict.decision_data.ready_for_qa, null, 'ready_for_qa null');
  assert.equal(verdict.reasoning, null, 'reasoning null');
  assert.equal(verdict.draft, null, 'draft null');
  assert.equal(verdict.user_feedback, null, 'user_feedback null');
  assert.equal(verdict.AI_feedback, null, 'AI_feedback null');
});

test('task verdict shape matches clickup-subagent/verdict.template.json exactly', async () => {
  const { split } = await import('./split.ts');
  const root = makeRoot();

  writeFileSync(join(root, 'inputs', 'clean', 'clickup.json'), JSON.stringify([cleanClickupTask]));

  await split(root);

  const verdict = JSON.parse(readFileSync(join(root, 'outputs', 'tasks', 'task_okb_001.verdict.json'), 'utf8'));

  assert.ok('board' in verdict, 'board field present');
  assert.ok('task_id' in verdict, 'task_id field present');
  assert.ok('task_name' in verdict, 'task_name field present');
  assert.ok('current_lane' in verdict, 'current_lane field present');
  assert.ok('decision_data' in verdict, 'decision_data field present');
  assert.ok('package_size' in verdict.decision_data, 'decision_data.package_size present');
  assert.ok('payment_terms' in verdict.decision_data, 'decision_data.payment_terms present');
  assert.ok('correction_items' in verdict.decision_data, 'decision_data.correction_items present');
  assert.ok('reasoning' in verdict, 'reasoning field present');
  assert.ok('user_feedback' in verdict, 'user_feedback field present');
  assert.ok('AI_feedback' in verdict, 'AI_feedback field present');
});

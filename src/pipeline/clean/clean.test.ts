/**
 * Black-box acceptance test for issue #05 — cleaner stage + fallback contract.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * inputs/raw/* → clean(root) → inputs/clean/* with minimal shape, top-post body,
 * attachments meta, and fallback contract (batch completes; bad item quarantined or sentinelled).
 *
 * Acceptance criteria (issue #05):
 *  - tracer.clean: clean/* minimal shape; body = top-post (quoted tail gone); attachments meta
 *  - Unknown keys stripped via zod .parse()
 *  - tracer.fallback: broken item → sentinel OR quarantine + flag_operator; batch completes
 *  - Each lib helper unit-tested in isolation (see bottom)
 *  - normalizeBody is the single body-transform choke-point
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── tracer.clean ───────────────────────────────────────────────────────────────

test('tracer.clean: raw → inputs/clean/* minimal shape; body = top-post; attachments meta', async () => {
  const { clean } = await import('./index.ts');

  const root = mkdtempSync(join(tmpdir(), 'tracer-clean-'));
  mkdirSync(join(root, 'inputs', 'raw'), { recursive: true });

  // Gmail raw (GmailThreadFile[] — what fetchRecent writes)
  const gmailRaw = [{
    threadId: 'thread_ckb_001',
    messages: [{
      id: 'msg_inbound_002',
      threadId: 'thread_ckb_001',
      from: 'editor@techblog.com',
      subject: 'Re: Guest post opportunity',
      date: '2026-06-23T14:30:00.000Z',
      text: 'Hi Daniel, We published your article! Here is the live link: https://techblog.com/article\n\nBest regards,\nSarah Editor\n\nOn Mon, 22 Jun 2026, Daniel wrote:\n> Hello, I would like to pitch a guest post for your technology blog.',
      isOutbound: false,
      attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', size: 12345 }],
    }],
  }];
  writeFileSync(join(root, 'inputs', 'raw', 'gmail.json'), JSON.stringify(gmailRaw));

  // ReplyIO raw from golden fixture (ReplyItem — HTML body with Spanish quoted tail)
  const fixDir = fileURLToPath(new URL('../__fixtures__/tracer', import.meta.url));
  const replyioFixture = JSON.parse(readFileSync(join(fixDir, 'okb-reply.raw.json'), 'utf8'));
  writeFileSync(join(root, 'inputs', 'raw', 'replyio.json'), JSON.stringify([replyioFixture]));

  // ClickUp raw from golden fixture
  const clickupFixture = JSON.parse(readFileSync(join(fixDir, 'okb-task.raw.json'), 'utf8'));
  writeFileSync(join(root, 'inputs', 'raw', 'clickup.json'), JSON.stringify([clickupFixture]));

  await clean(root);

  // Assert replyio: quoted/forwarded chain KEPT (issue #09 — reply.io's only copy of the
  // conversation history lives inside the quote; quote-strip does not run for this source),
  // main content present too.
  const cleanReplyio = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'replyio.json'), 'utf8'));
  assert.ok(Array.isArray(cleanReplyio), 'clean replyio is array');
  const rThread = cleanReplyio[0];
  assert.equal(typeof rThread.id, 'string', 'id is string');
  assert.equal(typeof rThread.subject, 'string', 'subject is string');
  assert.ok(Array.isArray(rThread.messages), 'messages is array');
  const rBody = rThread.messages[0].body;
  assert.match(rBody, /Daniel escribió/, 'quoted/forwarded chain retained (issue #09)');
  assert.match(rBody, /Gracias por tu propuesta/, 'main content present');
  assert.ok(Array.isArray(rThread.messages[0].attachments), 'attachments is array');
  // unknown keys stripped by zod
  assert.equal(rThread.email, undefined, 'email (unknown key) stripped');
  assert.equal(rThread.company, undefined, 'company (unknown key) stripped');
  assert.equal(rThread.raw, undefined, 'raw (unknown key) stripped');

  // Assert gmail: quoted tail stripped, attachments meta present
  const cleanGmail = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'gmail.json'), 'utf8'));
  assert.ok(Array.isArray(cleanGmail), 'clean gmail is array');
  const gThread = cleanGmail[0];
  assert.equal(typeof gThread.id, 'string', 'gmail id is string');
  const gBody = gThread.messages[0].body;
  assert.doesNotMatch(gBody, /Daniel wrote:/, 'gmail quoted tail stripped');
  assert.match(gBody, /We published your article/, 'gmail main content present');
  assert.equal(gThread.messages[0].attachments.length, 1, 'gmail attachment meta preserved');
  assert.equal(gThread.messages[0].attachments[0].filename, 'contract.pdf');

  // Assert clickup: id + name + body present; unknown keys stripped
  const cleanClickup = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'clickup.json'), 'utf8'));
  assert.ok(Array.isArray(cleanClickup), 'clean clickup is array');
  const cTask = cleanClickup[0];
  assert.equal(typeof cTask.id, 'string', 'clickup id is string');
  assert.equal(typeof cTask.name, 'string', 'clickup name is string');
  assert.equal(typeof cTask.body, 'string', 'clickup body is string');
  assert.equal(cTask.raw, undefined, 'raw (unknown key) stripped from clickup');
});

// ── tracer.fallback ────────────────────────────────────────────────────────────

test('tracer.fallback: broken item → sentinel or quarantine + flag_operator; batch completes', async () => {
  const { clean } = await import('./index.ts');

  const root = mkdtempSync(join(tmpdir(), 'tracer-fallback-'));
  mkdirSync(join(root, 'inputs', 'raw'), { recursive: true });

  // Valid replyio item
  const fixDir = fileURLToPath(new URL('../__fixtures__/tracer', import.meta.url));
  const validItem = JSON.parse(readFileSync(join(fixDir, 'okb-reply.raw.json'), 'utf8'));

  // Broken item from golden fixture (schema-violating: id is number, messages is string)
  const brokenItem = JSON.parse(readFileSync(join(fixDir, 'broken.raw.json'), 'utf8'));

  writeFileSync(join(root, 'inputs', 'raw', 'replyio.json'), JSON.stringify([validItem, brokenItem]));

  // Should NOT throw — batch must complete even when one item fails
  const flags = await clean(root);

  // Valid item must appear in clean output
  const cleanReplyio = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'replyio.json'), 'utf8'));
  const validCleaned = cleanReplyio.find((t: any) => t.id === validItem.id);
  assert.ok(validCleaned, 'valid item appears in clean output despite broken sibling');

  // Broken item: either quarantined OR has sentinel body in clean output
  const quarantineDir = join(root, 'inputs', 'clean', '_quarantine');
  const brokenId = String(brokenItem.id);
  const quarantineFile = join(quarantineDir, `${brokenId}.json`);
  const brokenCleaned = cleanReplyio.find((t: any) => t.id === brokenId);

  const quarantined = existsSync(quarantineFile);
  const hasSentinel = brokenCleaned?.messages?.[0]?.body?.startsWith('⚠');

  assert.ok(
    quarantined || hasSentinel,
    `broken item must be quarantined (${quarantineFile}) or have ⚠ sentinel body`,
  );

  if (quarantined) {
    // flag_operator must be emitted
    assert.ok(
      flags.some((f: any) => f.kind === 'flag_operator'),
      'flag_operator emitted for quarantined item',
    );
  }
});

// ── lib helper unit tests ──────────────────────────────────────────────────────

test('htmlToText: converts HTML to readable text, strips tags', async () => {
  const { htmlToText } = await import('../../lib/html-text.ts');
  const html = '<p>Hello <b>world</b></p><br><p>Line two</p>';
  const result = htmlToText(html);
  assert.doesNotMatch(result, /<[^>]+>/, 'no HTML tags');
  assert.match(result, /Hello world/, 'content preserved');
  assert.match(result, /Line two/, 'second paragraph preserved');
});

test('htmlToText: empty input returns empty string', async () => {
  const { htmlToText } = await import('../../lib/html-text.ts');
  assert.equal(htmlToText(''), '');
});

test('topPost: strips quoted tail from plain text', async () => {
  const { topPost } = await import('../../lib/quote-strip.ts');
  const text = 'Main reply content.\n\nOn Mon, Daniel wrote:\n> original message here';
  const result = topPost(text);
  assert.match(result, /Main reply content/);
  assert.doesNotMatch(result, /Daniel wrote:/);
  assert.doesNotMatch(result, /original message/);
});

test('topPost: returns full text when no quoted tail detected', async () => {
  const { topPost } = await import('../../lib/quote-strip.ts');
  const text = 'Just a plain message with no quoting.';
  const result = topPost(text);
  assert.match(result, /Just a plain message/);
});

test('normalizeBody: HTML body → top-post plain text', async () => {
  const { normalizeBody } = await import('../../lib/body-normalize.ts');
  const html = '<p>Real content here.</p><blockquote><p>On Mon, Daniel wrote:</p><p>original</p></blockquote>';
  const result = normalizeBody({ body: html, mimeType: 'text/html' });
  assert.match(result, /Real content here/);
  assert.doesNotMatch(result, /Daniel wrote:|original/);
  assert.doesNotMatch(result, /<[^>]+>/);
});

test('normalizeBody: plain text body goes directly to topPost (skips htmlToText)', async () => {
  const { normalizeBody } = await import('../../lib/body-normalize.ts');
  const text = 'Plain text.\n\nOn Mon, Daniel wrote:\n> quoted';
  const result = normalizeBody({ body: text });
  assert.match(result, /Plain text/);
  assert.doesNotMatch(result, /Daniel wrote:|quoted/);
});

test('isMachineMail: detects auto-generated headers', async () => {
  const { isMachineMail } = await import('../../lib/machine-mail.ts');
  assert.equal(isMachineMail({ 'Auto-Submitted': 'auto-replied' }), true, 'Auto-Submitted');
  assert.equal(isMachineMail({ Precedence: 'bulk' }), true, 'Precedence: bulk');
  assert.equal(isMachineMail({ 'List-Unsubscribe': '<url>' }), true, 'List-* header');
  assert.equal(isMachineMail({ From: 'human@example.com' }), false, 'normal email');
});

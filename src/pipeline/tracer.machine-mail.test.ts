/**
 * Black-box acceptance test for issue #03 — wire machine-mail junk filter into clean.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * raw gmail blob (bounce, auto-submitted OOO, Precedence:bulk, two human replies) ->
 * clean(root) -> split(root) -> exactly the 3 machine threads quarantined, 0 in
 * outputs/emails/, both human threads (incl. one quoting "out of office" in its BODY)
 * reach outputs/emails/ with seeded verdicts, and the run never throws.
 *
 * Acceptance criteria (issue #03):
 *  1. After clean+split: exactly 3 machine threads in inputs/clean/_quarantine/, 0 in outputs/emails/.
 *  2. Both human threads (incl. the quoting one) reach outputs/emails/ with seeded verdicts.
 *  3. Quarantine count surfaces (H4 counts inputs/clean/_quarantine/*.json) — run does not throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tracer-machine-mail-'));
  mkdirSync(join(root, 'inputs', 'raw'), { recursive: true });
  return root;
}

// Raw GmailThreadFile[] shape (what fetchRecent writes to inputs/raw/gmail.json).
const RAW_GMAIL = [
  // 1. bounce
  {
    threadId: 'thread_bounce_001',
    messages: [
      {
        id: 'm1', threadId: 'thread_bounce_001',
        from: 'Mail Delivery Subsystem <mailer-daemon@mail.example.com>',
        subject: 'Delivery Status Notification (Failure)',
        date: '2026-06-20T10:00:00.000Z',
        text: 'Your message could not be delivered to one or more recipients.',
        isOutbound: false,
        attachments: [],
        headers: { 'return-path': '<>' },
      },
    ],
  },
  // 2. auto-submitted OOO
  {
    threadId: 'thread_ooo_002',
    messages: [
      {
        id: 'm2', threadId: 'thread_ooo_002',
        from: 'Maria Editor <maria@revista.com>',
        subject: 'Automatic reply: Re: Guest post pitch',
        date: '2026-06-21T09:00:00.000Z',
        text: 'I am currently unavailable and will respond when I return.',
        isOutbound: false,
        attachments: [],
        headers: { 'auto-submitted': 'auto-replied' },
      },
    ],
  },
  // 3. Precedence: bulk (list mail)
  {
    threadId: 'thread_bulk_003',
    messages: [
      {
        id: 'm3', threadId: 'thread_bulk_003',
        from: 'newsletter@publisher.com',
        subject: 'Weekly roundup — top stories',
        date: '2026-06-22T09:00:00.000Z',
        text: 'Check out this week\'s top stories from our network.',
        isOutbound: false,
        attachments: [],
        headers: { precedence: 'bulk' },
      },
    ],
  },
  // 4. human reply — plain, must survive
  {
    threadId: 'thread_human_004',
    messages: [
      {
        id: 'm4', threadId: 'thread_human_004',
        from: 'Carlos Reyes <carlos@diario.cl>',
        subject: 'Re: Rate enquiry',
        date: '2026-06-23T09:00:00.000Z',
        text: 'We accept 150 USD per placement, no restrictions on niche.',
        isOutbound: false,
        attachments: [],
        headers: {},
      },
    ],
  },
  // 5. human reply that QUOTES "out of office" inside the body — must still survive
  {
    threadId: 'thread_human_quote_005',
    messages: [
      {
        id: 'm5a', threadId: 'thread_human_quote_005',
        from: 'agent@us.com',
        subject: 'Guest post opportunity',
        date: '2026-06-20T08:00:00.000Z',
        text: 'Hi, following up on our pitch.',
        isOutbound: true,
        attachments: [],
        headers: {},
      },
      {
        id: 'm5b', threadId: 'thread_human_quote_005',
        from: 'Sofia Lopez <sofia@medio.com>',
        subject: 'Re: Guest post opportunity',
        date: '2026-06-24T09:00:00.000Z',
        text:
          'Sorry for the delay, I was out of office last week but I am back now. ' +
          'We can proceed with 130 USD per post.\n\n' +
          'On Fri, 20 Jun 2026, agent@us.com wrote:\n> Hi, following up on our pitch.',
        isOutbound: false,
        attachments: [],
        headers: {},
      },
    ],
  },
];

const MACHINE_IDS = ['thread_bounce_001', 'thread_ooo_002', 'thread_bulk_003'];
const HUMAN_IDS = ['thread_human_004', 'thread_human_quote_005'];

test('tracer.machine-mail: bounce/OOO/bulk quarantined, human threads (incl. body-quoting one) reach outputs/emails with seeded verdicts, run never throws', async () => {
  const { clean } = await import('./clean/index.ts');
  const { split } = await import('./split.ts');

  const root = makeRoot();
  writeFileSync(join(root, 'inputs', 'raw', 'gmail.json'), JSON.stringify(RAW_GMAIL));

  // Run does not throw (node:test fails the test if these reject).
  await clean(root);
  await split(root);

  // 1. exactly the 3 machine threads are quarantined, 0 in outputs/emails/
  const quarantineDir = join(root, 'inputs', 'clean', '_quarantine');
  assert.ok(existsSync(quarantineDir), 'quarantine dir exists');
  const quarantinedFiles = readdirSync(quarantineDir).filter((f) => f.endsWith('.json'));
  assert.equal(quarantinedFiles.length, 3, 'exactly 3 machine threads quarantined');
  for (const id of MACHINE_IDS) {
    assert.ok(quarantinedFiles.includes(`${id}.json`), `${id} is quarantined`);
  }

  const emailsDir = join(root, 'outputs', 'emails', 'gmail');
  for (const id of MACHINE_IDS) {
    assert.ok(!existsSync(join(emailsDir, `${id}.json`)), `${id} did NOT reach outputs/emails/`);
  }

  const cleanGmail = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'gmail.json'), 'utf8'));
  const cleanIds = cleanGmail.map((t: { id: string }) => t.id);
  for (const id of MACHINE_IDS) {
    assert.ok(!cleanIds.includes(id), `${id} not present in inputs/clean/gmail.json`);
  }

  // 2. both human threads reach outputs/emails/ with seeded verdicts
  for (const id of HUMAN_IDS) {
    const threadFile = join(emailsDir, `${id}.json`);
    const verdictFile = join(emailsDir, `${id}.verdict.json`);
    assert.ok(existsSync(threadFile), `${id} thread file exists in outputs/emails/`);
    assert.ok(existsSync(verdictFile), `${id} verdict seeded in outputs/emails/`);

    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8'));
    assert.equal(verdict.thread_id, id, 'seeded verdict thread_id matches');
    assert.equal(verdict.label, null, 'seeded verdict label starts null (not yet classified)');
  }

  // The body-quoting human thread: the phrase "out of office" survives in its body (proves
  // the gate checked headers/subject, not body — human sender untouched even though they
  // quote a machine phrase), and the quoted OUTBOUND tail is stripped by normalizeBody.
  const quotingThread = JSON.parse(readFileSync(join(emailsDir, 'thread_human_quote_005.json'), 'utf8'));
  const inboundMsg = quotingThread.messages.find((m: { isOutbound: boolean }) => !m.isOutbound);
  const quotingBody: string = inboundMsg.body;
  assert.match(quotingBody, /out of office/i, 'quoted OOO phrase remains in the human body');
  assert.doesNotMatch(quotingBody, /following up on our pitch/, 'quoted outbound tail stripped by top-post');

  // 3. quarantine count surfaces for the H4 path (same dir orchestrator/spine.ts counts)
  const h4Count = readdirSync(quarantineDir).filter((f) => f.endsWith('.json')).length;
  assert.equal(h4Count, 3, 'H4 quarantine count reflects the 3 machine threads');
});

test('tracer.machine-mail: different data — a second bounce sender (postmaster@) and a second bulk newsletter are also caught, not hardcoded to the first fixture', async () => {
  const { clean } = await import('./clean/index.ts');

  const root = makeRoot();
  const rawGmail = [
    {
      threadId: 'thread_bounce_alt',
      messages: [{
        id: 'a1', threadId: 'thread_bounce_alt',
        from: 'postmaster@othercorp.io',
        subject: 'Undeliverable: Your message',
        date: '2026-06-25T10:00:00.000Z',
        text: 'Delivery has failed permanently.',
        isOutbound: false,
        attachments: [],
        headers: {},
      }],
    },
    {
      threadId: 'thread_human_alt',
      messages: [{
        id: 'a2', threadId: 'thread_human_alt',
        from: 'Nina Petrova <nina@othermag.com>',
        subject: 'Re: Collaboration',
        date: '2026-06-26T10:00:00.000Z',
        text: 'Happy to collaborate, our rate is 90 USD.',
        isOutbound: false,
        attachments: [],
        headers: {},
      }],
    },
  ];
  writeFileSync(join(root, 'inputs', 'raw', 'gmail.json'), JSON.stringify(rawGmail));

  await clean(root);

  const quarantineDir = join(root, 'inputs', 'clean', '_quarantine');
  const quarantined = existsSync(quarantineDir) ? readdirSync(quarantineDir) : [];
  assert.ok(quarantined.includes('thread_bounce_alt.json'), 'postmaster@ bounce quarantined (not hardcoded to mailer-daemon@ fixture)');

  const cleanGmail = JSON.parse(readFileSync(join(root, 'inputs', 'clean', 'gmail.json'), 'utf8'));
  assert.ok(cleanGmail.some((t: { id: string }) => t.id === 'thread_human_alt'), 'unrelated human thread still cleaned');
});

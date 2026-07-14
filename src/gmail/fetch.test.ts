/**
 * Black-box acceptance tests for issue #03 — Gmail thread discover-then-hydrate.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * query shape, threads.get format:full, messages[] sorted oldest→newest, isOutbound
 * from labelIds, HTML fallback, and attachment metadata. Gmail client is the one stubbed
 * boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecent, type GmailThreadFile } from './fetch.ts';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function stubGmail() {
  const listCalls: any[] = [];
  const getCalls: any[] = [];

  // t1: 2 messages (outbound sent first, inbound reply second) — tests isOutbound + ordering
  // t2: 1 plain-text message + attachment
  // t3: 1 HTML-only message — tests stripHtml fallback
  const THREADS: Record<string, any> = {
    t1: {
      id: 't1',
      messages: [
        {
          id: 'g1a', threadId: 't1',
          labelIds: ['SENT'],
          internalDate: '1750000000000',
          payload: {
            headers: [
              { name: 'From', value: 'agent@us.com' },
              { name: 'Subject', value: 'OKB rate enquiry' },
              { name: 'Date', value: 'Mon, 15 Jun 2026 08:00:00 +0000' },
            ],
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('our outbound email') } },
            ],
          },
        },
        {
          id: 'g1b', threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1750000200000',
          payload: {
            headers: [
              { name: 'From', value: 'Ana Reyes <ana@diario.cl>' },
              { name: 'Subject', value: 'Re: OKB rate enquiry' },
              { name: 'Date', value: 'Mon, 15 Jun 2026 10:00:00 +0000' },
            ],
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('We accept 120 USD per placement.') } },
            ],
          },
        },
      ],
    },
    t2: {
      id: 't2',
      messages: [
        {
          id: 'g2', threadId: 't2',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1750001000000',
          payload: {
            headers: [
              { name: 'From', value: 'Beto <beto@news.mx>' },
              { name: 'Subject', value: 'Publication link' },
              { name: 'Date', value: 'Tue, 16 Jun 2026 09:00:00 +0000' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('PLAIN body two — direct') } },
              {
                mimeType: 'application/pdf',
                filename: 'contract.pdf',
                headers: [{ name: 'Content-Disposition', value: 'attachment; filename="contract.pdf"' }],
                body: { attachmentId: 'att-abc123', size: 12345 },
              },
            ],
          },
        },
      ],
    },
    t3: {
      id: 't3',
      messages: [
        {
          id: 'g3', threadId: 't3',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1750002000000',
          payload: {
            headers: [
              { name: 'From', value: 'Mercadeo NAM <mkt@news.com>' },
              { name: 'Subject', value: 'Re: Article link' },
              { name: 'Date', value: 'Wed, 17 Jun 2026 19:11:08 +0000' },
            ],
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'multipart/related',
                parts: [
                  { mimeType: 'text/html', body: { data: b64url('<div>Aqu&iacute; est&aacute; el enlace:</div><p>Feliz tarde.</p><br>Enviado desde mi iPhone') } },
                  { mimeType: 'image/png', body: { size: 76097 } },
                ],
              },
            ],
          },
        },
      ],
    },
  };

  const gmail = {
    users: {
      threads: {
        list: async (params: any) => {
          listCalls.push(params);
          return { data: { threads: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] } };
        },
        get: async (params: any) => {
          getCalls.push(params);
          return { data: THREADS[params.id] };
        },
      },
    },
  };
  return { gmail, listCalls, getCalls };
}

async function run() {
  const { gmail, listCalls, getCalls } = stubGmail();
  const threads = await fetchRecent({ gmail: gmail as any });
  return { threads, listCalls, getCalls };
}

test('query uses threads.list with is:unread in:inbox — no date window, no curly-brace OR', async () => {
  const { listCalls } = await run();
  assert.ok(listCalls.length >= 1, 'threads.list was called');
  const q: string = listCalls[0].q;
  assert.match(q, /is:unread/, 'unread flag');
  assert.match(q, /in:inbox/, 'inbox flag');
  assert.doesNotMatch(q, /after:/, 'no after: date bound');
  assert.doesNotMatch(q, /before:/, 'no before: date bound');
  assert.doesNotMatch(q, /\{/, 'no curly-brace OR grouping');
});

test('threads.get called with format:full for each discovered thread', async () => {
  const { getCalls } = await run();
  assert.equal(getCalls.length, 3, 'one get per discovered thread');
  assert.ok(getCalls.every((c) => c.format === 'full'), 'all gets use format:full');
});

test('output is GmailThreadFile[] — one entry per thread, messages[] present', async () => {
  const { threads } = await run();
  assert.equal(threads.length, 3, 'one GmailThreadFile per unread thread');
  assert.ok(threads.every((t: GmailThreadFile) => Array.isArray(t.messages)));
});

test('messages[] sorted oldest→newest by internalDate; multi-message thread carries all', async () => {
  const { threads } = await run();
  const t1 = threads.find((t: GmailThreadFile) => t.threadId === 't1')!;
  assert.equal(t1.messages.length, 2, 'both messages present');
  assert.equal(t1.messages[0]!.id, 'g1a', 'older (outbound) is first');
  assert.equal(t1.messages[1]!.id, 'g1b', 'newer (inbound) is second');
});

test('isOutbound = presence of SENT in labelIds', async () => {
  const { threads } = await run();
  const t1 = threads.find((t: GmailThreadFile) => t.threadId === 't1')!;
  assert.equal(t1.messages[0]!.isOutbound, true, 'SENT message is outbound');
  assert.equal(t1.messages[1]!.isOutbound, false, 'INBOX/UNREAD message is inbound');
});

test('text extracted from text/plain part via gmail-api-parse-message', async () => {
  const { threads } = await run();
  const t2 = threads.find((t: GmailThreadFile) => t.threadId === 't2')!;
  const msg = t2.messages[0]!;
  assert.match(msg.text, /PLAIN body two — direct/);
  assert.equal(msg.from, 'Beto <beto@news.mx>');
  assert.equal(msg.subject, 'Publication link');
});

test('HTML-only email falls back to stripped text/html', async () => {
  const { threads } = await run();
  const t3 = threads.find((t: GmailThreadFile) => t.threadId === 't3')!;
  const msg = t3.messages[0]!;
  assert.match(msg.text, /Feliz tarde\./, 'html body stripped to readable text');
  assert.match(msg.text, /Enviado desde mi iPhone/, '<br> preserved as line break');
  assert.doesNotMatch(msg.text, /<[^>]+>/, 'no raw HTML tags in output');
});

test('attachments[] extracted from message parts', async () => {
  const { threads } = await run();
  const t2 = threads.find((t: GmailThreadFile) => t.threadId === 't2')!;
  const msg = t2.messages[0]!;
  assert.equal(msg.attachments.length, 1, 'one attachment detected');
  assert.equal(msg.attachments[0]!.filename, 'contract.pdf');
  assert.equal(msg.attachments[0]!.mimeType, 'application/pdf');
  assert.equal(msg.attachments[0]!.size, 12345);
  assert.equal(msg.attachments[0]!.attachmentId, 'att-abc123');
});

test('messages without attachments carry an empty attachments[]', async () => {
  const { threads } = await run();
  const t3 = threads.find((t: GmailThreadFile) => t.threadId === 't3')!;
  assert.deepEqual(t3.messages[0]!.attachments, [], 'HTML-only message has no attachments');
});

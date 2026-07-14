/**
 * Black-box acceptance tests for issue #04 — reply.io source:inbox + lastActivityDate.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * the returned items (full inbound body, lastActivityDate idempotency key) and the
 * request shape (source:"inbox", from≥refDate−2d). HTTP is the one stubbed boundary.
 *
 * Acceptance criteria (issue #04):
 *  - Request body: source:'inbox', channels:['email'], from ≥ today−2d
 *  - Per-thread messages preserved (newest inbound body resolved)
 *  - Idempotency key = id + lastActivityDate (both exposed on ReplyItem)
 *  - Changes isolated to src/replyio/*
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUnreadReplies, type ReplyItem } from './fetch.ts';

const THREADS = {
  items: [
    {
      id: 101, channel: 'email', isRead: false, subject: 'Re: OKB rate',
      bodyPreview: 'snippet-only preview A', lastActivityDate: '2026-06-15T10:00:00Z',
      contact: { fullName: 'Ana Reyes', email: 'ana@diario.cl', companyName: 'Diario Cl' },
      status: { state: 'open' },
    },
    {
      id: 202, channel: 'email', isRead: false, subject: 'Re: publication link',
      bodyPreview: 'snippet-only preview B', lastActivityDate: '2026-06-16T09:00:00Z',
      contact: { fullName: 'Beto Soto', email: 'beto@news.mx', companyName: 'News MX' },
      status: { state: 'open' },
    },
  ],
  hasMore: false,
};

const MESSAGES: Record<number, unknown> = {
  101: {
    items: [
      { isOutbound: true, body: 'OUR outbound — must be ignored', fromAddress: 'agent@us.com', subject: 'OKB rate', date: '2026-06-14T08:00:00Z' },
      { isOutbound: false, body: '<p>We can accept 120 USD per placement. — Ana</p>', fromAddress: 'ana@diario.cl', subject: 'Re: OKB rate', date: '2026-06-15T10:00:00Z' },
    ],
  },
  202: {
    items: [
      { isOutbound: false, body: 'Published, the live link is https://news.mx/post-9', fromAddress: 'beto@news.mx', subject: 'Re: publication link', date: '2026-06-16T09:00:00Z' },
    ],
  },
};

function jsonRes(o: unknown): Response {
  return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function recordedFetcher() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    if (url.includes('/inbox/threads/filter')) return jsonRes(THREADS);
    const m = url.match(/\/inbox\/threads\/(\d+)\/messages/);
    if (m) return jsonRes(MESSAGES[Number(m[1])]);
    return new Response('unexpected ' + url, { status: 404 });
  };
  return { fetcher, calls };
}

async function run() {
  const { fetcher, calls } = recordedFetcher();
  const items = await fetchUnreadReplies({ apiKey: 'test-key', refDate: '2026-06-24', fetcher });
  return { items, calls };
}

test('returns one item per thread with the FULL inbound body (not the snippet preview)', async () => {
  const { items } = await run();
  assert.equal(items.length, 2, 'one item per thread, fetch-all');

  const a = items.find((i: ReplyItem) => i.id === '101')!;
  assert.equal(a.source, 'replyio');
  assert.match(a.body, /accept 120 USD/, 'full inbound body resolved via drill-in');
  assert.doesNotMatch(a.body, /snippet-only/, 'must NOT be the thread bodyPreview snippet');
  assert.doesNotMatch(a.body, /OUR outbound/, 'must NOT pick the outbound message');
  assert.equal(a.email, 'ana@diario.cl');
  assert.equal(a.company, 'Diario Cl');
  assert.equal(a.from, 'ana@diario.cl');

  const b = items.find((i: ReplyItem) => i.id === '202')!;
  assert.match(b.body, /news\.mx\/post-9/, 'second thread full body');
  assert.equal(b.company, 'News MX');
});

test('request uses source:inbox, channels:["email"], from≥refDate−2d — never source:unread', async () => {
  const { calls } = await run();
  const filter = calls.find((c) => c.url.includes('/inbox/threads/filter'))!;
  assert.ok(filter, 'a filter call was made');
  assert.match(filter.url, /api\.reply\.io\/v3\/inbox\/threads\/filter/, 'v3 plane');
  assert.equal(filter.method, 'POST');
  assert.equal(filter.headers['Authorization'], 'Bearer test-key', 'Bearer auth');
  assert.equal(filter.body.source, 'inbox', 'source must be inbox, not unread');
  assert.deepEqual(filter.body.channels, ['email']);
  // from = refDate(2026-06-24) − 2d = 2026-06-22
  assert.ok(filter.body.from, 'from param present');
  assert.match(String(filter.body.from), /2026-06-22/, 'from = refDate − 2 days');

  assert.ok(!calls.some((c: any) => /\/v1\//.test(c.url)), 'no v1 call');
  assert.ok(!calls.some((c: any) => /people/.test(c.url)), 'no contacts/people read');
});

test('full body resolved through the per-thread messages drill-in endpoint', async () => {
  const { calls } = await run();
  const drills = calls.filter((c) => /\/inbox\/threads\/\d+\/messages/.test(c.url));
  assert.equal(drills.length, 2, 'one drill-in per thread');
  assert.ok(drills.every((c) => c.method === 'GET'));
});

test('idempotency: lastActivityDate exposed on each ReplyItem', async () => {
  const { items } = await run();
  const a = items.find((i: ReplyItem) => i.id === '101')!;
  assert.equal(a.lastActivityDate, '2026-06-15T10:00:00Z', 'thread lastActivityDate preserved');
  const b = items.find((i: ReplyItem) => i.id === '202')!;
  assert.equal(b.lastActivityDate, '2026-06-16T09:00:00Z');
});

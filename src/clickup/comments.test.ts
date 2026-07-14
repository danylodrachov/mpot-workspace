/**
 * Black-box acceptance test for issue #50 — attach the FULL ClickUp comment thread per task.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only: the
 * complete, deduped, oldest-first thread that `fetchAllComments` returns from a paged source.
 * HTTP is the one stubbed boundary — no live ClickUp call.
 *
 * Acceptance criteria (issue #50):
 *  - comments = the COMPLETE thread (all pages + all replies), deduped, oldest-first
 *  - stores comment_text (flat), plus parent to preserve threading
 *  - replies fetched only when reply_count>0; both endpoints paged via start + start_id
 *  - HTTP boundary injectable for the test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllComments, type StoredComment } from './fetch.ts';

const PAGE = 25; // ClickUp returns the 25 newest, reverse-chron; "< 25" = last page.

/** 25 newest-first top-level comments c1..c25 (c1 newest → highest date). c2 has 2 replies. */
function page1() {
  const items = [];
  for (let i = 1; i <= PAGE; i++) {
    items.push({
      id: `c${i}`,
      comment_text: `flat text c${i}`,
      comment: [{ text: `fragment c${i} — NOT what we store` }],
      user: { id: 700 + i, username: `user${i}` },
      date: String(3000 - i), // c1=2999 (newest) … c25=2975 (oldest of page 1)
      resolved: false,
      reply_count: i === 2 ? 2 : 0,
    });
  }
  return items;
}

// Page 2: cursor (oldest of page 1 = c25) reappears as the boundary, then c26, c27 (< 25 → stop).
const page2 = [
  { id: 'c25', comment_text: 'flat text c25', comment: [], user: { id: 725, username: 'user25' }, date: '2975', resolved: false, reply_count: 0 },
  { id: 'c26', comment_text: 'flat text c26', comment: [], user: { id: 726, username: 'user26' }, date: '2974', resolved: true, reply_count: 0 },
  { id: 'c27', comment_text: 'flat text c27', comment: [], user: { id: 727, username: 'user27' }, date: '2973', resolved: false, reply_count: 0 },
];

const replies = [
  { id: 'r1', comment_text: 'reply one', comment: [], user: { id: 800, username: 'rep1' }, date: '2950', resolved: false, reply_count: 0 },
  { id: 'r2', comment_text: 'reply two', comment: [], user: { id: 801, username: 'rep2' }, date: '2949', resolved: false, reply_count: 0 },
];

function jsonRes(o: unknown): Response {
  return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function recordedFetcher() {
  const calls: string[] = [];
  const fetcher = async (url: string, _init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    const hasStart = u.searchParams.has('start');

    if (/\/task\/T1\/comment$/.test(u.pathname)) {
      return jsonRes({ comments: hasStart ? page2 : page1() });
    }
    if (/\/comment\/c2\/reply$/.test(u.pathname)) {
      return jsonRes({ comments: hasStart ? [] : replies }); // < 25 → single page
    }
    return new Response('unexpected ' + url, { status: 404 });
  };
  return { fetcher, calls };
}

async function run() {
  const { fetcher, calls } = recordedFetcher();
  const thread = await fetchAllComments({ taskId: 'T1', token: 'test-token', fetcher });
  return { thread, calls };
}

test('returns the COMPLETE thread: all pages + replies, deduped, oldest-first', async () => {
  const { thread } = await run();

  // 27 unique top-level (c25 boundary deduped, not 28) + 2 replies = 29.
  assert.equal(thread.length, 29, 'all pages + replies, deduped');
  const ids = thread.map((c: StoredComment) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids (boundary c25 deduped)');
  assert.ok(ids.includes('c27'), 'page-2 comment present');
  assert.ok(ids.includes('r1') && ids.includes('r2'), 'replies present');

  // Oldest-first: dates ascending by Number(date).
  for (let i = 1; i < thread.length; i++) {
    assert.ok(
      Number(thread[i - 1]!.date) <= Number(thread[i]!.date),
      `ascending by date at ${i}: ${thread[i - 1]!.date} <= ${thread[i]!.date}`,
    );
  }
});

test('stores flat comment_text + threading parent; replies tagged with their parent', async () => {
  const { thread } = await run();
  const c1 = thread.find((c: StoredComment) => c.id === 'c1')!;
  assert.equal(c1.comment_text, 'flat text c1', 'flat comment_text, not the fragment array');
  assert.equal(c1.parent, null, 'top-level parent is null');
  assert.equal(typeof c1.comment_text, 'string');

  const r1 = thread.find((c: StoredComment) => c.id === 'r1')!;
  assert.equal(r1.parent, 'c2', 'reply carries its parent comment id');
  assert.equal(r1.comment_text, 'reply one');

  const c26 = thread.find((c: StoredComment) => c.id === 'c26')!;
  assert.equal(c26.resolved, true, 'resolved flag preserved');
});

test('replies fetched ONLY for comments with reply_count>0; both endpoints paged', async () => {
  const { calls } = await run();
  const replyCalls = calls.filter((u) => /\/comment\/\w+\/reply/.test(u));
  // Only c2 has reply_count>0 → exactly one reply thread fetched (it fit in one page).
  assert.ok(replyCalls.every((u) => /\/comment\/c2\/reply/.test(u)), 'only c2 replies fetched');
  assert.ok(!calls.some((u) => /\/comment\/c1\/reply/.test(u)), 'no reply call for reply_count:0');

  // Top-level paged via start + start_id (page 2 carried both).
  const pagedTop = calls.find((u) => /\/task\/T1\/comment/.test(u) && /[?&]start=/.test(u));
  assert.ok(pagedTop, 'second top-level page requested with start cursor');
  assert.match(pagedTop!, /start_id=/, 'start_id cursor present alongside start');
});

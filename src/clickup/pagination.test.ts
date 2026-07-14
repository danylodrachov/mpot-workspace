/**
 * Black-box acceptance test for issue #51 — ClickUp pagination + subtasks/include_closed.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only: a >100
 * task day is NOT silently truncated (all pages concatenated), and the operator's
 * subtasks/include_closed decision rides on the request. HTTP is the one stubbed boundary.
 *
 * Operator decision (issue #51): subtasks=true (a revision subtask is still agent work),
 * include_closed OFF (a "touched recently" set is open-only).
 *
 * Acceptance criteria (issue #51):
 *  - Fetches all pages (loop until a page < 100), no silent truncation
 *  - subtasks / include_closed set per the operator decision
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTasks } from './fetch.ts';

/** n outreach tasks (board recognised via list name) so none are dropped. */
function mkTasks(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    name: `Task ${prefix}${i}`,
    status: { status: 'negotiation' },
    due_date: null,
    assignees: [{ id: 1234, username: 'Danylo Drachov' }],
    list: { name: 'Outreach kanban board' },
  }));
}

function jsonRes(o: unknown): Response {
  return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function recordedFetcher() {
  const teamCalls: string[] = [];
  const fetcher = async (url: string, _init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (/\/team\/\d+\/task$/.test(u.pathname)) {
      teamCalls.push(url);
      const page = u.searchParams.get('page');
      if (page === '0') return jsonRes({ tasks: mkTasks('a', 100) }); // full page → keep going
      if (page === '1') return jsonRes({ tasks: mkTasks('b', 30) }); // < 100 → last page
      return jsonRes({ tasks: [] });
    }
    if (/\/comment$/.test(u.pathname)) return jsonRes({ comments: [] }); // no comments in this scenario
    return new Response('unexpected ' + url, { status: 404 });
  };
  return { fetcher, teamCalls };
}

async function run() {
  const { fetcher, teamCalls } = recordedFetcher();
  const items = await fetchTasks({
    teamId: '700',
    token: 'test-token',
    query: { assignees: ['1234'], updatedGt: 1, updatedLt: 2 },
    fetcher,
  });
  return { items, teamCalls };
}

test('fetches ALL pages — a >100-task day is not silently truncated', async () => {
  const { items, teamCalls } = await run();
  assert.equal(items.length, 130, 'page 0 (100) + page 1 (30) concatenated');
  assert.equal(teamCalls.length, 2, 'looped page 0 then page 1, stopped at < 100');
  const pages = teamCalls.map((u) => new URL(u).searchParams.get('page'));
  assert.deepEqual(pages, ['0', '1'], 'incrementing page cursor');
});

test('carries the operator decision: subtasks=true, include_closed OFF', async () => {
  const { teamCalls } = await run();
  const url = teamCalls[0]!;
  assert.match(url, /subtasks=true/, 'subtasks included (revision subtask is agent work)');
  assert.doesNotMatch(url, /include_closed=true/, 'closed tasks excluded — open-only working set');
});

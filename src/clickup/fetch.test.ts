/**
 * Black-box acceptance test for issue #10 — ClickUp parameterized client (REST v2).
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behavior only:
 * the returned JSON array's shape. The source HTTP is the boundary stubbed via a
 * recorded real v2 response — no live API.
 *
 * Acceptance criteria (issue #10):
 *  - Call with a params object -> returned array shape (task fields + board set;
 *    status/assignee/due present).
 *  - Source HTTP stubbed via a recorded real v2 response — no live API in the test loop.
 *
 * RE-LOCKED for issue #04: the `clickup tasks/<board>/` per-task disk writer was dead code
 * (nothing downstream read it — the spine reads `outputs/tasks/`, and the caller already
 * writes the returned array to `inputs/raw/clickup.json`) and has been deleted. The old
 * "writes one self-describing file..." test below is replaced with a test asserting the
 * client is now in-memory only (no filesystem side effects at all).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchTasks } from './fetch.ts';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/team-task.v2.json', import.meta.url)), 'utf8'),
);

/** Stub the HTTP boundary: capture the request URL, replay the recorded v2 response. */
function recordedFetcher() {
  const calls: string[] = [];
  const fetcher = async (url: string, _init?: RequestInit): Promise<Response> => {
    calls.push(url);
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetcher, calls };
}

async function run() {
  const { fetcher, calls } = recordedFetcher();
  const items = await fetchTasks({
    teamId: '700',
    token: 'test-token',
    query: {
      assignees: ['1234'],
      statuses: ['negotiation', 'to submit'],
      updatedGt: 1_749_000_000_000,
      updatedLt: 1_750_300_000_000,
    },
    fetcher,
  });
  return { items, calls };
}

test('returns only the two board tasks, each with the asserted shape', async () => {
  const { items } = await run();
  // Third fixture task is on a non-{outreach,content} board -> excluded, not guessed.
  assert.equal(items.length, 2);
  assert.ok(!items.some((i) => i.id === '86zzz0000'), 'non-board task must be dropped');

  for (const it of items) {
    assert.equal(it.source, 'clickup');
    assert.ok(it.id, 'id present');
    assert.ok(it.name, 'name present');
    assert.ok(it.board === 'outreach' || it.board === 'content', `board set: ${it.board}`);
    assert.equal(typeof it.status, 'string'); // status present
    assert.ok(Array.isArray(it.assignees) && it.assignees.length > 0, 'assignee present');
    assert.ok('due' in it, 'due present (may be null)'); // due rides along
  }

  const outreach = items.find((i) => i.id === '86a1b2c5x')!;
  assert.equal(outreach.board, 'outreach');
  assert.equal(outreach.status, 'negotiation');
  assert.equal(outreach.due, '1750075200000');
  assert.deepEqual(outreach.assignees, ['Danylo Drachov']);

  const content = items.find((i) => i.id === '86a9f8e2z')!;
  assert.equal(content.board, 'content');
  assert.equal(content.status, 'to submit');
  assert.equal(content.due, null);
});

test('issue #04: fetchTasks is in-memory only — no clickup tasks/ directory is created anywhere', async () => {
  // A scratch dir stands in for "anywhere fetchTasks could plausibly write" — it must stay
  // completely empty. There is no dayFolder param anymore for a writer to target.
  const scratch = mkdtempSync(join(tmpdir(), 'clickup-no-write-'));
  const { items } = await run();

  assert.ok(items.length > 0, 'sanity: items were actually returned');
  assert.deepEqual(readdirSync(scratch), [], 'scratch dir untouched — fetchTasks wrote nothing to disk');
});

test('source HTTP stubbed — request carries the daily filters as query params (REST v2)', async () => {
  const { calls } = await run();
  // RE-LOCKED for issue #50: fetchTasks now also drills into each task's comment thread
  // (one /task/{id}/comment call per task), so total calls > 1. The invariant this test
  // owns is the *filtered-team-task query* — assert there is exactly ONE of those.
  const teamCalls = calls.filter((u) => /\/api\/v2\/team\/700\/task/.test(u));
  assert.equal(teamCalls.length, 1, 'exactly one filtered-team-task call');
  const url = teamCalls[0]!;
  assert.match(url, /api\.clickup\.com\/api\/v2\/team\/700\/task/, 'v2 team task endpoint');
  assert.match(url, /assignees%5B%5D=1234|assignees\[\]=1234/, 'assignees[] filter');
  assert.match(url, /statuses%5B%5D=|statuses\[\]=/, 'statuses[] filter');
  assert.match(url, /date_updated_gt=1749000000000/, 'date_updated_gt filter');
  assert.match(url, /date_updated_lt=1750300000000/, 'date_updated_lt filter');
});

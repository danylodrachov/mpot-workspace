/**
 * tracer.slim (issue #04) — black-box acceptance test locked BEFORE the implementation
 * (Ralph gate 1). Drives the real clean() → split() → runSpine() pipeline over the existing
 * golden tracer fixtures (src/pipeline/__fixtures__/tracer/) and the real fetchTasks() client,
 * asserting external behavior only.
 *
 * Acceptance criteria (issue #04):
 *  1. Full run (clean → split → runSpine with fake spawner) produces the same spawn set as
 *     before, WITHOUT any fetch-manifest.json existing at any point.
 *  2. A replyio verdict seeded from a fixture whose raw carries sequence.name: "X" has
 *     "sequence": "X".
 *  3. bin/run-messaging-flow.sh and the `clickup tasks/` output no longer exist after a run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clean } from '../pipeline/clean/index.ts';
import { split } from '../pipeline/split.ts';
import { runSpine } from './spine.ts';
import { fetchTasks } from '../clickup/fetch.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixDir = fileURLToPath(new URL('../pipeline/__fixtures__/tracer', import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixDir, name), 'utf8'));
}

function tmpDay(): string {
  const d = mkdtempSync(join(tmpdir(), 'slim-'));
  for (const sub of [
    'inputs/raw',
    'inputs/clean',
    'inputs/clean/_quarantine',
    'outputs/emails/gmail',
    'outputs/emails/replyio',
    'outputs/tasks',
  ]) {
    mkdirSync(join(d, sub), { recursive: true });
  }
  return d;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** True if any path anywhere under `root` contains `needle` (dir or file name). */
function anyPathContains(root: string, needle: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.includes(needle)) return true;
    if (entry.isDirectory() && anyPathContains(join(root, entry.name), needle)) return true;
  }
  return false;
}

// ── #1: no fetch-manifest.json at any point; full spawn waterfall still fires ────
//
// Updated by issue #05: the reply.io (OKB) thread no longer spawns a `claude -p` session per
// step (classify/READ/WRITE) — it gets ONE direct model call (the fake `caller` below). The
// ClickUp task tier is untouched by issue #05 and still spawns via `spawner`.

test('tracer.slim: clean → split → runSpine never creates fetch-manifest.json; full spawn wave still fires', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'inputs/raw/replyio.json'), [readFixture('okb-reply.raw.json')]);
  writeJson(join(dayRoot, 'inputs/raw/clickup.json'), [readFixture('okb-task.raw.json')]);

  await clean(dayRoot);
  assert.ok(!existsSync(join(dayRoot, 'fetch-manifest.json')), 'no manifest after clean()');

  await split(dayRoot);
  assert.ok(!existsSync(join(dayRoot, 'fetch-manifest.json')), 'no manifest after split()');

  const taskVerdictPath = join(dayRoot, 'outputs/tasks/task_okb_001.verdict.json');

  const calls: string[] = [];
  const callerRequests: Array<{ model: string; system: string; user: string }> = [];
  await runSpine(
    dayRoot,
    async (prompt) => {
      calls.push(prompt);

      if (prompt.includes('ClickUp context-former')) {
        const v = JSON.parse(readFileSync(taskVerdictPath, 'utf8')) as Record<string, unknown>;
        v['reasoning'] = 'negotiation in progress';
        writeJson(taskVerdictPath, v);
      }
    },
    4,
    undefined,
    async (req) => {
      callerRequests.push(req);
      return JSON.stringify({
        tc_covered: { pricing: true },
        decision_data: { payment_terms: '150 USD per article' },
        reasoning: 'outlet confirmed price',
        draft: 'Thanks for confirming — sending the draft shortly.',
      });
    },
  );

  assert.ok(!existsSync(join(dayRoot, 'fetch-manifest.json')), 'no manifest ever created, even after runSpine');

  assert.ok(!calls.some((c) => c.includes('classifier')), 'no classify tier for OKB — no spawn at all');
  assert.ok(!calls.some((c) => c.includes('READ pass') || c.includes('WRITE pass')), 'reply.io no longer spawns a session');
  assert.equal(callerRequests.length, 1, 'exactly one direct model call for the fresh letter');
  assert.ok(calls.some((c) => c.includes('ClickUp context-former')), 'clickup-subagent spawned for the fresh task');
});

// ── #2: raw.sequence.name carried into the replyio verdict's sequence field ──────

test('tracer.slim: replyio verdict.sequence carries raw.sequence.name from the raw fetch item', async () => {
  const dayRoot = tmpDay();

  const rawReply = readFixture('okb-reply-sequence.raw.json') as { id: string; subject: string };

  writeJson(join(dayRoot, 'inputs/raw/replyio.json'), [rawReply]);
  // clean() would seed sequence: null (issue #09's fix target) — reproduce that here directly
  // so this test exercises split()'s own raw-sequence carry, not clean()'s.
  writeJson(join(dayRoot, 'inputs/clean/replyio.json'), [{
    id: rawReply.id,
    subject: rawReply.subject,
    sequence: null,
    messages: [{
      date: '2026-06-23T11:05:00Z',
      from: 'alex.nguyen@northwindgear.com',
      isOutbound: false,
      body: "Thanks for reaching out. We'd be happy to run a sponsored post.",
      attachments: [],
    }],
  }]);

  await split(dayRoot);

  const verdict = JSON.parse(
    readFileSync(join(dayRoot, 'outputs/emails/replyio/1002.verdict.json'), 'utf8'),
  ) as { sequence: string | null };

  assert.equal(verdict.sequence, 'Guest Post Outreach — Q3', 'verdict.sequence carries raw.sequence.name');
});

// ── #3: dead flows are gone ───────────────────────────────────────────────────

test('tracer.slim: bin/run-messaging-flow.sh no longer exists', () => {
  assert.ok(!existsSync(join(REPO_ROOT, 'bin/run-messaging-flow.sh')), 'run-messaging-flow.sh deleted');
});

test('tracer.slim: a full day run never produces a "clickup tasks" output anywhere', async () => {
  const dayRoot = tmpDay();

  // Real fetchTasks() client, HTTP stubbed with a recorded v2 response — this is the boundary
  // the old writer used to target with a `dayFolder` arg; that arg no longer exists on the
  // interface, and the call must leave no trace anywhere under dayRoot.
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('../clickup/__fixtures__/team-task.v2.json', import.meta.url)), 'utf8'),
  );
  const items = await fetchTasks({
    teamId: '700',
    token: 'test-token',
    query: { assignees: ['1234'] },
    fetcher: async () =>
      new Response(JSON.stringify(fixture), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  writeJson(join(dayRoot, 'inputs/raw/clickup.json'), items);
  assert.ok(!anyPathContains(dayRoot, 'clickup tasks'), 'no clickup tasks/ dir after fetchTasks + raw write');

  await clean(dayRoot);
  await split(dayRoot);
  await runSpine(dayRoot, async () => {});

  assert.ok(!anyPathContains(dayRoot, 'clickup tasks'), 'no clickup tasks/ dir anywhere after a full run');
});

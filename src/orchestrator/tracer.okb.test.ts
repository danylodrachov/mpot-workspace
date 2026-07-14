/**
 * tracer.okb (issue #05) — locked BEFORE the implementation (Ralph gate 1).
 * Black-box: drives the REAL orchestrator entrypoint (`runOrcOnce` — registry + freshness
 * filter + clean + split + runSpine) over a fixture day with 2 outreach letters:
 *  - a brand-new contact (no prior registry entry at all)
 *  - a thread whose registry entry the operator already PRE-SEEDED with a `task_id` (manual
 *    card mapping), which this run's card-status mismatch reprocesses.
 * A fake `caller` records full request payloads and returns plausible verdict JSON; a fake
 * `spawner` records any `claude -p`/Claude-Code-session spawn — there must be none for OKB.
 *
 * Acceptance criteria (issue #05):
 *  1. Exactly ONE model call per letter — 2 total; no classify, no reconciler, no task
 *     context-former calls; zero Claude Code sessions spawned.
 *  2. Each recorded request carries a pinned model, the agent prompt, the letter's cleaned
 *     content inline — and NO tool definitions of any kind.
 *  3. The unmapped letter's registry entry ends task_id: null, clickup_status: null; the
 *     pre-seeded letter's request contains the card's content and its entry's clickup_status
 *     is updated to the card's lane.
 *  4. Verdicts end with label: "outreach", non-null tc_covered, reasoning, draft.
 *  5. Re-run over the same day (verdicts complete): zero model calls (resume skip works).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOrcOnce } from '../../bin/run-orc.ts';
import { messageKey, loadRegistry, saveRegistry, type Registry } from '../pipeline/registry.ts';
import type { LlmCallRequest } from '../llm/call.ts';

const fixDir = fileURLToPath(new URL('../pipeline/__fixtures__/tracer', import.meta.url));

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixDir, name), 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tracer-okb-'));
}

function scaffoldDay(root: string, date: string): string {
  const dayRoot = join(root, 'data', date);
  for (const sub of [
    'inputs/raw',
    'inputs/clean',
    'inputs/clean/_quarantine',
    'outputs/emails/gmail',
    'outputs/emails/replyio',
    'outputs/tasks',
  ]) {
    mkdirSync(join(dayRoot, sub), { recursive: true });
  }
  return dayRoot;
}

// letterA (id 1001, VidaTech Blog) is a brand-new contact — no prior registry entry.
const letterA = readFixture('okb-reply.raw.json');
// letterB (id 1002, Northwind Gear) — DIFFERENT contact/company/body, so nothing here is
// hardcoded to letterA's shape; its registry entry is pre-seeded below to simulate a manual
// card mapping the operator made before this run.
const letterB = readFixture('okb-reply-sequence.raw.json');

const CARD_TASK_ID = 'task_okb_002';
const CARD_NAME = 'Northwind Gear — Alex Nguyen';
const CARD_OLD_STATUS = 'Negotiation'; // what the registry recorded last time
const CARD_NEW_STATUS = 'Invoice Request'; // what this run's ClickUp fetch actually shows

function fakeCaller(requests: LlmCallRequest[]) {
  return async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return JSON.stringify({
      tc_covered: { pricing_per_article: true, link_type: false },
      decision_data: { payment_terms: '150 USD per article, bank transfer' },
      reasoning: 'outlet confirmed price; link type still open',
      draft: 'Thanks for the update — could you confirm dofollow vs nofollow for the link?',
    });
  };
}

test('tracer.okb: 2 letters (new + manually-mapped) -> exactly one direct model call each, no sessions', async () => {
  const root = makeRoot();
  const date = '2026-06-24';
  const dayRoot = scaffoldDay(root, date);

  writeJson(join(dayRoot, 'inputs/raw/replyio.json'), [letterA, letterB]);
  writeJson(join(dayRoot, 'inputs/raw/clickup.json'), [
    {
      id: CARD_TASK_ID,
      name: CARD_NAME,
      board: 'outreach',
      status: CARD_NEW_STATUS,
      comments: [{ comment_text: 'Creator confirmed 3-article package.' }],
      raw: { description: 'Outreach to Northwind Gear.' },
    },
  ]);

  // Operator's manual card mapping, made before this run — the pipeline only ever HONORS an
  // existing mapping like this, it never matches/creates one itself.
  const keyB = messageKey('replyio', letterB as unknown as { id: string; raw?: { lastActivityDate?: string } });
  const registry: Registry = loadRegistry(root);
  registry[keyB] = {
    thread_id: String(letterB['id']),
    task_id: CARD_TASK_ID,
    clickup_status: CARD_OLD_STATUS,
    file: null,
    verdict: null,
    redo_draft: null,
  };
  saveRegistry(root, registry);

  // Pre-seed the mapped card's own verdict + reconcile-verdict so the (unrelated) ClickUp task
  // pipeline makes zero calls of its own — this test is only about the OKB letter path.
  writeJson(join(dayRoot, 'outputs/tasks', `${CARD_TASK_ID}.verdict.json`), {
    board: 'outreach', task_id: CARD_TASK_ID, task_name: CARD_NAME, current_lane: CARD_NEW_STATUS,
    decision_data: {}, reasoning: 'pre-filled', user_feedback: null, AI_feedback: null,
  });
  writeJson(join(dayRoot, 'outputs/tasks', `${CARD_TASK_ID}.reconcile-verdict.json`), {
    board: 'okb', task_id: CARD_TASK_ID, current_lane: CARD_NEW_STATUS,
    truthful_signal: 'pre-filled', signals: {
      defined_questions_complete: true, payment_details_received: null, payment_evidence_found: null,
    },
    blocked: false, block_reason: null, dry_run: [],
  });

  const spawnerCalls: string[] = [];
  const callerRequests: LlmCallRequest[] = [];

  await runOrcOnce(
    root,
    date,
    async (prompt) => { spawnerCalls.push(prompt); },
    4,
    fakeCaller(callerRequests),
  );

  // ── #1: exactly one model call per letter, 2 total; zero sessions/spawns of any kind ──
  assert.equal(callerRequests.length, 2, 'exactly one direct model call per letter');
  assert.equal(spawnerCalls.length, 0, 'zero claude -p / Claude Code session spawns (no classify, no reconciler, no task context-former)');

  // ── #2: each request is pinned model + agent prompt + inlined cleaned content, no tools ──
  for (const req of callerRequests) {
    assert.ok(typeof req.model === 'string' && req.model.length > 0, 'request carries a pinned model id');
    assert.match(req.system, /OKB letter agent/, 'request carries the messaging-okb-letter.md prompt body');
    assert.ok(!('tools' in req), 'request carries no tool definitions of any kind');
    const user = JSON.parse(req.user) as { thread: { id: string }; card: unknown };
    assert.ok(user.thread && typeof user.thread.id === 'string', 'request inlines the cleaned letter content');
  }

  const reqA = callerRequests.find((r) => (JSON.parse(r.user) as { thread: { id: string } }).thread.id === '1001');
  const reqB = callerRequests.find((r) => (JSON.parse(r.user) as { thread: { id: string } }).thread.id === '1002');
  assert.ok(reqA, 'letter A (new contact) got a direct call');
  assert.ok(reqB, 'letter B (mapped card) got a direct call');

  const userA = JSON.parse(reqA!.user) as { card: unknown };
  const userB = JSON.parse(reqB!.user) as { card: { name?: string; status?: string } | null };
  assert.equal(userA.card, null, 'unmapped letter A carries no card content');
  assert.ok(userB.card, 'mapped letter B carries card content');
  assert.equal(userB.card!.name, CARD_NAME, "letter B's request contains the mapped card's content");
  assert.equal(userB.card!.status, CARD_NEW_STATUS, "letter B's request contains the card's current lane");

  // ── #3: registry outcomes — unmapped stays null; mapped carries task_id + refreshed status ──
  const registryAfter = loadRegistry(root);
  const keyA = messageKey('replyio', letterA as unknown as { id: string; raw?: { lastActivityDate?: string } });
  assert.equal(registryAfter[keyA].task_id, null, 'unmapped letter: registry task_id stays null');
  assert.equal(registryAfter[keyA].clickup_status, null, 'unmapped letter: registry clickup_status stays null');
  assert.equal(registryAfter[keyB].task_id, CARD_TASK_ID, 'mapped letter: registry keeps the operator-written task_id');
  assert.equal(registryAfter[keyB].clickup_status, CARD_NEW_STATUS, "mapped letter: registry clickup_status updated to the card's lane");

  // ── #4: verdicts end complete ──
  const verdictA = JSON.parse(readFileSync(join(root, registryAfter[keyA].verdict!), 'utf8')) as Record<string, unknown>;
  const verdictB = JSON.parse(readFileSync(join(root, registryAfter[keyB].verdict!), 'utf8')) as Record<string, unknown>;
  for (const v of [verdictA, verdictB]) {
    assert.equal(v['label'], 'outreach', 'verdict.label == "outreach"');
    assert.ok(v['tc_covered'] !== null, 'verdict.tc_covered non-null');
    assert.ok(v['reasoning'] !== null, 'verdict.reasoning non-null');
    assert.ok(v['draft'] !== null, 'verdict.draft non-null');
  }

  // ── #5: re-run over the same day, verdicts complete -> zero model calls (resume) ──
  const spawnerCalls2: string[] = [];
  const callerRequests2: LlmCallRequest[] = [];
  await runOrcOnce(
    root,
    date,
    async (prompt) => { spawnerCalls2.push(prompt); },
    4,
    fakeCaller(callerRequests2),
  );
  assert.equal(callerRequests2.length, 0, 're-run: zero direct model calls (resume skip works)');
  assert.equal(spawnerCalls2.length, 0, 're-run: zero spawns');
});

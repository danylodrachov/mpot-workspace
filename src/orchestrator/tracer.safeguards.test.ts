/**
 * tracer.safeguards (issue #08) — locked BEFORE the implementation (Ralph gate 1).
 * Black-box: drives the real `runSpine` over a fixture day of reply.io (OKB) letters — the
 * only wired direct-model-call path today (sessions/2026-07-02-solution-audit-results.md: the
 * 2026-06-25 incident was a whole tier writing 0 of 45 `reasoning` fields while the run
 * continued silently and later tiers spawned anyway).
 *
 * Acceptance criteria (issue #08):
 *  1. Caller that returns clean JSON but fills nothing (parses to `{}`) → the tier is retried
 *     once, still fills nothing → run result carries a degraded flag, the caller ran exactly
 *     twice, zero reconciler (later-tier) calls, non-zero would-be exit (spine.degraded).
 *  2. Healthy caller (fills reasoning + draft) → no flags, call count === number of letters
 *     (ONE per letter, issue #05).
 *  3. Ceiling set to 3 with 4 pending letters → run halts after exactly 3 calls, Handback flag
 *     present, degraded true, the 4th letter's verdict never got a call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSpine } from './spine.ts';
import type { LlmCallRequest } from '../llm/call.ts';

function tmpDay(): string {
  const d = mkdtempSync(join(tmpdir(), 'safeguards-'));
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

interface OkbVerdictShape {
  source: string | null;
  thread_id: string | null;
  sequence: string | null;
  media: string | null;
  label: string | null;
  tc_covered: Record<string, boolean> | null;
  decision_data: { payment_terms: string | null; ready_for_qa: string | null };
  reasoning: string | null;
  draft: string | null;
  user_feedback: string | null;
  AI_feedback: string | null;
}

/** Seed one reply.io letter thread + its untouched split-shaped verdict. */
function seedLetter(dayRoot: string, id: string): void {
  writeJson(join(dayRoot, 'outputs/emails/replyio', `${id}.json`), {
    id,
    subject: `Re: outreach ${id}`,
    body: `<p>Body for letter ${id}</p>`,
  });
  const verdict: OkbVerdictShape = {
    source: 'replyio',
    thread_id: id,
    sequence: null,
    media: null,
    label: null,
    tc_covered: null,
    decision_data: { payment_terms: null, ready_for_qa: null },
    reasoning: null,
    draft: null,
    user_feedback: null,
    AI_feedback: null,
  };
  writeJson(join(dayRoot, 'outputs/emails/replyio', `${id}.verdict.json`), verdict);
}

function readVerdict(dayRoot: string, id: string): OkbVerdictShape {
  return JSON.parse(
    readFileSync(join(dayRoot, 'outputs/emails/replyio', `${id}.verdict.json`), 'utf8'),
  ) as OkbVerdictShape;
}

// ── #1: empty tier -> retry once -> still empty -> degraded, halted before reconciler ──────

test('tracer.safeguards: caller returns clean JSON but fills nothing -> retried once, then halts degraded', async () => {
  const dayRoot = tmpDay();
  seedLetter(dayRoot, '3001');

  const requests: LlmCallRequest[] = [];
  const emptyCaller = async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return '{}'; // parses clean; fills nothing
  };

  let spawnCount = 0;
  const result = await runSpine(dayRoot, async () => { spawnCount++; }, 4, undefined, emptyCaller);

  assert.equal(requests.length, 2, 'the failing tier ran exactly twice (initial + one retry)');
  assert.ok(result.degraded, 'run result carries the degraded flag');
  assert.ok(
    result.flags.some((f) => f.includes('RUN DEGRADED') && f.includes('wrote nothing')),
    'flags include a RUN DEGRADED ... wrote nothing message',
  );
  assert.equal(spawnCount, 0, 'zero reconciler / later-tier spawns after a halt');

  const verdict = readVerdict(dayRoot, '3001');
  assert.equal(verdict.reasoning, null, 'reasoning never got filled by the empty caller');
  assert.equal(verdict.draft, null, 'draft never got filled by the empty caller');
});

// ── #2: healthy caller -> no flags, call count == letters (ONE per letter) ─────────────────

test('tracer.safeguards: healthy caller -> no flags, model call count == one per letter', async () => {
  const dayRoot = tmpDay();
  seedLetter(dayRoot, '3002');
  seedLetter(dayRoot, '3003');

  const requests: LlmCallRequest[] = [];
  const healthyCaller = async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return JSON.stringify({
      tc_covered: { pricing: true },
      decision_data: { payment_terms: '100 USD' },
      reasoning: 'outlet confirmed price',
      draft: 'Thanks — confirming the details now.',
    });
  };

  const result = await runSpine(dayRoot, async () => {}, 4, undefined, healthyCaller);

  assert.equal(result.degraded, false, 'healthy run is never degraded');
  assert.deepEqual(result.flags, [], 'no flags on a healthy run');
  assert.equal(requests.length, 2, 'exactly one direct model call per letter');
  assert.equal(result.modelCallCount, 2, 'reported call count == 2 (one per letter)');

  for (const id of ['3002', '3003']) {
    const v = readVerdict(dayRoot, id);
    assert.ok(v.reasoning, 'reasoning filled');
    assert.ok(v.draft, 'draft filled');
  }
});

// ── #3: ceiling=3 with 4 pending letters -> halts at 3, Handback flag ──────────────────────

test('tracer.safeguards: model-call ceiling=3 with 4 pending letters -> halts at 3, Handback flag', async () => {
  const dayRoot = tmpDay();
  for (const id of ['3004', '3005', '3006', '3007']) seedLetter(dayRoot, id);

  const requests: LlmCallRequest[] = [];
  const healthyCaller = async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return JSON.stringify({
      tc_covered: { pricing: true },
      decision_data: { payment_terms: '100 USD' },
      reasoning: 'outlet confirmed price',
      draft: 'Thanks — confirming the details now.',
    });
  };

  const result = await runSpine(dayRoot, async () => {}, 4, undefined, healthyCaller, undefined, 3);

  assert.equal(requests.length, 3, 'run halts after exactly 3 calls (the ceiling)');
  assert.equal(result.modelCallCount, 3, 'reported call count == ceiling');
  assert.ok(result.degraded, 'ceiling hit marks the run degraded');
  assert.ok(
    result.flags.some((f) => f.includes('Handback') || f.includes('HANDBACK')),
    'Handback flag present when the ceiling is hit',
  );

  const filledCount = ['3004', '3005', '3006', '3007'].filter((id) => readVerdict(dayRoot, id).draft !== null).length;
  assert.equal(filledCount, 3, 'exactly 3 of the 4 pending letters got a call; the 4th never ran');
});

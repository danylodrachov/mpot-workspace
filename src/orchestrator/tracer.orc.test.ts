/**
 * tracer.orc (issue #11) + tracer.reason (issue #08).
 * Acceptance:
 *  #11 — worklist → waves → JOIN → focus-sort → daily-plan.md produced
 *         H4 surfaces quarantine count; ORC spine performs no external effects
 *  #08 — seeded verdict → stubbed spawn fills label/reasoning; resume skips non-null fields
 *
 * NOTE (issue #04): the manifest stage (fetch-manifest.json + H1 out-of-folder assert) was
 * deleted — runSpine now scans outputs/ directly, and paths derived from dayRoot can never
 * be outside it. The old H1 test (which injected a bad path via fetch-manifest.json) is gone
 * with the file it tested; see src/orchestrator/tracer.slim.test.ts for the #04 acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSpine } from './spine.ts';
import type { ReconcileVerdict } from './executor/types.ts';

function tmpDay(): string {
  const d = mkdtempSync(join(tmpdir(), 'orc-'));
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

const FIXTURE_RECONCILE: ReconcileVerdict = {
  board: 'okb',
  task_id: 'task_okb_001',
  current_lane: 'Negotiation',
  truthful_signal: 'Outlet confirmed price ($150 USD). All defined questions answered.',
  signals: {
    defined_questions_complete: true,
    payment_details_received: null,
    payment_evidence_found: null,
  },
  blocked: false,
  block_reason: null,
  dry_run: [],
};

// ── tracer.orc: worklist → daily-plan.md produced ─────────────────────────────

test('tracer.orc: task with pre-filled reconcile-verdict → daily-plan.md produced', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.json'), {
    id: 'task_okb_001', board: 'okb', name: 'Test Outlet', status: 'Negotiation', comments: [],
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.verdict.json'), {
    board: 'okb', task_id: 'task_okb_001', task_name: 'Test Outlet', current_lane: 'Negotiation',
    decision_data: {}, reasoning: 'pre-filled', user_feedback: null, AI_feedback: null,
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), FIXTURE_RECONCILE);

  let spawnCount = 0;
  const result = await runSpine(dayRoot, async () => { spawnCount++; });

  // All verdict fields pre-filled → no spawns needed (resume logic)
  assert.equal(spawnCount, 0, 'spawner must not be called when all verdicts pre-filled');

  assert.ok(existsSync(join(dayRoot, 'daily-plan.md')), 'daily-plan.md must be written');
  const plan = readFileSync(join(dayRoot, 'daily-plan.md'), 'utf8');
  assert.match(plan, /Daily Plan/);
  assert.match(plan, /task_okb_001/);
  assert.match(plan, /Completed/);     // resolve: Negotiation + dq:true → lane_move Completed
  assert.match(plan, /LANE MOVE/);

  assert.equal(result.cardCount, 1);
  assert.equal(result.quarantineCount, 0);
});

test('tracer.orc: flag_operator card (blocked) → appears in plan under action', async () => {
  const dayRoot = tmpDay();

  const rv: ReconcileVerdict = {
    ...FIXTURE_RECONCILE,
    task_id: 'task_okb_002',
    blocked: true,
    block_reason: 'missing payment details',
    signals: { defined_questions_complete: null, payment_details_received: null, payment_evidence_found: null },
  };
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_002.json'), { id: 'task_okb_002' });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_002.verdict.json'), { reasoning: 'pre-filled' });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_002.reconcile-verdict.json'), rv);

  await runSpine(dayRoot, async () => {});
  const plan = readFileSync(join(dayRoot, 'daily-plan.md'), 'utf8');
  assert.match(plan, /FLAG/);
  assert.match(plan, /missing payment details/);
});

// ── tracer.reason (P5 / issue #08): seeded verdict → stubbed spawn fills label ──

test('tracer.reason: null label → spawner called for classify then read-pass', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.json'), {
    id: 'abc123', subject: 'Test', messages: [],
  });
  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json'), {
    source: 'gmail', thread_id: 'abc123', label: null, reasoning: null, draft: null,
  });

  const calls: string[] = [];
  await runSpine(dayRoot, async (prompt) => {
    calls.push(prompt);
    // Stub: simulate classify filling the label
    if (prompt.includes('classifier')) {
      const vPath = join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json');
      const v = JSON.parse(readFileSync(vPath, 'utf8')) as Record<string, unknown>;
      v['label'] = 'outreach';
      writeJson(vPath, v);
    }
    // Stub: simulate read-pass filling reasoning
    if (prompt.includes('READ pass')) {
      const vPath = join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json');
      const v = JSON.parse(readFileSync(vPath, 'utf8')) as Record<string, unknown>;
      v['reasoning'] = 'outlet asked about pricing';
      writeJson(vPath, v);
    }
  });

  assert.ok(calls.some((c) => c.includes('classifier')), 'classify must be spawned');
  assert.ok(calls.some((c) => c.includes('READ pass')), 'read-pass must be spawned after classify');
  assert.ok(calls.some((c) => c.includes('WRITE pass')), 'write-pass must be spawned after read-pass');
});

test('tracer.reason: non-null label + reasoning + draft → all spawns skipped (resume)', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.json'), {
    id: 'abc123', subject: 'Test', messages: [],
  });
  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json'), {
    source: 'gmail', thread_id: 'abc123',
    label: 'outreach', reasoning: 'pre-filled context', draft: 'pre-filled draft',
  });

  const calls: string[] = [];
  await runSpine(dayRoot, async (p) => { calls.push(p); });

  assert.equal(calls.length, 0, 'no spawns when all verdict fields are non-null');
});

test('tracer.reason: label=other → read-pass and write-pass skipped', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.json'), { id: 'abc123', subject: 'Test', messages: [] });
  writeJson(join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json'), {
    source: 'gmail', thread_id: 'abc123', label: null, reasoning: null, draft: null,
  });

  const calls: string[] = [];
  await runSpine(dayRoot, async (prompt) => {
    calls.push(prompt);
    if (prompt.includes('classifier')) {
      const vPath = join(dayRoot, 'outputs/emails/gmail/abc123.verdict.json');
      const v = JSON.parse(readFileSync(vPath, 'utf8')) as Record<string, unknown>;
      v['label'] = 'other';
      writeJson(vPath, v);
    }
  });

  const classifyCalls = calls.filter((c) => c.includes('classifier'));
  const readCalls = calls.filter((c) => c.includes('READ pass'));
  assert.equal(classifyCalls.length, 1, 'classify must be called once');
  assert.equal(readCalls.length, 0, 'read-pass must not be called for label=other');
});

// ── H4: quarantine count ────────────────────────────────────────────────────────

test('tracer.orc: H4 counts quarantined items in result', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'inputs/clean/_quarantine/broken.json'), { error: 'parse error', raw: {} });

  const result = await runSpine(dayRoot, async () => {});
  assert.equal(result.quarantineCount, 1);
});

// ── Approval gate (issue #12) ────────────────────────────────────────────────

test('tracer.gate: no gateFn → approved=null, dry_run[] empty', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.json'), {
    id: 'task_okb_001', board: 'okb', name: 'Test Outlet', status: 'Negotiation', comments: [],
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.verdict.json'), {
    board: 'okb', task_id: 'task_okb_001', task_name: 'Test Outlet', current_lane: 'Negotiation',
    decision_data: {}, reasoning: 'pre-filled', user_feedback: null, AI_feedback: null,
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), FIXTURE_RECONCILE);

  const result = await runSpine(dayRoot, async () => {});

  assert.equal(result.approved, null, 'approved must be null when no gateFn');
  assert.ok(!existsSync(join(dayRoot, 'approval.json')), 'approval.json must not be written without gateFn');
  const rv = JSON.parse(readFileSync(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), 'utf8')) as { dry_run: string[] };
  assert.deepEqual(rv.dry_run, [], 'dry_run must stay empty before approval');
});

test('tracer.gate: gateFn approves → applyDryRun fires, approval.json written', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.json'), {
    id: 'task_okb_001', board: 'okb', name: 'Test Outlet', status: 'Negotiation', comments: [],
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.verdict.json'), {
    board: 'okb', task_id: 'task_okb_001', task_name: 'Test Outlet', current_lane: 'Negotiation',
    decision_data: {}, reasoning: 'pre-filled', user_feedback: null, AI_feedback: null,
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), FIXTURE_RECONCILE);

  const stubGate = async (_dayRoot: string) => ({
    approved: true,
    feedback: null,
    timestamp: '2026-06-24T10:00:00.000Z',
  });

  const result = await runSpine(dayRoot, async () => {}, 4, stubGate);

  assert.equal(result.approved, true);
  assert.ok(existsSync(join(dayRoot, 'approval.json')), 'approval.json must be written');
  const approval = JSON.parse(readFileSync(join(dayRoot, 'approval.json'), 'utf8')) as { approved: boolean };
  assert.equal(approval.approved, true);
  const rv = JSON.parse(readFileSync(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), 'utf8')) as { dry_run: string[] };
  assert.ok(rv.dry_run.length > 0, 'dry_run must be populated after approval');
  assert.ok(rv.dry_run[0].includes('CLICKUP'), 'dry_run should contain CLICKUP intent string');
});

test('tracer.gate: gateFn rejects → dry_run empty, approval.json written, flag in result', async () => {
  const dayRoot = tmpDay();

  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.json'), {
    id: 'task_okb_001', board: 'okb', name: 'Test Outlet', status: 'Negotiation', comments: [],
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.verdict.json'), {
    board: 'okb', task_id: 'task_okb_001', task_name: 'Test Outlet', current_lane: 'Negotiation',
    decision_data: {}, reasoning: 'pre-filled', user_feedback: null, AI_feedback: null,
  });
  writeJson(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), FIXTURE_RECONCILE);

  const stubGate = async (_dayRoot: string) => ({
    approved: false,
    feedback: 'wrong outlet priority',
    timestamp: '2026-06-24T10:00:00.000Z',
  });

  const result = await runSpine(dayRoot, async () => {}, 4, stubGate);

  assert.equal(result.approved, false);
  assert.ok(result.flags.some((f) => f.includes('approval rejected')), 'rejection flag must be present');
  assert.ok(result.flags.some((f) => f.includes('wrong outlet priority')), 'feedback must appear in flag');
  const approval = JSON.parse(readFileSync(join(dayRoot, 'approval.json'), 'utf8')) as { approved: boolean; feedback: string };
  assert.equal(approval.approved, false);
  assert.equal(approval.feedback, 'wrong outlet priority');
  const rv = JSON.parse(readFileSync(join(dayRoot, 'outputs/tasks/task_okb_001.reconcile-verdict.json'), 'utf8')) as { dry_run: string[] };
  assert.deepEqual(rv.dry_run, [], 'dry_run must stay empty after rejection');
});

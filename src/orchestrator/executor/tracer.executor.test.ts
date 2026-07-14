/**
 * tracer.executor (issue #09): pure (lane, signals) → Action[] — no LLM, no network.
 * Acceptance criteria:
 *  - known (lane,signals) → exact Action[] → dry_run[] intent strings
 *  - null gating signal → flag_operator
 *  - blocked:true → flag_operator with reason
 *  - resolve() performs no I/O (statically provable — pure function, no fs/net imports)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from './resolve.ts';
import { renderIntent, applyDryRun, readReconcileVerdict } from './effects.ts';
import type { ReconcileVerdict, OkbSignals, CkbSignals } from './types.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../../pipeline/__fixtures__/tracer', import.meta.url));

function loadOkbVerdict(): ReconcileVerdict {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'okb.reconcile-verdict.json'), 'utf8'));
}

// ── tracer.executor: known (lane,signals) → exact Action[] ───────────────────

test('tracer.executor: Negotiation + defined_questions_complete:true → lane_move Completed', () => {
  const verdict = loadOkbVerdict(); // Negotiation, dq:true, not blocked
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { kind: 'lane_move', to: 'Completed', gated: true });
});

test('tracer.executor: Negotiation + defined_questions_complete:false → replyio send', () => {
  const verdict: ReconcileVerdict = {
    ...loadOkbVerdict(),
    signals: { defined_questions_complete: false, payment_details_received: null, payment_evidence_found: null } satisfies OkbSignals,
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'replyio');
  assert.equal((actions[0] as Extract<typeof actions[0], { kind: 'replyio' }>).op, 'send');
});

test('tracer.executor: Invoice Request + payment_details_received:true → lane_move To Pay', () => {
  const verdict: ReconcileVerdict = {
    ...loadOkbVerdict(),
    current_lane: 'Invoice Request',
    signals: { defined_questions_complete: true, payment_details_received: true, payment_evidence_found: null } satisfies OkbSignals,
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { kind: 'lane_move', to: 'To Pay', gated: true });
});

test('tracer.executor: CKB To Submit + publication_submitted:false → replyio enrol Step 1', () => {
  const verdict: ReconcileVerdict = {
    board: 'ckb',
    task_id: 'task_ckb_001',
    current_lane: 'To Submit',
    truthful_signal: 'test',
    signals: { publication_submitted: false, published_link_present: null, corrections_present: null, corrections_cleared: null } satisfies CkbSignals,
    blocked: false,
    block_reason: null,
    dry_run: [],
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  const act = actions[0] as Extract<typeof actions[0], { kind: 'replyio' }>;
  assert.equal(act.kind, 'replyio');
  assert.equal(act.op, 'enrol');
  assert.equal(act.stepId, 1);
});

test('tracer.executor: CKB Publication Revision + corrections_cleared:true → 3 actions', () => {
  const verdict: ReconcileVerdict = {
    board: 'ckb',
    task_id: 'task_ckb_002',
    current_lane: 'Publication Revision',
    truthful_signal: 'test',
    signals: { publication_submitted: true, published_link_present: false, corrections_present: true, corrections_cleared: true } satisfies CkbSignals,
    blocked: false,
    block_reason: null,
    dry_run: [],
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 3);
  assert.equal(actions[0].kind, 'replyio');
  assert.equal(actions[1].kind, 'lane_move');
  assert.equal(actions[2].kind, 'comment');
});

// ── null gating signal → flag_operator ───────────────────────────────────────

test('tracer.executor: null gating signal → flag_operator (never guess)', () => {
  const verdict: ReconcileVerdict = {
    ...loadOkbVerdict(),
    signals: { defined_questions_complete: null, payment_details_received: null, payment_evidence_found: null } satisfies OkbSignals,
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'flag_operator');
  assert.match((actions[0] as { kind: 'flag_operator'; reason: string }).reason, /defined_questions_complete/);
});

// ── blocked:true → flag_operator with reason ─────────────────────────────────

test('tracer.executor: blocked:true → flag_operator with reason', () => {
  const verdict: ReconcileVerdict = {
    ...loadOkbVerdict(),
    blocked: true,
    block_reason: 'missing payment details',
  };
  const actions = resolve(verdict);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { kind: 'flag_operator', reason: 'missing payment details' });
});

// ── dry_run intent strings ────────────────────────────────────────────────────

test('tracer.executor: renderIntent lane_move → [CLICKUP] intent string', () => {
  const action = { kind: 'lane_move', to: 'Completed', gated: true } as const;
  assert.equal(renderIntent(action, 'task_okb_001'), '[CLICKUP] move task_okb_001 → Completed (gated)');
});

test('tracer.executor: renderIntent replyio → [REPLY.IO] intent string', () => {
  const action = { kind: 'replyio', op: 'enrol', note: 'Step 1 placement (template)', stepId: 1, gated: true } as const;
  assert.match(renderIntent(action, 'task_ckb_001'), /\[REPLY\.IO\].*enrol.*step 1/);
});

test('tracer.executor: applyDryRun writes intent strings into verdict dry_run[]', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'executor-'));
  const verdictPath = join(tmpDir, 'okb.reconcile-verdict.json');
  writeFileSync(verdictPath, JSON.stringify(loadOkbVerdict(), null, 2));

  const verdict = loadOkbVerdict();
  const actions = resolve(verdict);
  applyDryRun(verdictPath, actions, verdict.task_id);

  const updated = readReconcileVerdict(verdictPath);
  assert.equal(updated.dry_run.length, 1);
  assert.match(updated.dry_run[0], /\[CLICKUP\].*Completed/);
});

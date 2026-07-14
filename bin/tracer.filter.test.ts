/**
 * Black-box acceptance test for issue #02 — freshness filter wired into bin/run-orc.ts.
 * Locked BEFORE the implementation (Ralph gate 1). Runs the REAL orchestrator entrypoint
 * (`runOrcOnce`) end-to-end over a fixture day root.
 *
 * Updated by issue #05: the OKB (reply.io) thread tier no longer spawns a `claude -p` session
 * per step (classify/READ/WRITE) — it makes ONE direct model call per letter (merged for a new
 * letter, write-only for a redo). The `spawner` fake covers gmail's classify/READ/WRITE tier
 * and the ClickUp task tier; every assertion that used to read spawner prompt text for
 * reply.io now reads the fake caller's recorded requests instead.
 *
 * DELIBERATELY RE-LOCKED 2026-07-07: gmail is no longer parked. The old spec (criterion 5:
 * "gmail messages never appear in the processed set") is replaced — a gmail thread carrying
 * at least one unseen message id now flows clean → split → classify/READ/WRITE, and its
 * message keys get file/verdict pointers in the registry AFTER processing.
 *
 * Acceptance criteria (issue #02, amended 2026-07-07):
 *  1. Run 1 over fixtures: N reply.io messages processed, registry gains N reply.io keys +
 *     all gmail keys; the gmail thread is processed (classify → READ → WRITE spawns).
 *  2. Run 2, same raw data: 0 calls, outputs unchanged (gmail fully sifted by message id).
 *  3. Add one new reply.io activity (newer lastActivityDate) -> exactly that one message passes.
 *  4. Flip redo_draft: true on one seen entry AND remove that message from the day's raw
 *     fixture -> it still passes (material via the entry's file); after a draft is written the
 *     entry shows redo_draft: false.
 *  5. Gmail registry entries carry file/verdict pointers to the thread's split copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrcOnce } from './run-orc.ts';
import { applyFreshnessFilter, type GmailThreadFileLike, type ReplyioRawItem } from '../src/pipeline/filter.ts';
import { loadRegistry, type Registry } from '../src/pipeline/registry.ts';
import type { SpawnFn } from '../src/orchestrator/spine.ts';
import type { LlmCaller, LlmCallRequest } from '../src/llm/call.ts';

// ── helpers ─────────────────────────────────────────────────────────────────────

function replyioItem(id: string, lastActivityDate: string, subject: string): ReplyioRawItem {
  return {
    id,
    subject,
    body: `<p>Body for ${subject}</p>`,
    from: `contact-${id}@example.com`,
    date: lastActivityDate,
    raw: { lastActivityDate },
  };
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tracer-filter-'));
}

function writeRaw(root: string, date: string, source: string, items: unknown[]): void {
  const dir = join(root, 'data', date, 'inputs', 'raw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${source}.json`), JSON.stringify(items, null, 2));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Fake `claude -p` spawner: simulates what the real subprocess would write, keyed off the
 * prompt text (same convention as src/orchestrator/tracer.orc.test.ts). `draftText` lets each
 * run write a DISTINCT draft, so a rerun can be told apart from a carried-over one.
 */
function makeSpawner(draftText = 'auto-draft'): { spawner: SpawnFn; calls: string[] } {
  const calls: string[] = [];
  const spawner: SpawnFn = async (prompt: string) => {
    calls.push(prompt);
    const idx = prompt.indexOf('verdict_path: ');
    if (idx === -1) return;
    const rest = prompt.slice(idx + 'verdict_path: '.length);
    const end = rest.search(/\.(?:\s|$)/);
    const vPath = end === -1 ? rest.trim() : rest.slice(0, end);
    if (!existsSync(vPath)) return;
    const v = readJson(vPath);
    if (prompt.includes('classifier')) v.label = 'outreach';
    else if (prompt.includes('READ pass')) v.reasoning = 'auto reasoning';
    else if (prompt.includes('WRITE pass')) v.draft = draftText;
    writeFileSync(vPath, JSON.stringify(v, null, 2));
  };
  return { spawner, calls };
}

/**
 * Fake direct OKB caller (issue #05) — the reply.io tier's actual mechanism. One call fills
 * label deterministically-set-elsewhere + tc_covered/decision_data/reasoning/draft for a new
 * letter; a redo/follow-up call only reads `draft` back. `draftText` lets a rerun be told apart
 * from a carried-over value, same convention as `makeSpawner`'s `draftText`.
 */
function makeCaller(draftText = 'auto-draft'): { caller: LlmCaller; calls: LlmCallRequest[] } {
  const calls: LlmCallRequest[] = [];
  const caller: LlmCaller = async (req: LlmCallRequest) => {
    calls.push(req);
    return JSON.stringify({
      tc_covered: {},
      decision_data: { payment_terms: null },
      reasoning: 'auto reasoning',
      draft: draftText,
    });
  };
  return { caller, calls };
}

const GMAIL_FIXTURE: GmailThreadFileLike[] = [{
  threadId: 'thread_ckb_9001',
  messages: [
    { id: 'msg_out_9001', threadId: 'thread_ckb_9001', from: 'me@example.com', subject: 'Pitch', date: '2026-06-19T09:00:00Z', text: 'Hi', isOutbound: true, attachments: [] },
    { id: 'msg_in_9001', threadId: 'thread_ckb_9001', from: 'editor@blog9001.com', subject: 'Re: Pitch', date: '2026-06-20T09:00:00Z', text: 'Sure', isOutbound: false, attachments: [] },
  ],
}];

// ── criteria 1, 2, 3, 5 — three-run lifecycle over one day root ────────────────

test('freshness filter: new -> unchanged rerun -> new activity; gmail flows once, sifts after', async () => {
  const root = makeRoot();
  const date = '2026-07-01';

  const itemA = replyioItem('3001', '2026-06-20T10:00:00Z', 'Guest post A');
  const itemB = replyioItem('3002', '2026-06-21T11:00:00Z', 'Guest post B');

  writeRaw(root, date, 'replyio', [itemA, itemB]);
  writeRaw(root, date, 'gmail', GMAIL_FIXTURE);

  // ── Run 1: both reply.io messages are new; gmail thread is new too ──
  const run1 = makeSpawner('draft-run1');
  const run1Caller = makeCaller('draft-run1');
  await runOrcOnce(root, date, run1.spawner, 4, run1Caller.caller);

  const keyA = 'replyio:3001:2026-06-20T10:00:00Z';
  const keyB = 'replyio:3002:2026-06-21T11:00:00Z';
  const gmailKeyOut = 'gmail:msg_out_9001';
  const gmailKeyIn = 'gmail:msg_in_9001';

  let registry: Registry = loadRegistry(root);
  assert.ok(registry[keyA], 'run1: reply.io key A registered');
  assert.ok(registry[keyB], 'run1: reply.io key B registered');
  assert.equal(registry[keyA].file, `data/${date}/outputs/emails/replyio/3001.json`);
  assert.equal(registry[keyA].verdict, `data/${date}/outputs/emails/replyio/3001.verdict.json`);
  assert.ok(registry[gmailKeyOut], 'run1: gmail key (outbound) registered');
  assert.ok(registry[gmailKeyIn], 'run1: gmail key (inbound) registered');
  const gmailFile = `data/${date}/outputs/emails/gmail/thread_ckb_9001.json`;
  const gmailVerdict = `data/${date}/outputs/emails/gmail/thread_ckb_9001.verdict.json`;
  assert.equal(registry[gmailKeyOut].file, gmailFile, 'gmail entry points to the split copy');
  assert.equal(registry[gmailKeyOut].verdict, gmailVerdict, 'gmail entry points to the verdict sidecar');
  assert.equal(registry[gmailKeyIn].file, gmailFile, 'sibling message shares the thread pointers');

  assert.equal(run1.calls.length, 3, 'run1: gmail thread spawned classify → READ → WRITE');
  assert.equal(run1Caller.calls.length, 2, 'run1: direct caller invoked once per new reply.io letter');

  const gmailOutputsDir = join(root, 'data', date, 'outputs', 'emails', 'gmail');
  const gmailSplitFiles = existsSync(gmailOutputsDir)
    ? readdirSync(gmailOutputsDir).filter((f) => f.endsWith('.json'))
    : [];
  assert.equal(gmailSplitFiles.length, 2, 'gmail split copy + verdict sidecar written');

  const gmailVerdict1 = readJson(join(root, gmailVerdict));
  assert.equal(gmailVerdict1.label, 'outreach', 'run1: gmail classify tier filled label');
  assert.equal(gmailVerdict1.draft, 'draft-run1', 'run1: gmail WRITE pass filled draft');

  const verdictA1 = readJson(join(root, registry[keyA].verdict!));
  const verdictB1 = readJson(join(root, registry[keyB].verdict!));
  assert.equal(verdictA1.draft, 'draft-run1');
  assert.equal(verdictB1.draft, 'draft-run1');

  // ── Run 2: identical raw fetch (same ~50 unread threads polled again) ──
  writeRaw(root, date, 'replyio', [itemA, itemB]);
  writeRaw(root, date, 'gmail', GMAIL_FIXTURE);

  const run2 = makeSpawner('draft-run2');
  const run2Caller = makeCaller('draft-run2');
  await runOrcOnce(root, date, run2.spawner, 4, run2Caller.caller);

  assert.equal(run2.calls.length, 0, 'run2: 0 spawner calls — both messages already handled');
  assert.equal(run2Caller.calls.length, 0, 'run2: 0 direct-caller calls — both letters already drafted');

  registry = loadRegistry(root);
  const verdictA2 = readJson(join(root, registry[keyA].verdict!));
  const verdictB2 = readJson(join(root, registry[keyB].verdict!));
  assert.deepEqual(verdictA2, verdictA1, 'run2: outputs unchanged for A');
  assert.deepEqual(verdictB2, verdictB1, 'run2: outputs unchanged for B');

  const replyioKeyCountAfterRun2 = Object.keys(registry).filter((k) => k.startsWith('replyio:')).length;
  assert.equal(replyioKeyCountAfterRun2, 2, 'run2: no new reply.io keys created');

  // ── Run 3: a new activity lands on thread 3001 (newer lastActivityDate) ──
  const itemC = replyioItem('3001', '2026-06-25T10:00:00Z', 'Guest post A — follow-up');
  writeRaw(root, date, 'replyio', [itemA, itemB, itemC]);
  writeRaw(root, date, 'gmail', GMAIL_FIXTURE);

  const run3 = makeSpawner('draft-run3');
  const run3Caller = makeCaller('draft-run3');
  const result3 = await runOrcOnce(root, date, run3.spawner, 4, run3Caller.caller);

  const keyC = 'replyio:3001:2026-06-25T10:00:00Z';
  const newDecisions = result3.decisions.filter((d) => d.kind === 'new');
  const siftDecisions = result3.decisions.filter((d) => d.kind === 'sift');
  assert.equal(newDecisions.length, 1, 'run3: exactly one message is newly admitted');
  assert.equal(newDecisions[0].key, keyC, 'run3: the admitted message is the new activity');
  assert.equal(siftDecisions.length, 2, 'run3: the two unchanged messages are sifted out');

  registry = loadRegistry(root);
  assert.ok(registry[keyC], 'run3: the new activity key is registered');
  const replyioKeyCountAfterRun3 = Object.keys(registry).filter((k) => k.startsWith('replyio:')).length;
  assert.equal(replyioKeyCountAfterRun3, 3, 'run3: registry grew by exactly one reply.io key');
});

// ── criterion 4 — redo admission bypasses today's raw fetch entirely ───────────

test('freshness filter: redo_draft entry re-admitted even when absent from raw; flips to false once drafted', async () => {
  const root = makeRoot();
  const date1 = '2026-06-20';
  const date2 = '2026-06-27';

  const item = replyioItem('4001', '2026-06-19T08:00:00Z', 'Redo candidate');
  writeRaw(root, date1, 'replyio', [item]);
  writeRaw(root, date1, 'gmail', []);

  const run1 = makeSpawner('draft-v1');
  const run1Caller = makeCaller('draft-v1');
  await runOrcOnce(root, date1, run1.spawner, 4, run1Caller.caller);

  const key = 'replyio:4001:2026-06-19T08:00:00Z';
  let registry = loadRegistry(root);
  assert.ok(registry[key], 'run1: message registered');
  assert.equal(registry[key].file, `data/${date1}/outputs/emails/replyio/4001.json`);

  const verdictAfterRun1 = readJson(join(root, registry[key].verdict!));
  assert.equal(verdictAfterRun1.draft, 'draft-v1');

  // Operator/gate defers a redo for this message.
  registry[key] = { ...registry[key], redo_draft: true };
  const { saveRegistry } = await import('../src/pipeline/registry.ts');
  saveRegistry(root, registry);

  // A later day: the message no longer appears in the fetch at all.
  writeRaw(root, date2, 'replyio', []);
  writeRaw(root, date2, 'gmail', []);

  const run2 = makeSpawner('draft-v2');
  const run2Caller = makeCaller('draft-v2');
  const result2 = await runOrcOnce(root, date2, run2.spawner, 4, run2Caller.caller);

  assert.ok(
    result2.decisions.some((d) => d.kind === 'redo' && d.key === key),
    'run2: the redo-flagged key is admitted by the filter even though raw is empty',
  );
  assert.equal(run2.calls.length, 0, 'run2: spawner never invoked — reply.io no longer spawns a session');
  assert.equal(run2Caller.calls.length, 1, 'run2: exactly one direct-caller call for the redo-admitted message');
  assert.match(
    run2Caller.calls[0].system,
    /OKB drafter/,
    'run2: the write-only prompt ran (messaging-write-outreach.md) — nothing re-judged',
  );

  registry = loadRegistry(root);
  assert.equal(registry[key].redo_draft, false, 'run2: redo_draft flips to false once a new draft is written');
  assert.equal(registry[key].file, `data/${date2}/outputs/emails/replyio/4001.json`, 'run2: file pointer refreshed to the new day');

  const verdictAfterRun2 = readJson(join(root, registry[key].verdict!));
  assert.equal(verdictAfterRun2.draft, 'draft-v2', 'run2: draft actually re-written, not just carried over');
  assert.equal(verdictAfterRun2.label, 'outreach', 'run2: label carried over from run1');
  assert.equal(verdictAfterRun2.reasoning, 'auto reasoning', 'run2: reasoning carried over from run1');
});

// ── bonus (Spec rule 3, not separately enumerated in acceptance criteria) ──────

test('bonus: applyFreshnessFilter — clickup status-mismatch reprocesses; matching status sifts', () => {
  const item = replyioItem('5001', '2026-06-01T00:00:00Z', 'Linked to a card');
  const key = 'replyio:5001:2026-06-01T00:00:00Z';

  const mismatchRegistry: Registry = {
    [key]: {
      thread_id: '5001', task_id: 'task_abc', clickup_status: 'Negotiation',
      file: 'data/2026-06-01/outputs/emails/replyio/5001.json',
      verdict: 'data/2026-06-01/outputs/emails/replyio/5001.verdict.json',
      redo_draft: null,
    },
  };
  const rMismatch = applyFreshnessFilter(mismatchRegistry, [item], [{ id: 'task_abc', status: 'Invoice' }]);
  assert.equal(rMismatch.decisions[0].kind, 'status-change');
  assert.equal(rMismatch.replyioKept.length, 1);

  const matchingRegistry: Registry = {
    [key]: { ...mismatchRegistry[key] },
  };
  const rMatching = applyFreshnessFilter(matchingRegistry, [item], [{ id: 'task_abc', status: 'Negotiation' }]);
  assert.equal(rMatching.decisions[0].kind, 'sift');
  assert.equal(rMatching.replyioKept.length, 0);
});

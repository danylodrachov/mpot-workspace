import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { focusSort } from './sort.ts';
import { writeDailyPlan } from './plan.ts';
import { resolve } from './executor/resolve.ts';
import { applyDryRun } from './executor/effects.ts';
import type { ReconcileVerdict } from './executor/types.ts';
import type { SortableCard } from './sort.ts';
import type { ApprovalResult } from '../telegram/gate.ts';
import { defaultLlmCaller, loadAgentPrompt, parseModelJson, type LlmCaller } from '../llm/call.ts';

export type SpawnFn = (prompt: string) => Promise<void>;
export type GateFn = (dayRoot: string) => Promise<ApprovalResult>;
/** thread_id -> operator-mapped task_id (null when the letter has no mapped card yet). */
export type TaskIdLookup = (threadId: string) => string | null;

const AGENTS_DIR = fileURLToPath(new URL('../../.claude/agents/', import.meta.url));

export interface SpineResult {
  cardCount: number;
  quarantineCount: number;
  flags: string[];
  /** null when no gateFn was provided (dry-run / test mode). */
  approved: boolean | null;
  /** Total direct-model-caller invocations this run made (issue #08: spend is observable). */
  modelCallCount: number;
  /** true when either safeguard (empty-tier stop or model-call budget) halted the run. */
  degraded: boolean;
}

/** Thrown by the budgeted caller when the ceiling is hit — caught inside runSpine, never a process crash. */
export class ModelCallBudgetExceededError extends Error {}

/** Wraps a real LlmCaller with a hard call-count ceiling (issue #08 §2). */
function budgetedCaller(caller: LlmCaller, ceiling: number, counter: { count: number }): LlmCaller {
  return async (req) => {
    if (counter.count >= ceiling) {
      throw new ModelCallBudgetExceededError(`model-call budget exceeded (${ceiling}/run)`);
    }
    counter.count += 1;
    return caller(req);
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function fileType(filePath: string): 'thread-gmail' | 'thread-replyio' | 'task' {
  if (filePath.includes('/emails/gmail/')) return 'thread-gmail';
  if (filePath.includes('/emails/replyio/')) return 'thread-replyio';
  return 'task';
}

/**
 * Scan outputs/ directly for the worklist — no intermediate fetch-manifest.json (issue #04:
 * the manifest stage is gone; buildManifest's readdir logic moves in here as a private helper).
 * Paths are always derived from dayRoot itself, so they can never be outside it (H1 is moot).
 */
function scanWorklist(dayRoot: string): string[] {
  const files: string[] = [];

  for (const source of ['gmail', 'replyio'] as const) {
    const dir = join(dayRoot, 'outputs', 'emails', source);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json') && !f.endsWith('.verdict.json')) {
        files.push(join(dir, f));
      }
    }
  }

  const tasksDir = join(dayRoot, 'outputs', 'tasks');
  if (existsSync(tasksDir)) {
    for (const f of readdirSync(tasksDir)) {
      if (f.endsWith('.json') && !f.endsWith('.verdict.json') && !f.endsWith('.reconcile-verdict.json')) {
        files.push(join(tasksDir, f));
      }
    }
  }

  return files;
}

/** H4: count quarantined items so a degraded run is visible. */
function countQuarantine(dayRoot: string): number {
  const dir = join(dayRoot, 'inputs', 'clean', '_quarantine');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

interface ThreadVerdict {
  label: string | null;
  reasoning: string | null;
  draft: string | null;
}

interface TaskVerdict {
  reasoning: string | null;
}

/** Full shape of an <thread_id>.verdict.json for a reply.io (OKB) letter — split.ts's template. */
interface OkbVerdict {
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

/**
 * OKB letter tier (issue #05) — ONE direct model call per letter, no Claude Code session.
 * No classify tier for OKB: reply.io letters are outreach by construction, so `label` is set
 * deterministically here (no spawn). Card linkage is manual: `taskIdForThread` only ever
 * reflects a mapping the operator already wrote into the registry; when it resolves to an id
 * whose cleaned card landed in this day's outputs/tasks/, that card's content is inlined too.
 *
 * - `reasoning === null` (brand-new letter): ONE merged call
 *   (`messaging-okb-letter.md`) fills tc_covered + decision_data.payment_terms + reasoning +
 *   draft together.
 * - `reasoning !== null && draft === null` (redo/follow-up continuation, issues #06/#07): ONE
 *   write-only call (`messaging-write-outreach.md`) — judgment fields are inlined as context,
 *   only `draft` comes back, nothing is re-judged.
 * - `draft !== null`: already done — resume skip, zero calls.
 */
async function processOkbLetter(
  threadPath: string,
  verdictPath: string,
  dayRoot: string,
  caller: LlmCaller,
  taskIdForThread?: TaskIdLookup,
): Promise<void> {
  const v = readJson<OkbVerdict>(verdictPath);

  // No classify tier for OKB — deterministic label, set directly, no model call.
  if (v.label === null) {
    v.label = 'outreach';
    writeFileSync(verdictPath, JSON.stringify(v, null, 2));
  }

  if (v.draft !== null) return; // resume: fully done

  const thread = readJson<Record<string, unknown>>(threadPath);
  const threadId = String(thread['id'] ?? basename(threadPath, '.json'));
  const taskId = taskIdForThread?.(threadId) ?? null;

  let card: unknown = null;
  if (taskId) {
    const cardPath = join(dayRoot, 'outputs', 'tasks', `${taskId}.json`);
    if (existsSync(cardPath)) card = readJson(cardPath);
  }

  const current = readJson<OkbVerdict>(verdictPath); // re-read: label write above may have landed

  if (current.reasoning === null) {
    // New letter — merged read+write call.
    const { model, system } = loadAgentPrompt(join(AGENTS_DIR, 'messaging-okb-letter.md'));
    const user = JSON.stringify({ thread, card }, null, 2);
    const raw = await caller({ model, system, user });
    const parsed = parseModelJson(raw);

    const next = readJson<OkbVerdict>(verdictPath);
    next.tc_covered = (parsed['tc_covered'] as Record<string, boolean> | undefined) ?? null;
    const decisionData = parsed['decision_data'] as { payment_terms?: string | null } | undefined;
    next.decision_data = {
      ...next.decision_data,
      payment_terms: decisionData?.payment_terms ?? null,
    };
    next.reasoning = (parsed['reasoning'] as string | undefined) ?? null;
    next.draft = (parsed['draft'] as string | undefined) ?? null;
    writeFileSync(verdictPath, JSON.stringify(next, null, 2));
  } else {
    // Redo / follow-up continuation — write-only call, nothing re-judged.
    const { model, system } = loadAgentPrompt(join(AGENTS_DIR, 'messaging-write-outreach.md'));
    const user = JSON.stringify({ verdict: current, card }, null, 2);
    const raw = await caller({ model, system, user });
    const parsed = parseModelJson(raw);

    const next = readJson<OkbVerdict>(verdictPath);
    next.draft = (parsed['draft'] as string | undefined) ?? null;
    writeFileSync(verdictPath, JSON.stringify(next, null, 2));
  }
}

/**
 * One file's worth of Tier-1/Tier-2 reasoning work, reporting whether a call was ATTEMPTED
 * (a model was asked to fill a null field) and whether it actually FILLED anything (issue #08
 * §1: the 2026-06-25 incident was a whole tier attempting work and filling zero fields while
 * the run continued silently). `targetFields` are the fields a MODEL call can fill for this
 * file type — deterministic writes (OKB's `label`) are intentionally excluded so a caller that
 * mints valid-but-empty JSON is caught, not masked by an unrelated deterministic field flip.
 */
async function processReasoningFile(
  f: string,
  dayRoot: string,
  caller: LlmCaller,
  spawner: SpawnFn,
  taskIdForThread?: TaskIdLookup,
): Promise<{ attempted: boolean; filled: boolean }> {
  const vPath = f.replace(/\.json$/, '.verdict.json');
  const type = fileType(f);
  const before = readJson<Record<string, unknown>>(vPath);

  let attempted = false;
  let targetFields: string[];

  if (type === 'thread-replyio') {
    targetFields = ['reasoning', 'draft'];
    attempted = before['draft'] === null; // merged (new) or write-only (redo) call — both leave draft null beforehand
    await processOkbLetter(f, vPath, dayRoot, caller, taskIdForThread);
  } else if (type === 'thread-gmail') {
    targetFields = ['label', 'reasoning', 'draft'];
    const v: ThreadVerdict = before as unknown as ThreadVerdict;

    if (v.label === null) {
      attempted = true;
      await spawner(`Run the Tier-1 classifier. thread_path: ${f}. verdict_path: ${vPath}.`);
    }

    const v2: ThreadVerdict = existsSync(vPath) ? readJson<ThreadVerdict>(vPath) : v;
    if (v2.label && v2.label !== 'other') {
      if (v2.reasoning === null) {
        attempted = true;
        await spawner(`Run the READ pass. thread_path: ${f}. verdict_path: ${vPath}. label: ${v2.label}.`);
      }

      const v3: ThreadVerdict = existsSync(vPath) ? readJson<ThreadVerdict>(vPath) : v2;
      if (v3.reasoning !== null && v3.draft === null) {
        attempted = true;
        await spawner(`Run the WRITE pass. verdict_path: ${vPath}. label: ${v3.label}.`);
      }
    }
  } else {
    targetFields = ['reasoning'];
    attempted = before['reasoning'] === null;
    if (attempted) {
      await spawner(`Run the ClickUp context-former. task_path: ${f}. verdict_path: ${vPath}.`);
    }
  }

  const after = readJson<Record<string, unknown>>(vPath);
  const filled = targetFields.some((k) => before[k] === null && after[k] !== null);
  return { attempted, filled };
}

/** One pass over every worklist file's Tier-1/Tier-2 reasoning step, aggregated for the empty-tier check. */
async function runReasoningWave(
  files: string[],
  dayRoot: string,
  caller: LlmCaller,
  spawner: SpawnFn,
  taskIdForThread: TaskIdLookup | undefined,
  limit: ReturnType<typeof pLimit>,
): Promise<{ attempted: number; filled: number }> {
  const results = await Promise.all(
    files.map((f) => limit(() => processReasoningFile(f, dayRoot, caller, spawner, taskIdForThread))),
  );
  let attempted = 0;
  let filled = 0;
  for (const r of results) {
    if (r.attempted) attempted += 1;
    if (r.filled) filled += 1;
  }
  return { attempted, filled };
}

/**
 * ORC spine — deterministic orchestrator.
 * Scans outputs/ directly for the worklist (issue #04: no intermediate manifest file) →
 * bounded fan-out waves (p-limit) → reconciler → executor resolve → focus-sort → daily-plan.md.
 *
 * spawner is the claude -p boundary: injectable for testing, real in production.
 */
export async function runSpine(
  dayRoot: string,
  spawner: SpawnFn,
  concurrency = 4,
  gateFn?: GateFn,
  caller: LlmCaller = defaultLlmCaller,
  taskIdForThread?: TaskIdLookup,
  ceiling?: number,
): Promise<SpineResult> {
  const flags: string[] = [];
  const files = scanWorklist(dayRoot);

  const limit = pLimit(concurrency);

  // Model-call budget (issue #08 §2): counter on the direct-caller wrapper, default ceiling
  // from one env/config value (default 40/run). Spend is always reported in the run result.
  const envCeiling = process.env.MODEL_CALL_BUDGET ? Number(process.env.MODEL_CALL_BUDGET) : undefined;
  const effectiveCeiling = ceiling ?? envCeiling ?? 40;
  const callCounter = { count: 0 };
  const budgeted = budgetedCaller(caller, effectiveCeiling, callCounter);

  let degraded = false;

  // Tier 1+2: classify → read → write (gmail threads); ONE direct call per reply.io letter
  // (issue #05, no classify tier, no Claude Code session); clickup-subagent (tasks).
  //
  // Empty-tier stop (issue #08 §1): if this wave attempts >=1 item and fills 0 target fields,
  // retry the wave once; still 0 → halt before any later tier spawns (the 2026-06-25 incident:
  // a whole tier wrote nothing and later tiers spawned anyway, silently).
  try {
    let wave = await runReasoningWave(files, dayRoot, budgeted, spawner, taskIdForThread, limit);
    if (wave.attempted > 0 && wave.filled === 0) {
      wave = await runReasoningWave(files, dayRoot, budgeted, spawner, taskIdForThread, limit);
      if (wave.attempted > 0 && wave.filled === 0) {
        flags.push('RUN DEGRADED: reasoning tier wrote nothing');
        degraded = true;
      }
    }
  } catch (e) {
    if (e instanceof ModelCallBudgetExceededError) {
      flags.push(`HANDBACK: ${e.message}`);
      degraded = true;
    } else {
      throw e;
    }
  }

  if (degraded) {
    // Never spawn later tiers after a halt: skip the reconciler entirely.
    const quarantineCount = countQuarantine(dayRoot);
    writeDailyPlan(dayRoot, [], quarantineCount, flags);
    return { cardCount: 0, quarantineCount, flags, approved: null, modelCallCount: callCounter.count, degraded };
  }

  // Tier 3: reconciler — one spawn per task, after all Tier-2 completes
  const taskFiles = files.filter((f) => fileType(f) === 'task');
  await Promise.all(
    taskFiles.map((f) =>
      limit(async () => {
        const taskId = basename(f, '.json');
        const taskVerdictPath = f.replace(/\.json$/, '.verdict.json');
        const reconcilePath = f.replace(/\.json$/, '.reconcile-verdict.json');

        // Resume: skip if truthful_signal already set
        if (existsSync(reconcilePath)) {
          const rv = readJson<{ truthful_signal: string | null }>(reconcilePath);
          if (rv.truthful_signal !== null) return;
        }

        await spawner(
          `Run the reconciler for task ${taskId}. task_verdict_path: ${taskVerdictPath}. output_path: ${reconcilePath}.`,
        );
      }),
    ),
  );

  // Executor: resolve actions per card, then focus-sort and write daily-plan.md
  const cards: SortableCard[] = [];
  const cardReconcilePaths = new Map<string, string>(); // taskId → reconcile-verdict path
  for (const f of taskFiles) {
    const reconcilePath = f.replace(/\.json$/, '.reconcile-verdict.json');
    if (!existsSync(reconcilePath)) continue;

    const rv = readJson<ReconcileVerdict>(reconcilePath);
    if (!rv.truthful_signal) continue;

    try {
      const actions = resolve(rv);
      cards.push({
        taskId: rv.task_id,
        board: rv.board,
        currentLane: rv.current_lane,
        truthfulSignal: rv.truthful_signal,
        actions,
      });
      cardReconcilePaths.set(rv.task_id, reconcilePath);
    } catch (e) {
      flags.push(`resolve ${rv.task_id}: ${(e as Error).message}`);
    }
  }

  const sorted = focusSort(cards);
  const quarantineCount = countQuarantine(dayRoot);
  writeDailyPlan(dayRoot, sorted, quarantineCount, flags);

  // H4 — run-completeness: surface quarantine count (warn, never throw)
  if (quarantineCount > 0) {
    console.warn(`H4: ${quarantineCount} item(s) quarantined in ${dayRoot}/inputs/clean/_quarantine — run degraded`);
  }

  // Approval gate — only when gateFn is provided (production). Skipped in test/dry-run mode.
  if (!gateFn) {
    return { cardCount: cards.length, quarantineCount, flags, approved: null, modelCallCount: callCounter.count, degraded };
  }

  const approval = await gateFn(dayRoot);
  writeFileSync(join(dayRoot, 'approval.json'), JSON.stringify(approval, null, 2));

  if (!approval.approved) {
    flags.push(`approval rejected${approval.feedback ? `: ${approval.feedback}` : ''}`);
    return { cardCount: cards.length, quarantineCount, flags, approved: false, modelCallCount: callCounter.count, degraded };
  }

  // Gated writes — fire only after approval. Currently dry-run stubs (ADR 0042).
  for (const card of sorted) {
    const reconcilePath = cardReconcilePaths.get(card.taskId);
    if (reconcilePath && card.actions.length > 0) {
      applyDryRun(reconcilePath, card.actions, card.taskId);
    }
  }

  return { cardCount: cards.length, quarantineCount, flags, approved: true, modelCallCount: callCounter.count, degraded };
}

/**
 * OKB end-to-end run script (issue #10) — thin sequencer over the EXISTING stage helpers used
 * by `bin/run-orc.ts` / issue #05: fetch (reply.io only) -> freshness filter (issue #02) ->
 * clean -> split -> agent passes (issue #05, one direct model call per letter) -> verdict
 * collection. No logic of its own beyond sequencing + logging.
 *
 * Every stage prints ONE line on success, format: `[done] <stage>: created <N> <thing> at
 * <path>` — a stalled or silent stage is visible immediately (Goal, issue #10). A stage that
 * errors or produces nothing prints `[fail] <stage>: <reason>` and the run stops right there —
 * no later `[done]` lines are ever printed.
 *
 * ClickUp is fully stubbed here: zero real ClickUp fetch/write calls. Card linkage stays
 * manual (sessions/2026-07-03-registry-design-facts.md §"Agreed 2026-07-03") — a letter's
 * `task_id` is only ever whatever the operator already wrote into a PRIOR `data/registry.json`
 * entry; this script never matches/creates one. Every letter without a mapped `task_id` prints
 * one `[stub] clickup:` line.
 *
 * Offline mode: when the caller passes `fetchReplyio`/`caller` overrides (as the locked test
 * does), the whole run happens with zero network calls — `main()` wires those overrides from
 * `OKB_E2E_FIXTURE=1`, reading the same `src/pipeline/__fixtures__/tracer/` fixtures the other
 * tracer tests use instead of hitting reply.io, and a canned caller instead of Anthropic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchUnreadReplies, type ReplyItem } from '../src/replyio/fetch.ts';
import { clean } from '../src/pipeline/clean/index.ts';
import { split } from '../src/pipeline/split.ts';
import { runSpine, type SpawnFn, type TaskIdLookup } from '../src/orchestrator/spine.ts';
import {
  applyFreshnessFilter,
  clickupStatus,
  type ReplyioRawItem,
  type ReplyioDecision,
  type ReplyioFilterResult,
} from '../src/pipeline/filter.ts';
import { loadRegistry, saveRegistry, type Registry } from '../src/pipeline/registry.ts';
import { defaultLlmCaller, type LlmCaller } from '../src/llm/call.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = join(ROOT, 'src', 'pipeline', '__fixtures__', 'tracer');

export interface RunOkbE2eOpts {
  fetchReplyio?: () => Promise<ReplyItem[]>;
  caller?: LlmCaller;
  concurrency?: number;
}

export interface RunOkbE2eResult {
  ok: boolean;
  failedStage: string | null;
  modelCallCount: number;
}

function log(line: string): void {
  console.log(line);
}

async function stageFetch(dayRoot: string, fetchReplyio: () => Promise<ReplyItem[]>): Promise<ReplyItem[] | null> {
  const rawDir = join(dayRoot, 'inputs', 'raw');
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, 'replyio.json');

  let items: ReplyItem[];
  try {
    items = await fetchReplyio();
  } catch (e) {
    log(`[fail] fetch replyio: ${(e as Error).message}`);
    return null;
  }
  if (items.length === 0) {
    log('[fail] fetch replyio: zero threads fetched');
    return null;
  }

  writeFileSync(rawPath, JSON.stringify(items, null, 2));
  log(`[done] fetch replyio: created ${items.length} thread(s) at ${rawPath}`);
  return items;
}

function stageFilter(dayRoot: string, registry: Registry, items: ReplyioRawItem[]): ReplyioFilterResult | null {
  const rawPath = join(dayRoot, 'inputs', 'raw', 'replyio.json');
  // ClickUp is fully stubbed (zero real fetch) — rule 3 (status-mismatch reprocessing) never
  // fires here; that path is exercised by issue #05's own locked test against the real
  // orchestrator, not this thin e2e script.
  const result = applyFreshnessFilter(registry, items, []);

  if (result.replyioKept.length === 0) {
    log('[fail] filter: zero items kept (all sifted — nothing new or changed)');
    return null;
  }

  writeFileSync(rawPath, JSON.stringify(result.replyioKept, null, 2));
  log(`[done] filter: created ${result.replyioKept.length} kept item(s) at ${rawPath}`);
  return result;
}

async function stageClean(dayRoot: string): Promise<number | null> {
  const flags = await clean(dayRoot);
  for (const f of flags) console.warn(`clean flag: ${f.reason}`);

  const cleanPath = join(dayRoot, 'inputs', 'clean', 'replyio.json');
  if (!existsSync(cleanPath)) {
    log('[fail] clean: no cleaned output written');
    return null;
  }
  const cleaned = JSON.parse(readFileSync(cleanPath, 'utf8')) as unknown[];
  if (cleaned.length === 0) {
    log('[fail] clean: zero threads survived cleaning (all quarantined)');
    return null;
  }

  log(`[done] clean: created ${cleaned.length} cleaned thread(s) at ${cleanPath}`);
  return cleaned.length;
}

async function stageSplit(dayRoot: string): Promise<number | null> {
  const flags = await split(dayRoot);
  for (const f of flags) console.warn(`split flag: ${f.reason}`);

  const emailsDir = join(dayRoot, 'outputs', 'emails', 'replyio');
  if (!existsSync(emailsDir)) {
    log('[fail] split: no letters written');
    return null;
  }
  const threadFiles = readdirSync(emailsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.verdict.json'));
  if (threadFiles.length === 0) {
    log('[fail] split: zero thread files created');
    return null;
  }

  log(`[done] split: created ${threadFiles.length} thread file(s) + ${threadFiles.length} verdict seed(s) at ${emailsDir}`);
  return threadFiles.length;
}

/**
 * Card linkage is manual (issue #05): a letter's task_id is whatever the operator already
 * wrote into a PRIOR registry entry for that key — never matched/created here.
 */
function buildTaskIdLookup(registry: Registry, decisions: ReplyioDecision[]): TaskIdLookup {
  const byThreadId = new Map<string, string | null>();
  for (const decision of decisions) {
    if (decision.kind === 'sift') continue;
    const existing = registry[decision.key];
    const threadId = decision.item ? String(decision.item.id) : existing?.thread_id;
    if (!threadId) continue;
    byThreadId.set(threadId, existing?.task_id ?? null);
  }
  return (threadId: string) => byThreadId.get(threadId) ?? null;
}

/** One [stub] line per letter with no operator-mapped card — zero real ClickUp actions. */
function logClickupStubs(emailsDir: string, taskIdForThread: TaskIdLookup): void {
  const threadFiles = readdirSync(emailsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.verdict.json'));
  for (const f of threadFiles) {
    const id = f.replace(/\.json$/, '');
    if (taskIdForThread(id) === null) {
      log(`[stub] clickup: letter ${id} has no card — creation skipped (manual mapping)`);
    }
  }
}

async function stageAgents(
  dayRoot: string,
  caller: LlmCaller,
  concurrency: number,
  taskIdForThread: TaskIdLookup,
): Promise<number | null> {
  const emailsDir = join(dayRoot, 'outputs', 'emails', 'replyio');
  const noopSpawner: SpawnFn = async (prompt) => {
    throw new Error(`unexpected Claude Code session spawn in OKB e2e run (OKB uses direct calls only): ${prompt}`);
  };

  const spine = await runSpine(dayRoot, noopSpawner, concurrency, undefined, caller, taskIdForThread);

  if (spine.degraded) {
    log(`[fail] agents: ${spine.flags.join('; ')}`);
    return null;
  }
  if (spine.modelCallCount === 0) {
    log('[fail] agents: zero model calls made');
    return null;
  }

  log(
    `[done] agents: created ${spine.modelCallCount} letter(s) judged+drafted ` +
      `(${spine.modelCallCount} model call(s), one per letter) at ${emailsDir}`,
  );
  return spine.modelCallCount;
}

function stageVerdicts(dayRoot: string): number | null {
  const emailsDir = join(dayRoot, 'outputs', 'emails', 'replyio');
  const verdictFiles = readdirSync(emailsDir).filter((f) => f.endsWith('.verdict.json'));
  const filled = verdictFiles.filter((f) => {
    const v = JSON.parse(readFileSync(join(emailsDir, f), 'utf8')) as Record<string, unknown>;
    return v['label'] !== null && v['tc_covered'] !== null && v['reasoning'] !== null && v['draft'] !== null;
  });

  if (filled.length === 0) {
    log('[fail] verdicts: zero verdicts filled');
    return null;
  }

  log(`[done] verdicts: created ${filled.length} verdict(s) filled (label, tc_covered, reasoning, draft) at ${emailsDir}`);
  return filled.length;
}

/** One local OKB e2e run over `data/<date>/`. Injectable fetch/caller for offline/test runs. */
export async function runOkbE2E(root: string, date: string, opts: RunOkbE2eOpts = {}): Promise<RunOkbE2eResult> {
  const dayRoot = join(root, 'data', date);
  mkdirSync(dayRoot, { recursive: true });
  const registry = loadRegistry(root);

  const fetchReplyio =
    opts.fetchReplyio ?? (() => fetchUnreadReplies({ apiKey: process.env.REPLY_API_KEY ?? '', refDate: date }));

  const items = await stageFetch(dayRoot, fetchReplyio);
  if (!items) return { ok: false, failedStage: 'fetch', modelCallCount: 0 };

  const filterResult = stageFilter(dayRoot, registry, items as unknown as ReplyioRawItem[]);
  if (!filterResult) return { ok: false, failedStage: 'filter', modelCallCount: 0 };

  const cleanedCount = await stageClean(dayRoot);
  if (cleanedCount === null) return { ok: false, failedStage: 'clean', modelCallCount: 0 };

  const splitCount = await stageSplit(dayRoot);
  if (splitCount === null) return { ok: false, failedStage: 'split', modelCallCount: 0 };

  const emailsDir = join(dayRoot, 'outputs', 'emails', 'replyio');
  const taskIdForThread = buildTaskIdLookup(registry, filterResult.decisions);
  logClickupStubs(emailsDir, taskIdForThread);

  const caller = opts.caller ?? defaultLlmCaller;
  const modelCallCount = await stageAgents(dayRoot, caller, opts.concurrency ?? 4, taskIdForThread);
  if (modelCallCount === null) return { ok: false, failedStage: 'agents', modelCallCount: 0 };

  // Registry write happens after agent processing (at-least-once, matches bin/run-orc.ts).
  // ClickUp is fully stubbed here, so clickup_status always resolves to null.
  for (const decision of filterResult.decisions) {
    if (decision.kind !== 'new' && decision.kind !== 'status-change') continue;
    const item = decision.item!;
    const id = String(item.id);
    const existing = registry[decision.key];
    registry[decision.key] = {
      thread_id: id,
      task_id: existing?.task_id ?? null,
      clickup_status: clickupStatus(existing?.task_id ?? null, []),
      file: `data/${date}/outputs/emails/replyio/${id}.json`,
      verdict: `data/${date}/outputs/emails/replyio/${id}.verdict.json`,
      redo_draft: null,
    };
  }
  saveRegistry(root, registry);

  const verdictsCount = stageVerdicts(dayRoot);
  if (verdictsCount === null) return { ok: false, failedStage: 'verdicts', modelCallCount };

  return { ok: true, failedStage: null, modelCallCount };
}

/** Offline fixture fetch — same fixtures the other tracer tests read, no network call. */
function fixtureFetchReplyio(): () => Promise<ReplyItem[]> {
  return async () =>
    ['okb-reply.raw.json', 'okb-reply-sequence.raw.json'].map(
      (f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as ReplyItem,
    );
}

/** Offline fixture caller — canned plausible verdict JSON, no Anthropic call. */
function fixtureCaller(): LlmCaller {
  return async () =>
    JSON.stringify({
      tc_covered: { pricing_per_article: true, link_type: false },
      decision_data: { payment_terms: 'confirmed in thread' },
      reasoning: 'offline fixture caller — deterministic canned reasoning',
      draft: 'Thanks for the update — could you confirm the remaining details?',
    });
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const offline = process.env.OKB_E2E_FIXTURE === '1';
  const opts: RunOkbE2eOpts = offline ? { fetchReplyio: fixtureFetchReplyio(), caller: fixtureCaller() } : {};

  console.log(`okb-e2e: running ${date} -> data/${date}${offline ? ' (offline fixture mode)' : ''}`);
  const result = await runOkbE2E(ROOT, date, opts);
  if (!result.ok) {
    console.error(`okb-e2e: FAILED at stage "${result.failedStage}"`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

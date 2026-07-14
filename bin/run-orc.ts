/**
 * Local orchestrator entrypoint. Freshness filter (issue #02) runs BEFORE clean(): trims
 * `inputs/raw/*.json` down to only messages the registry has never seen (or explicitly
 * re-admits), while preserving a full audit copy of everything that was fetched. Registry
 * write for processed messages happens AFTER clean()/split() (at-least-once: crash = reprocess,
 * never lose mail) — see sessions/2026-07-03-registry-design-facts.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clean } from '../src/pipeline/clean/index.ts';
import { split } from '../src/pipeline/split.ts';
import { runSpine, type SpawnFn, type SpineResult, type TaskIdLookup } from '../src/orchestrator/spine.ts';
import { runFollowupSweep, type FollowupCandidate } from '../src/pipeline/followups.ts';
import { loadRegistry, saveRegistry, type Registry, type RegistryEntry } from '../src/pipeline/registry.ts';
import {
  applyGmailFilter,
  applyFreshnessFilter,
  clickupStatus,
  type GmailThreadFileLike,
  type ReplyioRawItem,
  type ReplyioDecision,
  type GmailDecision,
} from '../src/pipeline/filter.ts';
import { defaultLlmCaller, type LlmCaller } from '../src/llm/call.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORC_SETTINGS = join(ROOT, 'src', 'orchestrator', 'orc.settings.json');

function realSpawner(prompt: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile('claude', ['-p', prompt, '--settings', ORC_SETTINGS], { cwd: ROOT });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude exited ${code}`));
    });
  });
}

function readJsonArray<T>(path: string): T[] | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T[];
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Preserve everything that was fetched, then trim the file clean() actually reads. */
function archiveAndTrim(dayRoot: string, source: string, fullItems: unknown[], keptItems: unknown[]): void {
  const rawPath = join(dayRoot, 'inputs', 'raw', `${source}.json`);
  if (!existsSync(rawPath)) return;
  writeJson(join(dayRoot, 'inputs', 'raw', `${source}.full.json`), fullItems);
  writeJson(rawPath, keptItems);
}

/**
 * Pull a redo-admitted message's material straight from its registry-recorded location
 * (possibly a prior day) into today's day folder, with `draft` nulled so the spine's existing
 * per-field resume logic (label/reasoning carried, draft null) re-runs ONLY the write pass.
 */
function admitRedoMaterial(
  root: string,
  dayRoot: string,
  date: string,
  entry: RegistryEntry,
): { file: string; verdict: string } | null {
  if (!entry.file || !entry.verdict) return null;
  const srcFile = join(root, entry.file);
  const srcVerdict = join(root, entry.verdict);
  if (!existsSync(srcFile) || !existsSync(srcVerdict)) return null;

  const parts = entry.file.split('/');
  const id = parts[parts.length - 1].replace(/\.json$/, '');
  const source = parts[parts.length - 2];

  const destDir = join(dayRoot, 'outputs', 'emails', source);
  mkdirSync(destDir, { recursive: true });
  const destFile = join(destDir, `${id}.json`);
  const destVerdict = join(destDir, `${id}.verdict.json`);

  if (srcFile !== destFile) copyFileSync(srcFile, destFile);

  const verdict = JSON.parse(readFileSync(srcVerdict, 'utf8')) as Record<string, unknown>;
  verdict['draft'] = null;
  writeFileSync(destVerdict, JSON.stringify(verdict, null, 2));

  return {
    file: `data/${date}/outputs/emails/${source}/${id}.json`,
    verdict: `data/${date}/outputs/emails/${source}/${id}.verdict.json`,
  };
}

/**
 * Card linkage is manual (issue #05): a letter's task_id is whatever the operator already
 * wrote into a PRIOR registry entry for that key — never computed, never matched, never
 * created here. Built once per run, before the spine call, so the direct OKB caller can inline
 * a mapped card's content; `recordProcessed` (below) carries the same lookup into the registry.
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

/**
 * Gmail mirror of `recordProcessed`: one entry per newly-admitted MESSAGE key, pointers to
 * the thread's split copy + verdict sidecar when the thread made it past clean/split (a
 * quarantined thread — machine mail / blocked sender — is still recorded, with null pointers,
 * so tomorrow's unread poll sifts it instead of re-quarantining forever).
 */
function recordProcessedGmail(
  registry: Registry,
  decisions: GmailDecision[],
  root: string,
  date: string,
): void {
  for (const decision of decisions) {
    if (decision.kind !== 'new') continue;
    const file = `data/${date}/outputs/emails/gmail/${decision.threadId}.json`;
    const verdict = `data/${date}/outputs/emails/gmail/${decision.threadId}.verdict.json`;
    const madeIt = existsSync(join(root, file));
    const existing = registry[decision.key];

    registry[decision.key] = {
      thread_id: decision.threadId,
      task_id: existing?.task_id ?? null,
      clickup_status: null,
      file: madeIt ? file : null,
      verdict: madeIt && existsSync(join(root, verdict)) ? verdict : null,
      redo_draft: null,
    };
  }
}

function recordProcessed(
  registry: Registry,
  decisions: ReplyioDecision[],
  rawClickup: Array<Record<string, unknown>>,
  date: string,
): void {
  for (const decision of decisions) {
    if (decision.kind !== 'new' && decision.kind !== 'status-change') continue;
    const item = decision.item!;
    const id = String(item.id);
    const existing = registry[decision.key];
    const taskId = existing?.task_id ?? null;

    registry[decision.key] = {
      thread_id: id,
      task_id: taskId,
      clickup_status: clickupStatus(taskId, rawClickup),
      file: `data/${date}/outputs/emails/replyio/${id}.json`,
      verdict: `data/${date}/outputs/emails/replyio/${id}.verdict.json`,
      redo_draft: null,
    };
  }
}

function finalizeRedo(
  registry: Registry,
  redoKeys: string[],
  admitted: Map<string, { file: string; verdict: string }>,
  root: string,
): void {
  for (const key of redoKeys) {
    const dest = admitted.get(key);
    if (!dest) continue;
    const verdict = JSON.parse(readFileSync(join(root, dest.verdict), 'utf8')) as Record<string, unknown>;
    if (verdict['draft'] !== null && verdict['draft'] !== undefined) {
      registry[key] = { ...registry[key], file: dest.file, verdict: dest.verdict, redo_draft: false };
    }
  }
}

export interface RunOrcResult {
  registry: Registry;
  decisions: ReplyioDecision[];
  redoKeys: string[];
  gmailDecisions: GmailDecision[];
  spine: SpineResult;
  followups: FollowupCandidate[];
}

/** One local-orchestrator run over `data/<date>/`. Injectable spawner for tests. */
export async function runOrcOnce(
  root: string,
  date: string,
  spawner: SpawnFn,
  concurrency = 4,
  caller: LlmCaller = defaultLlmCaller,
): Promise<RunOrcResult> {
  const dayRoot = join(root, 'data', date);
  const registry = loadRegistry(root);

  const rawGmail = readJsonArray<GmailThreadFileLike>(join(dayRoot, 'inputs', 'raw', 'gmail.json')) ?? [];
  const rawReplyio = readJsonArray<ReplyioRawItem>(join(dayRoot, 'inputs', 'raw', 'replyio.json')) ?? [];
  const rawClickup =
    readJsonArray<Record<string, unknown>>(join(dayRoot, 'inputs', 'raw', 'clickup.json')) ?? [];

  const { gmailKept, decisions: gmailDecisions } = applyGmailFilter(registry, rawGmail);
  const { replyioKept, redoKeys, decisions } = applyFreshnessFilter(registry, rawReplyio, rawClickup);

  archiveAndTrim(dayRoot, 'gmail', rawGmail, gmailKept);
  archiveAndTrim(dayRoot, 'replyio', rawReplyio, replyioKept);

  const admitted = new Map<string, { file: string; verdict: string }>();
  for (const key of redoKeys) {
    const dest = admitRedoMaterial(root, dayRoot, date, registry[key]);
    if (dest) admitted.set(key, dest);
  }

  const cleanFlags = await clean(dayRoot);
  for (const f of cleanFlags) console.warn(`clean flag: ${f.reason}`);

  const splitFlags = await split(dayRoot);
  for (const f of splitFlags) console.warn(`split flag: ${f.reason}`);

  const taskIdForThread = buildTaskIdLookup(registry, decisions);
  const spine = await runSpine(dayRoot, spawner, concurrency, undefined, caller, taskIdForThread);

  // Registry write happens AFTER the day's processing — at-least-once (crash = reprocess).
  recordProcessed(registry, decisions, rawClickup, date);
  recordProcessedGmail(registry, gmailDecisions, root, date);
  finalizeRedo(registry, redoKeys, admitted, root);

  // Follow-up sweep (issue #06) — runs after the new-letter wave so it sees today's verdict
  // updates, and after recordProcessed so a thread that got a fresh letter today is already
  // keyed under its new (fresh) registry entry, not mistaken for a stale one. Zero-cost
  // detection: writes the follow-up draft straight onto the qualifying thread's OWN
  // file/verdict pointers (possibly a prior day), never into today's day folder.
  const followups = await runFollowupSweep(root, registry, caller);

  saveRegistry(root, registry);

  return { registry, decisions, redoKeys, gmailDecisions, spine, followups };
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  console.log(`orc:run ${date} → data/${date}`);
  const result = await runOrcOnce(ROOT, date, realSpawner, 4);
  console.log(JSON.stringify(result.spine, null, 2));
  // Safeguards (issue #08): both guards fire through the run result, never a process crash —
  // this is the one place that turns a degraded result into a non-zero exit code.
  if (result.spine.degraded) {
    console.error(`run degraded: ${result.spine.flags.join('; ')}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

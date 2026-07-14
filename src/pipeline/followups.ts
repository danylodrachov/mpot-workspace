/**
 * Deterministic follow-up sweep (issue #06). Zero model calls to DETECT a follow-up — pure
 * registry + verdict selection. The model is spent only on WRITING the follow-up draft for
 * threads that qualify, via the same write-only call the redo path (issue #07) uses
 * (`messaging-write-outreach.md`), with `who_wrote_last` passed so the draft's tone matches the
 * scene (session 2026-07-03: donor replied but gaps remain / we wrote last and gaps remain —
 * both reduce to "questions uncovered AND >=2 days since the thread's last letter").
 *
 * Runs AFTER the new-letter wave (bin/run-orc.ts calls this after runSpine) so it sees today's
 * verdict updates. A thread that got a letter today always fails the 2-day-age check (its
 * newest key's lastActivityDate is today's), so "no new letter today" falls out of the age
 * check rather than needing a separate today-vs-not check.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry, RegistryEntry } from './registry.ts';
import { loadAgentPrompt, parseModelJson, type LlmCaller } from '../llm/call.ts';
import type { CleanThread } from './clean/schema.ts';

const AGENTS_DIR = fileURLToPath(new URL('../../.claude/agents/', import.meta.url));
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export interface FollowupCandidate {
  key: string;
  entry: RegistryEntry;
  /** Whose message is newest in the thread — drives the write pass's tone, never re-judged. */
  whoWroteLast: 'donor' | 'us';
}

interface OkbVerdictLike {
  tc_covered: Record<string, boolean> | null;
  draft: string | null;
  [k: string]: unknown;
}

/** `replyio:<id>:<lastActivityDate>` — the date is always the last segment (issue #01). */
function lastActivityDateOf(key: string): string | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  return parts.slice(2).join(':');
}

function tcCoveredIncomplete(tc: Record<string, boolean> | null): boolean {
  if (!tc) return false; // never judged yet -> not this sweep's concern (new-letter wave owns it)
  return Object.values(tc).some((v) => v === false);
}

/** One registry key per message (issue #01) -> collapse to the newest key per thread_id. */
function newestKeyPerThread(registry: Registry): Map<string, string> {
  const newest = new Map<string, { key: string; date: string }>();

  for (const [key, entry] of Object.entries(registry)) {
    if (!key.startsWith('replyio:')) continue;
    const date = lastActivityDateOf(key);
    if (!date) continue;

    const current = newest.get(entry.thread_id);
    if (!current || new Date(date).getTime() > new Date(current.date).getTime()) {
      newest.set(entry.thread_id, { key, date });
    }
  }

  const out = new Map<string, string>();
  for (const [threadId, v] of newest) out.set(threadId, v.key);
  return out;
}

/**
 * Pure selection — no model call. Picks the newest registry key per open outreach thread,
 * then filters: verdict must exist with tc_covered judged-but-incomplete, no draft already
 * pending, and >=2 days since that key's lastActivityDate.
 */
export function selectFollowups(root: string, registry: Registry, now: Date): FollowupCandidate[] {
  const out: FollowupCandidate[] = [];

  for (const key of newestKeyPerThread(registry).values()) {
    const entry = registry[key];
    if (!entry.file || !entry.verdict) continue;

    const filePath = join(root, entry.file);
    const verdictPath = join(root, entry.verdict);
    if (!existsSync(filePath) || !existsSync(verdictPath)) continue;

    const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as OkbVerdictLike;
    if (verdict.draft !== null && verdict.draft !== undefined) continue; // draft already pending
    if (!tcCoveredIncomplete(verdict.tc_covered)) continue; // fully covered (or never judged)

    const date = lastActivityDateOf(key);
    if (!date) continue;
    const ageMs = now.getTime() - new Date(date).getTime();
    if (ageMs < TWO_DAYS_MS) continue;

    const thread = JSON.parse(readFileSync(filePath, 'utf8')) as CleanThread;
    const last = thread.messages[thread.messages.length - 1];
    const whoWroteLast: 'donor' | 'us' = last?.isOutbound ? 'us' : 'donor';

    out.push({ key, entry, whoWroteLast });
  }

  return out;
}

/**
 * Drives the write-only call for each selected candidate. Judgment fields (tc_covered,
 * reasoning) are inlined as context only — nothing is re-judged, exactly like the redo
 * continuation branch in src/orchestrator/spine.ts's processOkbLetter.
 */
export async function runFollowupSweep(
  root: string,
  registry: Registry,
  caller: LlmCaller,
  now: Date = new Date(),
): Promise<FollowupCandidate[]> {
  const candidates = selectFollowups(root, registry, now);

  for (const c of candidates) {
    const verdictPath = join(root, c.entry.verdict!);
    const current = JSON.parse(readFileSync(verdictPath, 'utf8')) as OkbVerdictLike;

    const { model, system } = loadAgentPrompt(join(AGENTS_DIR, 'messaging-write-outreach.md'));
    const user = JSON.stringify({ verdict: current, card: null, who_wrote_last: c.whoWroteLast }, null, 2);
    const raw = await caller({ model, system, user });
    const parsed = parseModelJson(raw);

    const next = JSON.parse(readFileSync(verdictPath, 'utf8')) as OkbVerdictLike;
    next.draft = (parsed['draft'] as string | undefined) ?? null;
    writeFileSync(verdictPath, JSON.stringify(next, null, 2));
  }

  return candidates;
}

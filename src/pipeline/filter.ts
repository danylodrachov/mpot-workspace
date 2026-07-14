/**
 * Freshness filter (issue #02) — decides which fetched messages flow onward to clean()/
 * split()/agents vs. get sifted out. Wired into `bin/run-orc.ts`, runs BEFORE clean().
 * Raw stays a full audit copy; only what this filter admits flows onward (`bin/run-orc.ts`
 * archives the full fetch, then trims `inputs/raw/*.json` to the admitted subset).
 *
 * Rules (sessions/2026-07-03-registry-design-facts.md §"Filter logic"):
 *   1. key absent from registry                                  -> process (new)
 *   2. key present, redo_draft: true                              -> process (redo; material
 *      comes from the entry's `file`/`verdict`, NEVER today's raw — today's fetch may not
 *      even contain the message)
 *   3. key present, linked card's current status != recorded `clickup_status` -> process
 *      (status-change; old verdict superseded)
 *   4. key present, status matches, no redo                       -> sift (never reaches clean)
 *
 * Gmail: a thread flows onward when it carries at least one message whose key is absent
 * from the registry (per-message key, ADR 0039 — "already processed" is decided per message
 * id, never by read/unread state). Fully-seen threads sift. Registry recording happens AFTER
 * processing, in `bin/run-orc.ts` (at-least-once), same as reply.io.
 */
import { messageKey, has, type Registry } from './registry.ts';

export interface GmailThreadFileLike {
  threadId: string;
  messages: Array<{ id: string; [k: string]: unknown }>;
}

export interface ReplyioRawItem {
  id: string;
  raw?: { lastActivityDate?: string };
  lastActivityDate?: string;
  [k: string]: unknown;
}

export type ReplyioDecisionKind = 'new' | 'redo' | 'status-change' | 'sift';

export interface ReplyioDecision {
  key: string;
  kind: ReplyioDecisionKind;
  /** null only for 'redo' — that path never touches today's raw fetch. */
  item: ReplyioRawItem | null;
}

export interface ReplyioFilterResult {
  /** items that should flow onward — what `inputs/raw/replyio.json` gets trimmed to. */
  replyioKept: ReplyioRawItem[];
  /** keys admitted purely via redo, independent of today's raw fetch. */
  redoKeys: string[];
  /** one decision per key touched this run (new + redo + status-change + sift). */
  decisions: ReplyioDecision[];
}

function clickupStatus(taskId: string | null, clickupRaw: Array<Record<string, unknown>>): string | null {
  if (!taskId) return null;
  const task = clickupRaw.find((t) => String(t['id']) === taskId);
  return task ? String(task['status'] ?? '') : null;
}

export type GmailDecisionKind = 'new' | 'sift';

export interface GmailDecision {
  key: string;
  kind: GmailDecisionKind;
  threadId: string;
}

export interface GmailFilterResult {
  /** threads that should flow onward — what `inputs/raw/gmail.json` gets trimmed to. */
  gmailKept: GmailThreadFileLike[];
  /** one decision per message key seen this run. */
  decisions: GmailDecision[];
}

/**
 * Gmail side of the filter. A thread is admitted when ANY of its messages is unseen; a
 * sibling message already in the registry still sifts individually (its entry is not
 * re-recorded), but the whole thread's material flows so agents see full context.
 */
export function applyGmailFilter(registry: Registry, rawGmail: GmailThreadFileLike[]): GmailFilterResult {
  const decisions: GmailDecision[] = [];
  const gmailKept: GmailThreadFileLike[] = [];

  for (const thread of rawGmail) {
    let hasUnseen = false;
    for (const message of thread.messages) {
      const key = messageKey('gmail', message as { id: string });
      if (has(registry, key)) {
        decisions.push({ key, kind: 'sift', threadId: thread.threadId });
      } else {
        decisions.push({ key, kind: 'new', threadId: thread.threadId });
        hasUnseen = true;
      }
    }
    if (hasUnseen) gmailKept.push(thread);
  }

  return { gmailKept, decisions };
}

/** reply.io side of the filter — the only source with agent processing today (OKB). */
export function applyFreshnessFilter(
  registry: Registry,
  rawReplyio: ReplyioRawItem[],
  rawClickup: Array<Record<string, unknown>>,
): ReplyioFilterResult {
  const decisions: ReplyioDecision[] = [];
  const replyioKept: ReplyioRawItem[] = [];
  const redoKeys: string[] = [];

  // Rule 2 first — redo admission is independent of today's raw fetch (acceptance #4):
  // scan the registry itself, not the fetched items, so a message that fell off today's
  // unread poll still gets re-admitted.
  for (const [key, entry] of Object.entries(registry)) {
    if (!key.startsWith('replyio:')) continue;
    if (entry.redo_draft === true) {
      redoKeys.push(key);
      decisions.push({ key, kind: 'redo', item: null });
    }
  }
  const redoSet = new Set(redoKeys);

  for (const item of rawReplyio) {
    const key = messageKey('replyio', item);
    if (redoSet.has(key)) continue; // already admitted above — don't double-process

    if (!has(registry, key)) {
      decisions.push({ key, kind: 'new', item });
      replyioKept.push(item);
      continue;
    }

    const entry = registry[key];
    const currentStatus = clickupStatus(entry.task_id, rawClickup);
    if (entry.task_id && currentStatus !== null && currentStatus !== entry.clickup_status) {
      decisions.push({ key, kind: 'status-change', item });
      replyioKept.push(item);
      continue;
    }

    decisions.push({ key, kind: 'sift', item });
  }

  return { replyioKept, redoKeys, decisions };
}

export { clickupStatus };

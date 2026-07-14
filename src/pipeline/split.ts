import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CleanThread, CleanTask } from './clean/schema.ts';

export interface FlagEntry {
  kind: 'flag_operator';
  reason: string;
}

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'pm.me',
  'aol.com', 'yandex.com', 'yandex.ru', 'mail.com', 'inbox.com',
  'prod.outlook.com',
]);

function readJsonArray(path: string): unknown[] | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as unknown[];
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function writeJsonIfAbsent(path: string, data: unknown): void {
  if (!existsSync(path)) writeJson(path, data);
}

function nonFreemailDomain(email: string): string | null {
  const m = email.match(/@([^@>\s]+)$/);
  if (!m) return null;
  const domain = m[1].toLowerCase();
  return FREEMAIL_DOMAINS.has(domain) ? null : domain;
}

function firstUrlHost(text: string): string | null {
  const m = text.match(/https?:\/\/([^/\s,)]+)/);
  return m ? m[1] : null;
}

function outletTokenInSubject(subject: string): string | null {
  const m = subject.match(/\b([a-z0-9][a-z0-9-]*\.[a-z]{2,})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function buildReplyioContactMap(rawItems: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of rawItems) {
    const r = item as Record<string, unknown>;
    const id = String(r['id'] ?? '');
    if (!id) continue;
    const company = typeof r['company'] === 'string' ? r['company'].trim() : '';
    const email = typeof r['email'] === 'string' ? r['email'] : '';
    const media = company || nonFreemailDomain(email) || null;
    if (media) map.set(id, media);
  }
  return map;
}

/**
 * Board routing data (issue #04): the raw reply.io thread carries `raw.sequence.name`
 * (which sequence enrolled the contact). Since issue #09, `clean()` also carries this
 * onto the cleaned thread's `sequence` field directly — this raw-item map stays as the
 * primary source (covers items whose clean pass predates #09 or was quarantined) and
 * `thread.sequence` is the fallback below. Reading it straight off the raw item here
 * means no model call is ever needed to know a reply.io thread's board/sequence.
 */
function buildReplyioSequenceMap(rawItems: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of rawItems) {
    const r = item as Record<string, unknown>;
    const id = String(r['id'] ?? '');
    if (!id) continue;
    const raw = r['raw'] as Record<string, unknown> | undefined;
    const seq = raw?.['sequence'] as Record<string, unknown> | undefined;
    const name = typeof seq?.['name'] === 'string' ? seq['name'] : null;
    if (name) map.set(id, name);
  }
  return map;
}

function resolveMedia(
  thread: CleanThread,
  source: string,
  contactMap: Map<string, string>,
): string | null {
  if (source === 'replyio') {
    const contact = contactMap.get(thread.id);
    if (contact) return contact;
  }
  const from = thread.messages[0]?.from ?? '';
  const domain = nonFreemailDomain(from);
  if (domain) return domain;
  const token = outletTokenInSubject(thread.subject);
  if (token) return token;
  const body = thread.messages[0]?.body ?? '';
  return firstUrlHost(body);
}

const THREAD_VERDICT_TEMPLATE = {
  source: null,
  thread_id: null,
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

const TASK_VERDICT_TEMPLATE = {
  board: null,
  task_id: null,
  task_name: null,
  current_lane: null,
  decision_data: { package_size: null, payment_terms: null, correction_items: null },
  reasoning: null,
  user_feedback: null,
  AI_feedback: null,
};

export async function split(root: string): Promise<FlagEntry[]> {
  const flags: FlagEntry[] = [];

  const rawReplyio = readJsonArray(join(root, 'inputs', 'raw', 'replyio.json')) ?? [];
  const contactMap = buildReplyioContactMap(rawReplyio);
  const sequenceMap = buildReplyioSequenceMap(rawReplyio);

  for (const source of ['replyio', 'gmail'] as const) {
    const threads = readJsonArray(join(root, 'inputs', 'clean', `${source}.json`)) as CleanThread[] | null;
    if (!threads) continue;

    const emailsDir = join(root, 'outputs', 'emails', source);
    mkdirSync(emailsDir, { recursive: true });

    for (const thread of threads) {
      try {
        writeJson(join(emailsDir, `${thread.id}.json`), thread);
        const sequence = source === 'replyio'
          ? (sequenceMap.get(thread.id) ?? thread.sequence ?? null)
          : (thread.sequence ?? null);

        writeJsonIfAbsent(join(emailsDir, `${thread.id}.verdict.json`), {
          ...THREAD_VERDICT_TEMPLATE,
          source,
          thread_id: thread.id,
          sequence,
          media: resolveMedia(thread, source, contactMap),
        });
      } catch (e) {
        flags.push({ kind: 'flag_operator', reason: `split ${source} ${thread.id}: ${(e as Error).message}` });
      }
    }
  }

  const tasks = readJsonArray(join(root, 'inputs', 'clean', 'clickup.json')) as CleanTask[] | null;
  if (tasks) {
    const tasksDir = join(root, 'outputs', 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    for (const task of tasks) {
      try {
        writeJson(join(tasksDir, `${task.id}.json`), task);
        writeJsonIfAbsent(join(tasksDir, `${task.id}.verdict.json`), {
          ...TASK_VERDICT_TEMPLATE,
          board: task.board,
          task_id: task.id,
          task_name: task.name,
          current_lane: task.status,
        });
      } catch (e) {
        flags.push({ kind: 'flag_operator', reason: `split clickup ${task.id}: ${(e as Error).message}` });
      }
    }
  }

  return flags;
}

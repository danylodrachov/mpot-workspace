import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGmail } from './gmail.ts';
import { cleanReplyio } from './replyio.ts';
import { cleanClickup } from './clickup.ts';
import { isMachineMail } from '../../lib/machine-mail.ts';
import type { GmailThreadFile } from '../../gmail/fetch.ts';

export interface FlagEntry {
  kind: 'flag_operator';
  reason: string;
}

function readRaw(root: string, source: string): unknown[] | null {
  const p = join(root, 'inputs', 'raw', `${source}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as unknown[];
}

function writeClean(root: string, source: string, items: unknown[]): void {
  const dir = join(root, 'inputs', 'clean');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${source}.json`), JSON.stringify(items, null, 2));
}

function writeQuarantine(root: string, id: string, payload: unknown): void {
  const dir = join(root, 'inputs', 'clean', '_quarantine');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(payload, null, 2));
}

/**
 * Blocked-senders list — operator-maintained spam addresses that must never reach an agent.
 * Lives next to this module so editing it never touches code. Matched on the NEWEST INBOUND
 * message's sender address (exact, case-insensitive), same judging surface as the
 * machine-mail gate below.
 */
const BLOCKED_SENDERS_PATH = fileURLToPath(new URL('./blocked-senders.json', import.meta.url));

function loadBlockedSenders(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(BLOCKED_SENDERS_PATH, 'utf8')) as { senders?: string[] };
    return new Set((parsed.senders ?? []).map((s) => s.toLowerCase().trim()));
  } catch {
    return new Set();
  }
}

/** "Name <a@b.c>" or bare "a@b.c" → "a@b.c" (lowercased); null when no address found. */
function senderAddress(from: string): string | null {
  const m = from.match(/<([^<>\s]+@[^<>\s]+)>/) ?? from.match(/([^\s<>,;"']+@[^\s<>,;"']+)/);
  return m ? m[1].toLowerCase() : null;
}

function newestInboundFrom(source: string, raw: unknown): string {
  if (source === 'gmail') {
    const thread = raw as { messages?: Array<{ from?: string; isOutbound?: boolean }> };
    const inbound = (thread.messages ?? []).filter((m) => !m?.isOutbound);
    return String(inbound[inbound.length - 1]?.from ?? '');
  }
  if (source === 'replyio') {
    const item = raw as Record<string, unknown>;
    return String(item['from'] ?? item['email'] ?? '');
  }
  return '';
}

function isBlockedSender(source: string, raw: unknown, blocked: Set<string>): boolean {
  try {
    const address = senderAddress(newestInboundFrom(source, raw));
    return address !== null && blocked.has(address);
  } catch {
    return false;
  }
}

/**
 * Machine-mail gate (issue #03) — replaces the classify.md pre-filter with code.
 * Judges the NEWEST INBOUND message of a raw gmail/replyio item; human senders who merely
 * quote a machine phrase in the body are untouched (only headers/from/subject are checked).
 */
function isInboundMachineMail(source: string, raw: unknown): boolean {
  try {
    if (source === 'gmail') {
      const thread = raw as {
        messages?: Array<{ from?: string; subject?: string; isOutbound?: boolean; headers?: Record<string, string> }>;
      };
      const inbound = (thread.messages ?? []).filter((m) => !m?.isOutbound);
      const newest = inbound[inbound.length - 1];
      if (!newest) return false;
      return isMachineMail({
        from: String(newest.from ?? ''),
        subject: String(newest.subject ?? ''),
        ...(newest.headers ?? {}),
      });
    }
    if (source === 'replyio') {
      const item = raw as Record<string, unknown>;
      return isMachineMail({
        from: String(item['from'] ?? item['email'] ?? ''),
        subject: String(item['subject'] ?? ''),
      });
    }
    return false;
  } catch {
    return false;
  }
}

function rawItemId(source: string, raw: unknown): string {
  const r = raw as Record<string, unknown>;
  if (source === 'gmail') return String(r['threadId'] ?? 'unknown');
  return String(r['id'] ?? 'unknown');
}

export async function clean(root: string): Promise<FlagEntry[]> {
  const flags: FlagEntry[] = [];
  const blockedSenders = loadBlockedSenders();

  const sources: Array<{ name: string; fn: (raw: unknown) => unknown }> = [
    { name: 'gmail', fn: (r) => cleanGmail(r as GmailThreadFile) },
    { name: 'replyio', fn: cleanReplyio },
    { name: 'clickup', fn: cleanClickup },
  ];

  for (const { name, fn } of sources) {
    const rawItems = readRaw(root, name);
    if (rawItems === null) continue;

    const cleaned: unknown[] = [];
    for (const raw of rawItems) {
      if (isBlockedSender(name, raw, blockedSenders)) {
        writeQuarantine(root, rawItemId(name, raw), { reason: 'blocked-sender', raw });
        continue; // spam gate: never split, never seeded, never spawned
      }

      if (isInboundMachineMail(name, raw)) {
        writeQuarantine(root, rawItemId(name, raw), { reason: 'machine-mail', raw });
        continue; // junk gate: never split, never seeded, never spawned
      }

      try {
        cleaned.push(fn(raw));
      } catch (e) {
        const id = String((raw as Record<string, unknown>)?.['id'] ?? 'unknown');
        writeQuarantine(root, id, { error: String(e), raw });
        flags.push({ kind: 'flag_operator', reason: `clean ${name} ${id}: ${(e as Error).message}` });
        console.warn(`clean: quarantined ${name} ${id} — ${(e as Error).message}`);
      }
    }

    writeClean(root, name, cleaned);
  }

  return flags;
}

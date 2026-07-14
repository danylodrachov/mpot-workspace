/**
 * Reply.io fetch — v3 inbox (issue #04, ADR 0036).
 *
 * Reads ALL INBOUND email threads (source:"inbox" = ≥1 inbound message, read-state agnostic),
 * time-gated via the native `from: refDate − 2d` param (lastActivityDate). Two read-only hops:
 *   1. POST /v3/inbox/threads/filter  { source:"inbox", channels:["email"], from:<refDate-2d> }
 *      (thread carries only `bodyPreview`, a snippet — not the full reply body).
 *   2. GET  /v3/inbox/threads/{id}/messages?top=50  -> per-thread messages; the full inbound
 *      body is the NEWEST message with isOutbound:false. Messages have no per-message id —
 *      thread-level lastActivityDate + id is the idempotency key.
 *
 * Fetch-all: one ReplyItem per thread (operator decision), `raw` = the thread object for the
 * downstream subagent. Fetch-not-extract — the inbound `body` is stored AS-IS (HTML is fine);
 * the downstream message-reader strips quotes later (no email-reply-parser here).
 *
 * Plane (ADR 0036): raw REST v3, header `Authorization: Bearer <apiKey>`. GET/POST read-only —
 * never marks a thread read, never sends. The HTTP `fetcher` is injectable so the test stubs
 * the one boundary; native fetch is the default (no new deps).
 */
import 'dotenv/config';
import pLimit from 'p-limit';

const BASE = 'https://api.reply.io/v3';
const REPLYIO_TIMEOUT_MS = 20_000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** One inbound reply thread, shaped to the fields a reader extracts (raw thread kept for the subagent). */
export interface ReplyItem {
  source: 'replyio';
  id: string;
  lastActivityDate?: string; // thread lastActivityDate — part of idempotency key (id + lastActivityDate)
  subject?: string;
  body: string; // full inbound body from the drill-in (may be HTML); falls back to bodyPreview
  from?: string; // inbound message fromAddress; falls back to the contact email
  date?: string; // inbound message date (ISO 8601); falls back to thread lastActivityDate
  email?: string; // contact email
  name?: string; // contact fullName
  company?: string; // contact companyName
  raw: unknown; // the thread object
}

export interface FetchUnreadRepliesArgs {
  apiKey: string;
  refDate?: string; // YYYY-MM-DD; defaults to today; drives the from: date-window param
  fetcher?: Fetcher; // the stubbable HTTP boundary
}

/** Thread shape from /inbox/threads/filter (only the fields we read). */
interface Thread {
  id: number;
  channel?: string;
  isRead?: boolean;
  subject?: string;
  bodyPreview?: string;
  lastActivityDate?: string;
  contact?: { fullName?: string; email?: string; companyName?: string };
  status?: { state?: string };
}

/** Message shape from /inbox/threads/{id}/messages (only the fields we read). */
interface ThreadMessage {
  isOutbound?: boolean;
  body?: string;
  fromAddress?: string;
  subject?: string;
  date?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100; // safety guard so a never-falsey hasMore can't loop forever

function refMinus2dISO(refDate?: string): string {
  const d = refDate ? new Date(`${refDate}T00:00:00Z`) : new Date();
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString();
}

/**
 * Fetch ALL inbound email threads (source:"inbox") from Reply.io v3 active within the last
 * 2 days, resolving each one's full inbound body via the per-thread messages drill-in.
 * Returns one ReplyItem per thread.
 */
export async function fetchUnreadReplies(args: FetchUnreadRepliesArgs): Promise<ReplyItem[]> {
  const { apiKey } = args;
  const doFetch = args.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const from = refMinus2dISO(args.refDate);

  // 1) Page through all inbound email threads active within the last 2 days.
  const threads: Thread[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await doFetch(`${BASE}/inbox/threads/filter`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'inbox',
        channels: ['email'],
        from,
        top: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      }),
      signal: AbortSignal.timeout(REPLYIO_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`POST /inbox/threads/filter -> ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { items?: Thread[]; hasMore?: boolean };
    threads.push(...(body.items ?? []));
    if (!body.hasMore) break;
  }

  console.log(`reply.io: ${threads.length} thread(s), fetching full bodies...`);

  // 2) Drill into each thread for the full inbound body in parallel (bounded concurrency).
  // Per-item failures are tolerated: a bad drill-in falls back to bodyPreview rather than
  // aborting the whole source.
  const drillLimit = pLimit(6);

  const items = await Promise.all(
    threads.map((t) =>
      drillLimit(async () => {
        let inbound: ThreadMessage | null = null;
        try {
          inbound = await newestInbound(doFetch, headers, t.id);
        } catch (err) {
          console.warn(`reply.io: skipping drill-in for thread ${t.id} — ${(err as Error).message}`);
        }
        return {
          source: 'replyio' as const,
          id: String(t.id),
          lastActivityDate: t.lastActivityDate,
          subject: inbound?.subject ?? t.subject,
          body: inbound?.body ?? t.bodyPreview ?? '',
          from: inbound?.fromAddress ?? t.contact?.email,
          date: inbound?.date ?? t.lastActivityDate,
          email: t.contact?.email,
          name: t.contact?.fullName,
          company: t.contact?.companyName,
          raw: t,
        } as ReplyItem;
      }),
    ),
  );

  console.log(`reply.io: ${items.length} item(s) resolved`);
  return items;
}

/**
 * Drill into one thread's messages and return the NEWEST inbound (isOutbound:false) message,
 * or null if the thread has no inbound message (caller then falls back to thread bodyPreview).
 */
async function newestInbound(
  doFetch: Fetcher,
  headers: Record<string, string>,
  threadId: number,
): Promise<ThreadMessage | null> {
  const res = await doFetch(`${BASE}/inbox/threads/${threadId}/messages?top=50`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REPLYIO_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET /inbox/threads/${threadId}/messages -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { items?: ThreadMessage[] };
  const inbound = (body.items ?? []).filter((m) => m.isOutbound === false);
  if (!inbound.length) return null;
  // Newest by date desc; missing dates sort last so a dated message wins.
  inbound.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return inbound[0]!;
}

// Standalone debug run: prints a short summary. Guarded with the import.meta.url ===
// pathToFileURL(argv[1]) pattern so importing this module (e.g. from fetch-to-day) does
// NOT fire a live API call.
async function main() {
  const key = process.env.REPLY_API_KEY;
  if (!key) throw new Error('Missing REPLY_API_KEY in .env');
  const items = await fetchUnreadReplies({ apiKey: key });
  console.log(`reply.io: ${items.length} unread inbound thread(s)`);
  for (const i of items) {
    console.log(`  ${i.id}  ${i.from ?? '?'}  ${i.subject ?? ''}`);
  }
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error('ERR', e); process.exit(1); });
}

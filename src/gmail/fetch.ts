/**
 * Gmail fetch — thread discover-then-hydrate (issue #03, ADR 0034/0039).
 *
 * One threads.list page (q=`is:unread in:inbox`, maxResults=50, page 1 = freshest only) → threads.get (format:full) per
 * thread. Output: GmailThreadFile[] where messages[] runs oldest→newest, each message carries
 * isOutbound (SENT in labelIds) + attachments metadata. Body/attachment extraction delegates
 * to parse.ts (gmail-api-parse-message); hand-rolled walkers deleted.
 */
import { getGmailClient } from './client.ts';
import { extractText, extractAttachments, type GmailAttachment } from './parse.ts';

export type { GmailAttachment };

export interface GmailThreadMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  text: string;
  isOutbound: boolean;
  attachments: GmailAttachment[];
  /** Lowercased header-name -> value, for machine-mail detection (issue #03). Not exhaustive UI data. */
  headers: Record<string, string>;
}

export interface GmailThreadFile {
  threadId: string;
  messages: GmailThreadMessage[];
}

interface GmailLike {
  users: {
    threads: {
      list: (params: any, options?: any) => Promise<{ data: { threads?: { id?: string | null }[]; nextPageToken?: string | null } }>;
      get: (params: any, options?: any) => Promise<{ data: { id?: string; messages?: any[] } }>;
    };
  };
}

function header(headers: any[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  const h = (headers ?? []).find((x: any) => String(x?.name ?? '').toLowerCase() === lower);
  return h?.value ?? '';
}

/** All headers, lowercased name -> value — feeds isMachineMail (issue #03). */
function headerMap(headers: any[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = String(h?.name ?? '').toLowerCase();
    if (name) map[name] = String(h?.value ?? '');
  }
  return map;
}

function toISO(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export async function fetchRecent(args: {
  /** Kept for call-site compatibility; the all-unread query is date-independent. */
  refDate?: string;
  tz?: string;
  gmail?: GmailLike;
} = {}): Promise<GmailThreadFile[]> {
  const gmail = args.gmail ?? (getGmailClient() as unknown as GmailLike);
  const q = `is:unread in:inbox`;

  const list = await gmail.users.threads.list({ userId: 'me', q, maxResults: 50 }, { timeout: 15000 });
  const threadIds: string[] = (list.data.threads ?? []).flatMap(t => t.id ? [t.id] : []);

  const out: GmailThreadFile[] = [];
  for (const threadId of threadIds) {
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }, { timeout: 15000 });
    const thread = res.data ?? {};
    const rawMsgs: any[] = (thread.messages ?? []).slice().sort(
      (a: any, b: any) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );

    const messages: GmailThreadMessage[] = rawMsgs.map((msg: any) => ({
      id: msg.id ?? '',
      threadId: msg.threadId ?? threadId,
      from: header(msg.payload?.headers, 'From'),
      subject: header(msg.payload?.headers, 'Subject') || '(no subject)',
      date: toISO(header(msg.payload?.headers, 'Date')),
      text: extractText(msg),
      isOutbound: Array.isArray(msg.labelIds) && (msg.labelIds as string[]).includes('SENT'),
      attachments: extractAttachments(msg),
      headers: headerMap(msg.payload?.headers),
    }));

    out.push({ threadId, messages });
  }
  return out;
}

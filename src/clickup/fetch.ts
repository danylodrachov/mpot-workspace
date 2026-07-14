/**
 * ClickUp fetch client — raw REST v2, parameterized (retrieval-spine PRD, stories 6,7,8,16,31,32).
 *
 * Replaces the single-task hierarchy probe. One reusable client for the ClickUp source:
 * the caller passes its query as RUNTIME params (assignees / updated-window / statuses) —
 * the daily filter is the caller's object, never a module constant.
 *
 * Plane (ADR 0035): raw REST v2, token in one header, daily filters as query params on the
 * filtered-team-task view (`assignees[]`, `statuses[]`, `date_updated_gt/lt`). Board kanban
 * cards carry no due date — the daily working set is "touched recently", not "due". ~5 calls earn no
 * dependency. The HTTP `fetcher` is injectable so the test stubs the one boundary.
 *
 * Each task is tagged with its board origin (`outreach` | `content`) from its list/folder
 * name, so the path encodes the grain and the downstream spawn-typing is a substring check,
 * not a field. Tasks on neither board are dropped — the daily filter is the caller's, and an
 * unrecognized board is never guessed into one (grill-guard: HALT, don't guess past it).
 *
 * Returns the JSON array in-memory only (issue #04: the `clickup tasks/<board>/` per-task
 * writer was dead code — the caller already writes the returned array to
 * `inputs/raw/clickup.json` and the spine reads `outputs/tasks/`, never this path).
 * GET only — never writes/moves a card.
 */
import pLimit from 'p-limit';

const BASE = 'https://api.clickup.com/api/v2';
const PAGE = 25; // Comment endpoints return the 25 newest, reverse-chron; a page < 25 is the last.
const TASK_PAGE = 100; // Filtered-team-task caps at 100/page; a page < 100 is the last (no last_page meta).

type Board = 'outreach' | 'content';

/** Daily filter, supplied by the caller (story 6/7) — never baked into the client. */
export interface ClickUpQuery {
  assignees: string[]; // assignee ids; -> assignees[]
  statuses?: string[]; // -> statuses[]
  updatedGt?: number; // epoch ms -> date_updated_gt
  updatedLt?: number; // epoch ms -> date_updated_lt
  listIds?: string[]; // scope to these board lists -> list_ids[]; omit = whole team
}

export interface FetchTasksArgs {
  teamId: string;
  token: string;
  query: ClickUpQuery;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>; // the stubbable boundary
}

/** One ClickUp task, shaped to the signal fields a reader extracts (raw kept for the subagent). */
export interface ClickUpItem {
  source: 'clickup';
  id: string;
  name: string;
  board: Board;
  status: string;
  assignees: string[]; // usernames (display); ids live in raw
  due: string | null; // due_date epoch-ms string, or null
  url?: string;
  list: string;
  comments: StoredComment[]; // full thread (all pages + replies), oldest-first; see fetchAllComments
  raw: unknown;
}

/** One comment projected to the signal fields a reader extracts. `comment_text` is flat plain text. */
export interface StoredComment {
  id: string;
  comment_text: string;
  user: unknown;
  date: string; // Unix ms as a string
  resolved: boolean;
  parent: string | null; // null = top-level; else the parent comment id
  reply_count: number;
}

/** Raw v2 comment as the comment/reply endpoints return it (only the fields we read). */
interface V2Comment {
  id: string;
  comment_text?: string;
  user?: unknown;
  date?: string;
  resolved?: boolean;
  reply_count?: number;
}

/** Hand-written shape of the v2 filtered-team-task response we read (only the fields we use). */
interface V2Task {
  id: string;
  name: string;
  status?: { status?: string };
  due_date?: string | null;
  assignees?: Array<{ id?: number; username?: string }>;
  url?: string;
  list?: { name?: string };
  folder?: { name?: string } | null;
}

/** Classify a task's board from its list/folder name. Unknown board -> null (dropped, never guessed). */
function boardOf(t: V2Task): Board | null {
  const hay = `${t.list?.name ?? ''} ${t.folder?.name ?? ''}`;
  if (/outreach/i.test(hay)) return 'outreach';
  if (/content/i.test(hay)) return 'content';
  return null;
}

function buildUrl(teamId: string, q: ClickUpQuery, page: number): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  // Operator decision (issue #51): subtasks=true — a revision subtask is still agent work, so it
  // belongs in the daily set. include_closed left OFF (default) — "touched recently" is open-only.
  p.set('subtasks', 'true');
  for (const a of q.assignees) p.append('assignees[]', a);
  for (const s of q.statuses ?? []) p.append('statuses[]', s);
  for (const l of q.listIds ?? []) p.append('list_ids[]', l);
  if (q.updatedGt != null) p.set('date_updated_gt', String(q.updatedGt));
  if (q.updatedLt != null) p.set('date_updated_lt', String(q.updatedLt));
  return `${BASE}/team/${teamId}/task?${p.toString()}`;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** GET with token header; on 429, honor Retry-After (read-only GET) and retry once. */
async function getJson(
  url: string,
  token: string,
  doFetch: Fetcher,
): Promise<Response> {
  let res = await doFetch(url, {
    method: 'GET',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After') ?? '1');
    await new Promise((r) => setTimeout(r, (Number.isFinite(retry) ? retry : 1) * 1000));
    res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
  }
  return res;
}

/**
 * Page a ClickUp comment endpoint: 25 newest reverse-chron per page, cursor = the last (oldest)
 * element of the page via the `start` (date ms) + `start_id` PAIR. Stops on a short/empty page;
 * dedupes by id (the boundary comment reappears); breaks if the cursor id fails to advance.
 * Returns `[]` if the first request is non-OK (e.g. a stub that doesn't know the endpoint).
 */
async function pageAllComments(
  baseUrl: string,
  token: string,
  doFetch: Fetcher,
): Promise<V2Comment[]> {
  const byId = new Map<string, V2Comment>();
  let start: string | undefined;
  let startId: string | undefined;

  for (;;) {
    const url = new URL(baseUrl);
    if (start != null && startId != null) {
      url.searchParams.set('start', start);
      url.searchParams.set('start_id', startId);
    }
    const res = await getJson(url.toString(), token, doFetch);
    if (!res.ok) return start == null ? [] : Array.from(byId.values());

    const body = (await res.json()) as { comments?: V2Comment[] };
    const page = body.comments ?? [];
    for (const c of page) byId.set(c.id, c);

    if (page.length < PAGE) break; // short page = last page

    const cursor = page[page.length - 1]!; // oldest of the page
    if (cursor.id === startId) break; // safety: cursor did not advance
    start = cursor.date ?? '';
    startId = cursor.id;
  }

  return Array.from(byId.values());
}

function project(c: V2Comment, parent: string | null): StoredComment {
  return {
    id: c.id,
    comment_text: c.comment_text ?? '',
    user: c.user,
    date: c.date ?? '',
    resolved: c.resolved ?? false,
    parent,
    reply_count: c.reply_count ?? 0,
  };
}

function uniqueById(cs: StoredComment[]): StoredComment[] {
  const byId = new Map<string, StoredComment>();
  for (const c of cs) byId.set(c.id, c);
  return Array.from(byId.values());
}

/**
 * Fetch the COMPLETE comment thread for one task: paged top-level comments (§1) plus, for any
 * with `reply_count>0`, their paged threaded replies (§2). Assembled (§3) as flat StoredComments
 * tagged with `parent`, deduped by id, oldest-first. Reply fetches are bounded by p-limit(5).
 * A non-OK top-level response yields `[]` (keeps the issue-10 stub, which 404s here, green).
 */
export async function fetchAllComments(args: {
  taskId: string;
  token: string;
  fetcher?: Fetcher;
}): Promise<StoredComment[]> {
  const { taskId, token } = args;
  const doFetch = args.fetcher ?? fetch;

  const top = await pageAllComments(`${BASE}/task/${taskId}/comment`, token, doFetch);

  const out: StoredComment[] = [];
  const limit = pLimit(5);

  const replyBatches = await Promise.all(
    top.map((c) =>
      c.reply_count && c.reply_count > 0
        ? limit(() => pageAllComments(`${BASE}/comment/${c.id}/reply`, token, doFetch).then((rs) => ({ parent: c.id, rs })))
        : Promise.resolve(null),
    ),
  );

  for (const c of top) out.push(project(c, null));
  for (const batch of replyBatches) {
    if (!batch) continue;
    for (const r of batch.rs) out.push(project(r, batch.parent));
  }

  return uniqueById(out).sort((a, b) => Number(a.date) - Number(b.date));
}

/**
 * Fetch the daily ClickUp working set and return the resolved objects (in-memory only —
 * see module header). The daily filter is the caller's `query` object.
 */
export async function fetchTasks(args: FetchTasksArgs): Promise<ClickUpItem[]> {
  const { teamId, token, query } = args;
  const doFetch = args.fetcher ?? fetch;

  // Paginate the filtered-team-task view: ClickUp returns no last_page/total, so the documented
  // last-page signal is a page that comes back with fewer than 100 tasks. Loop incrementing `page`
  // and concatenate until a short page (or empty) stops us — a >100-task day must not truncate.
  const tasks: V2Task[] = [];
  for (let page = 0; ; page++) {
    const url = buildUrl(teamId, query, page);
    const res = await getJson(url, token, doFetch);
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { tasks?: V2Task[] };
    const pageTasks = body.tasks ?? [];
    tasks.push(...pageTasks);
    if (pageTasks.length < TASK_PAGE) break; // short page = last page
  }

  const resolved: ClickUpItem[] = [];

  for (const t of tasks) {
    const board = boardOf(t);
    if (!board) continue; // not an agent-surface board — drop, don't guess

    const item: ClickUpItem = {
      source: 'clickup',
      id: String(t.id),
      name: t.name,
      board,
      status: t.status?.status ?? '',
      assignees: (t.assignees ?? []).map((a) => a.username ?? String(a.id)).filter(Boolean),
      due: t.due_date ?? null,
      url: t.url,
      list: t.list?.name ?? '',
      comments: [],
      raw: t,
    };

    // Comments are a separate v2 resource (never inlined on the task) — fetch + attach the full
    // thread. Same injected fetcher + token.
    item.comments = await fetchAllComments({ taskId: item.id, token, fetcher: args.fetcher });

    resolved.push(item);
  }

  return resolved;
}

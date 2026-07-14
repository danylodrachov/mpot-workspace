/**
 * Fetch-to-day (issue #02): pull ALL matching items from each source and write ONE blob per
 * source into `inputs/raw/<source>.json` (fetch-not-extract, no per-item split). Downstream
 * stages (cleaner, splitter) consume these blobs; this stage never touches `outputs/`.
 *
 * Destinations (issue #02, ADR 0027 revised):
 *   gmail   -> inputs/raw/gmail.json     (array of GmailThreadFile)
 *   reply.io-> inputs/raw/replyio.json   (array of ReplyioItem)
 *   clickup -> inputs/raw/clickup.json   (array of ClickUpItem)
 *
 * Run via `npm run fetch:day` (builds the day folder first via bin/build-day.sh).
 * Each source is independent: if one is unreachable, the others still land.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchRecent } from '../gmail/fetch.ts';
import { fetchUnreadReplies } from '../replyio/fetch.ts';
import { fetchTasks } from '../clickup/fetch.ts';

const DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const ROOT = join('data', DATE);

/**
 * Write ONE JSON file per item into `dir` (mkdir -p first), naming each via `name(item)`.
 * Returns the written paths — kept for existing callers and tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeItems<T>(dir: string, items: T[], name: (item: T) => string): string[] {
  mkdirSync(dir, { recursive: true });
  return items.map((item) => {
    const path = join(dir, name(item));
    writeFileSync(path, JSON.stringify(item, null, 2));
    return path;
  });
}

/** Injectable source functions; undefined sources are skipped. */
export interface RawFetchers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gmail?: () => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replyio?: () => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clickup?: () => Promise<any[]>;
}

async function tryEach<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.log(`  ${label}: SKIPPED — ${(e as Error).message}`);
    return null;
  }
}

/**
 * Fetch all sources and write one raw blob per source into `<root>/inputs/raw/`.
 * Writes nothing to `outputs/`. Injectable for tests.
 */
export async function fetchToRaw(root: string, fetchers: RawFetchers): Promise<void> {
  const rawDir = join(root, 'inputs', 'raw');
  mkdirSync(rawDir, { recursive: true });

  for (const source of ['gmail', 'replyio', 'clickup'] as const) {
    const fn = fetchers[source];
    if (!fn) continue;
    await tryEach(source, async () => {
      const items = await fn();
      writeFileSync(join(rawDir, `${source}.json`), JSON.stringify(items, null, 2));
      console.log(`  ${source} → ${items.length} item(s) → inputs/raw/${source}.json`);
    });
  }
}

async function main() {
  console.log(`fetching all into ${ROOT}/inputs/raw/ ...`);

  await fetchToRaw(ROOT, {
    gmail: () => fetchRecent({ refDate: DATE }),
    replyio: () => fetchUnreadReplies({ apiKey: process.env.REPLY_API_KEY! }),
    clickup: async () => {
      const token = process.env.CLICKUP_TOKEN;
      if (!token) throw new Error('set CLICKUP_TOKEN in .env');
      const cfgPath = fileURLToPath(new URL('../clickup/clickup.config.json', import.meta.url));
      const { teamId, assigneeId: assignee, lists } = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        teamId: string;
        assigneeId: string;
        lists?: Array<{ id: string; name: string }>;
      };
      if (!teamId || !assignee || /^REPLACE_WITH_/.test(teamId) || /^REPLACE_WITH_/.test(assignee)) {
        throw new Error('set teamId / assigneeId in src/clickup/clickup.config.json');
      }
      const outreachStatuses = JSON.parse(
        readFileSync(fileURLToPath(new URL('../clickup/outreach.statuses.json', import.meta.url)), 'utf8'),
      ) as { statuses: string[] };
      const contentStatuses = JSON.parse(
        readFileSync(fileURLToPath(new URL('../clickup/content.statuses.json', import.meta.url)), 'utf8'),
      ) as { statuses: string[] };
      const statuses = [...outreachStatuses.statuses, ...contentStatuses.statuses];
      const DAY = 86_400_000;
      const end = new Date(`${DATE}T23:59:59.999Z`).getTime();
      const start = end - 3 * DAY;
      return fetchTasks({
        teamId,
        token,
        query: {
          assignees: [assignee],
          updatedGt: start,
          updatedLt: end,
          listIds: lists?.map((l) => l.id),
          statuses,
        },
      });
    },
  });

  console.log('done. verify with: npm run day:check');
}

// Only run when invoked directly (e.g. `npm run fetch:day`); importing this module for
// `writeItems`/`fetchToRaw` must NOT fire live fetches.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error('ERR', e); process.exit(1); });
}

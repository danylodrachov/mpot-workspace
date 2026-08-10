import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// Appends one JSON record as a single line. Callers must serialize their own calls per file
// (Node's fs.appendFile does not guarantee ordering across concurrent callers) so that a
// crash mid-run still leaves only complete, newline-terminated JSON records behind.
export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, filePath);
}

export async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, value, 'utf8');
  await rename(temp, filePath);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stablePageBasename(index: number, url: string): string {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
  const hash = sha256(url).slice(0, 10);
  return `${String(index).padStart(4, '0')}-${slug}-${hash}`;
}

export function makeRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

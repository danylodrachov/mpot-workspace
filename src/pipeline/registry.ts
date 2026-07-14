/**
 * Registry (issue #01) — one flat JSON file, `data/registry.json`, outside the day folders.
 * Key = always a message, only a message. Cross-day memory of "already handled" and the
 * sole home of the message → ClickUp card linkage (sessions/2026-07-03-registry-design-facts.md).
 * Sole writer: the Orchestrator.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Source = 'gmail' | 'replyio';

export interface RegistryEntry {
  thread_id: string;
  task_id: string | null;
  clickup_status: string | null;
  file: string | null;
  verdict: string | null;
  redo_draft: true | null | false;
}

export type Registry = Record<string, RegistryEntry>;

interface GmailMessageLike {
  id: string;
}

interface ReplyioRecordLike {
  id: string;
  lastActivityDate?: string;
  raw?: { lastActivityDate?: string };
}

function registryPath(root: string): string {
  return join(root, 'data', 'registry.json');
}

export function loadRegistry(root: string): Registry {
  const path = registryPath(root);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

export function saveRegistry(root: string, reg: Registry): void {
  const path = registryPath(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(reg, null, 2));
  renameSync(tmpPath, path);
}

export function messageKey(source: 'gmail', raw: GmailMessageLike): string;
export function messageKey(source: 'replyio', raw: ReplyioRecordLike): string;
export function messageKey(source: Source, raw: GmailMessageLike | ReplyioRecordLike): string {
  if (source === 'gmail') {
    return `gmail:${raw.id}`;
  }
  const replyio = raw as ReplyioRecordLike;
  const lastActivityDate = replyio.lastActivityDate ?? replyio.raw?.lastActivityDate;
  return `replyio:${replyio.id}:${lastActivityDate}`;
}

export function has(reg: Registry, key: string): boolean {
  return key in reg;
}

export function record(reg: Registry, key: string, entry: RegistryEntry): void {
  reg[key] = entry;
}

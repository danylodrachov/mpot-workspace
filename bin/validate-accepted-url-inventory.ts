#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function intArg(name: string, fallback: number): number {
  const value = arg(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

interface AcceptedEntry {
  canonicalUrl: string;
  navigationUrl: string;
  ruleId: string;
}

interface ValidationRecord {
  index: number;
  requestedUrl: string;
  canonicalUrl: string;
  ruleId: string;
  startedAt: string;
  finishedAt: string;
  status: 'visited' | 'failed' | 'blocked';
  httpStatus: number | null;
  finalUrl: string | null;
  failureReason: string | null;
}


function knownErrorRoute(url: string): boolean {
  try {
    return /\/(?:404|not-found|notfound|error)(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function looksLikeAccessBlock(title: string, html: string): boolean {
  const sample = `${title}\n${html.slice(0, 200_000)}`.toLowerCase();
  return (
    sample.includes('just a moment...') ||
    sample.includes('attention required! | cloudflare') ||
    sample.includes('cloudflare ray id') ||
    sample.includes('cf-error-details') ||
    sample.includes('challenge-platform') ||
    sample.includes('cf-chl-')
  );
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const runDirArg = arg('--run-dir');
  const inventoryArg = arg('--inventory');
  if (!runDirArg && !inventoryArg) {
    throw new Error('Usage: validate-accepted-url-inventory.ts --run-dir <discovery-run-dir> [--headed] [--cdp URL]');
  }

  const runDir = path.resolve(runDirArg ?? path.dirname(path.resolve(inventoryArg!)));
  const inventoryPath = path.resolve(inventoryArg ?? path.join(runDir, 'accepted-url-inventory.json'));
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as AcceptedEntry[];
  if (!Array.isArray(inventory)) throw new Error('accepted-url-inventory.json must contain an array');

  const frozen = inventory.map(item => ({ ...item }));
  const canonical = new Set<string>();
  for (const item of frozen) {
    if (!item.canonicalUrl || !item.navigationUrl || !item.ruleId) throw new Error('Invalid accepted inventory entry');
    if (canonical.has(item.canonicalUrl)) throw new Error(`Duplicate canonical accepted URL: ${item.canonicalUrl}`);
    canonical.add(item.canonicalUrl);
  }

  // @ts-ignore runtime dependency is supplied by the host repository.
  const { chromium } = await import('playwright');
  const cdp = arg('--cdp');
  let browser: any;
  let context: any;
  let ownsBrowser = false;
  let ownsPage = false;

  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0] ?? await browser.newContext();
  } else {
    browser = await chromium.launch({ headless: !has('--headed') });
    context = await browser.newContext();
    ownsBrowser = true;
  }
  const existingPage = context.pages()[0];
  const page = existingPage ?? await context.newPage();
  ownsPage = !existingPage;

  const timeout = intArg('--navigation-timeout-ms', 20_000);
  const settleMs = intArg('--settle-ms', 500);
  const records: ValidationRecord[] = [];

  try {
    for (let index = 0; index < frozen.length; index += 1) {
      const item = frozen[index];
      const startedAt = new Date().toISOString();
      process.stderr.write(`[VALIDATE ${index + 1}/${frozen.length}] START ${item.navigationUrl}\n`);
      let record: ValidationRecord;
      try {
        const response = await page.goto(item.navigationUrl, { waitUntil: 'domcontentloaded', timeout });
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        const httpStatus = response?.status() ?? null;
        const finalUrl = page.url() || null;
        const title = await page.title().catch(() => '');
        const html = await page.content().catch(() => '');
        const blockedByStatus = httpStatus !== null && [401, 403, 429].includes(httpStatus);
        const blockedByPage = looksLikeAccessBlock(title, html);
        const softError = finalUrl ? knownErrorRoute(finalUrl) : false;
        const failed = (httpStatus !== null && httpStatus >= 400) || softError;
        const blocked = blockedByStatus || blockedByPage;
        record = {
          index: index + 1,
          requestedUrl: item.navigationUrl,
          canonicalUrl: item.canonicalUrl,
          ruleId: item.ruleId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: blocked ? 'blocked' : (failed ? 'failed' : 'visited'),
          httpStatus,
          finalUrl,
          failureReason: blocked
            ? (blockedByStatus ? `HTTP ${httpStatus} access response` : 'Known access/challenge page detected')
            : (softError ? `Soft error route: ${finalUrl}` : (failed ? `HTTP ${httpStatus}` : null)),
        };
      } catch (error) {
        record = {
          index: index + 1,
          requestedUrl: item.navigationUrl,
          canonicalUrl: item.canonicalUrl,
          ruleId: item.ruleId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: 'failed',
          httpStatus: null,
          finalUrl: page.url() || null,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
      records.push(record);
      process.stderr.write(`[VALIDATE ${index + 1}/${frozen.length}] END ${record.status} http=${record.httpStatus ?? '-'} remaining=${frozen.length - records.length}\n`);
    }
  } finally {
    if (ownsPage) await page.close().catch(() => undefined);
    if (ownsBrowser) await browser.close();
  }

  const suffix = stamp();
  const jsonlPath = path.join(runDir, `accepted-url-validation-${suffix}.jsonl`);
  const summaryPath = path.join(runDir, `accepted-url-validation-${suffix}.summary.json`);
  await writeFile(jsonlPath, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { encoding: 'utf8', flag: 'wx' });
  const summary = {
    inventory: inventoryPath,
    inventory_count: frozen.length,
    attempted: records.length,
    visited: records.filter(item => item.status === 'visited').length,
    failed: records.filter(item => item.status === 'failed').length,
    blocked: records.filter(item => item.status === 'blocked').length,
    jsonl: jsonlPath,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ...summary, summary: summaryPath }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ status: 'error', reason: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});

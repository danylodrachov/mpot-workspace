import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

import type { RecursiveMode } from './discovery-policy.ts';
import { discoverSiteUrlMap } from './url-map-discovery.ts';

interface CliArgs {
  url: string;
  out?: string;
  headed: boolean;
  manualLogin: boolean;
  maxPages: number;
  recursiveMode: RecursiveMode;
  allowHosts: string[];
  settleMs: number;
  navigationTimeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let url = '';
  let out: string | undefined;
  let headed = false;
  let manualLogin = false;
  let maxPages = 0;
  let recursiveMode: RecursiveMode = 'fallback';
  const allowHosts: string[] = [];
  let settleMs = 1_000;
  let navigationTimeoutMs = 35_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--url') url = argv[++i] ?? '';
    else if (arg === '--out') out = argv[++i];
    else if (arg === '--headed') headed = true;
    else if (arg === '--manual-login') { manualLogin = true; headed = true; }
    else if (arg === '--allow-host') allowHosts.push(argv[++i] ?? '');
    else if (arg === '--max-pages') maxPages = Number(argv[++i] ?? '0');
    else if (arg === '--recursive-mode') {
      const value = argv[++i];
      if (value !== 'fallback' && value !== 'never' && value !== 'always') {
        throw new Error('--recursive-mode must be fallback, never, or always');
      }
      recursiveMode = value;
    }
    else if (arg === '--settle-ms') settleMs = Number(argv[++i] ?? '1000');
    else if (arg === '--navigation-timeout-ms') navigationTimeoutMs = Number(argv[++i] ?? '35000');
    else if (!arg.startsWith('-') && !url) url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!url) {
    throw new Error('Usage: cli.ts --url https://example.com [--headed] [--manual-login] [--recursive-mode fallback|never|always] [--max-pages 0] [--allow-host host] [--out path]');
  }
  if (!Number.isFinite(maxPages) || maxPages < 0) throw new Error('--max-pages must be >= 0');
  return { url, out, headed, manualLogin, maxPages, recursiveMode, allowHosts: allowHosts.filter(Boolean), settleMs, navigationTimeoutMs };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const args = parseArgs(process.argv.slice(2));
const host = new URL(args.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
const outDir = resolve(args.out ?? `artifacts/url-map/${host}/${stamp()}`);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: !args.headed });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();

try {
  const summary = await discoverSiteUrlMap(context, page, {
    entryUrl: args.url,
    outDir,
    maxPages: args.maxPages,
    recursiveMode: args.recursiveMode,
    manualLogin: args.manualLogin,
    additionalAllowedHosts: args.allowHosts,
    settleMs: args.settleMs,
    navigationTimeoutMs: args.navigationTimeoutMs,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\nRUN_DIR=${outDir}\n`);
} finally {
  await context.close();
  await browser.close();
}

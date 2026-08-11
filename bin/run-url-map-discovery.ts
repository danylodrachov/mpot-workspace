#!/usr/bin/env node
import path from 'node:path';
import { discoverUrlMap } from '../src/research/url-map-discovery/discovery.ts';
import { writeUrlMapArtifacts } from '../src/research/url-map-discovery/io.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) if (process.argv[i] === name) values.push(process.argv[i + 1]);
  return values;
}

async function main(): Promise<void> {
  const entryUrl = arg('--url');
  if (!entryUrl) throw new Error('Usage: run-url-map-discovery.ts --url https://casino.example/ [--out ./artifacts/url-map] [--cdp http://127.0.0.1:9222]');
  const outputDir = path.resolve(arg('--out') ?? './artifacts/url-map');
  const cdp = arg('--cdp');
  const allowedHosts = args('--allow-host');

  // Keep Playwright as a runtime dependency of the host repository; the patch does not pin/change its version.
  // @ts-ignore host repo supplies playwright
  const { chromium } = await import('playwright');
  let browser: any;
  let context: any;
  let ownsBrowser = false;
  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0] ?? await browser.newContext();
  } else {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    ownsBrowser = true;
  }
  const page = context.pages()[0] ?? await context.newPage();
  try {
    const result = await discoverUrlMap(page, entryUrl, { allowedHosts });
    await writeUrlMapArtifacts(outputDir, result);
    process.stdout.write(JSON.stringify({
      outputDir,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      tbd: result.tbd.length,
      raw: result.rawCandidates.length,
      recursiveFallback: false,
    }, null, 2) + '\n');
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

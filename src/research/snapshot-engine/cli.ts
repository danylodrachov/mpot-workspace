#!/usr/bin/env node
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import { attachToLoggedInChrome } from './session.ts';

interface Args {
  url: string;
  geo?: string;
  output: string;
  templates?: string;
  cdp: string;
  settleMs: number;
  navigationTimeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values.set(token.slice(2), next);
    i += 1;
  }
  const url = values.get('url');
  if (!url) throw new Error('Required: --url <casino_url>');
  return {
    url,
    geo: values.get('geo'),
    output: values.get('output') ?? path.resolve('casino-evidence'),
    templates: values.get('templates'),
    cdp: values.get('cdp') ?? process.env.CASINO_DISCOVERY_CDP_URL ?? 'http://127.0.0.1:9222',
    settleMs: Number(values.get('settle-ms') ?? 1500),
    navigationTimeoutMs: Number(values.get('navigation-timeout-ms') ?? 30000),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.url).origin;
  const session = await attachToLoggedInChrome(args.cdp, origin);
  try {
    const manifest = await crawlSite({
      context: session.context,
      page: session.page,
      entryUrl: args.url,
      outputDir: args.output,
      geo: args.geo,
      templateDir: args.templates,
      settleMs: args.settleMs,
      navigationTimeoutMs: args.navigationTimeoutMs,
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await session.close();
  }
}

// Guarded so importing this module (tests, tooling) never starts a crawl.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

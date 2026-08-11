#!/usr/bin/env node
import path from 'node:path';
import { crawlSite } from './crawler.ts';
import { attachToLoggedInChrome } from './session.ts';
import { parseRuntimeBudgetOverridesFromArgs, type RuntimeBudgetOverrides } from './runtime-config.ts';

export interface Args {
  url: string;
  casinoName: string;
  geo?: string;
  output: string;
  templates?: string;
  cdp: string;
  settleMs: number;
  navigationTimeoutMs: number;
  debugArtifacts: boolean;
  // CD-N07: every other bounded operation budget (response-body scan, network-observer flush,
  // source-family discovery, one interaction action, a controlled-scroll round, the whole
  // interaction-expansion pass, the whole page-processing step, the LLM JSON build, and the
  // no-progress watchdog), overridable individually via CLI flags — see
  // runtime-config.ts's RUNTIME_BUDGET_CLI_FLAGS for the exact flag names.
  runtimeBudgetOverrides: RuntimeBudgetOverrides;
}

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    // --debug-artifacts is a boolean flag: no value follows it (or the next token is itself
    // another flag), same as any other boolean CLI switch.
    if (token.slice(2) === 'debug-artifacts' && (!next || next.startsWith('--'))) {
      flags.add('debug-artifacts');
      continue;
    }
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values.set(token.slice(2), next);
    i += 1;
  }
  const url = values.get('url');
  if (!url) throw new Error('Required: --url <casino_url>');
  const casinoName = values.get('casino-name');
  if (!casinoName) throw new Error('Required: --casino-name <casino_display_name>');
  return {
    url,
    casinoName,
    geo: values.get('geo'),
    output: values.get('output') ?? path.resolve('casino-evidence'),
    templates: values.get('templates'),
    cdp: values.get('cdp') ?? process.env.CASINO_DISCOVERY_CDP_URL ?? 'http://127.0.0.1:9222',
    settleMs: Number(values.get('settle-ms') ?? 1500),
    navigationTimeoutMs: Number(values.get('navigation-timeout-ms') ?? 30000),
    debugArtifacts: flags.has('debug-artifacts'),
    // CD-N07: settle-ms/navigation-timeout-ms above are parsed separately (with this CLI's own
    // defaults, preserved for backward compatibility) and are NOT re-parsed here — every other
    // budget flag is resolved through the single centralized table instead of a bespoke
    // values.get()/Number() pair per flag.
    runtimeBudgetOverrides: parseRuntimeBudgetOverridesFromArgs(values),
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
      casinoName: args.casinoName,
      geo: args.geo,
      templateDir: args.templates,
      settleMs: args.settleMs,
      navigationTimeoutMs: args.navigationTimeoutMs,
      debugArtifacts: args.debugArtifacts,
      runtimeBudgetOverrides: args.runtimeBudgetOverrides,
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

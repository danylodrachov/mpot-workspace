#!/usr/bin/env node

import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';

import { resolveBrowserLaunchHeadless } from '../src/research/url-map/browser-launch-policy.ts';
import { discoverFullUrlMap } from '../src/research/url-map/full-discovery.ts';
import { writeFullUrlMapDiscoveryArtifacts } from '../src/research/url-map/full-io.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function args(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  }
  return values;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function intArg(name: string): number | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function manualBootstrap(page: any, context: any, entryUrl: string): Promise<string[]> {
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  output.write(
    '\nManual bootstrap enabled. Complete login / anti-bot challenge in the opened browser.\n' +
    'Open any additional authenticated application page that must be used as a finite seed.\n' +
    'When the browser state is ready, return here and press Enter.\n\n',
  );

  const rl = createInterface({ input, output });
  try {
    await rl.question('Press Enter to freeze browser-page seeds and start discovery... ');
  } finally {
    rl.close();
  }

  return context.pages()
    .map((candidate: any) => candidate.url())
    .filter((url: string) => isHttpUrl(url));
}

async function main(): Promise<void> {
  const entryUrl = arg('--url');
  if (!entryUrl) {
    throw new Error(
      'Usage: run-url-map-discovery.ts --url https://casino.example/ [--casino "Casino Name"] [--out path] [--allow-host host] [--seed-url url] [--seed-allow-host-roots] [--manual-bootstrap] [--headless] [--headed] [--cdp http://127.0.0.1:9222]',
    );
  }

  const outputRoot = path.resolve(arg('--out') ?? arg('--out-root') ?? 'data/temp');
  const casinoName = arg('--casino');
  const allowedHosts = args('--allow-host');
  const explicitSeedUrls = args('--seed-url');
  const cdp = arg('--cdp');
  const wantsManualBootstrap = has('--manual-bootstrap');
  const headless = resolveBrowserLaunchHeadless({
    headlessRequested: has('--headless'),
    headedRequested: has('--headed'),
    manualBootstrap: wantsManualBootstrap,
  });

  // Host repository supplies Playwright; this patch intentionally does not pin/change its version.
  // @ts-ignore runtime dependency is supplied by the host repository.
  const { chromium } = await import('playwright');

  let browser: any;
  let context: any;
  let ownsBrowser = false;
  let ownsPage = false;

  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0] ?? await browser.newContext();
  } else {
    // Discovery is headed by default. Headless Chromium is an explicit opt-in via --headless.
    browser = await chromium.launch({ headless });
    context = await browser.newContext();
    ownsBrowser = true;
  }

  const existingPage = context.pages()[0];
  const page = existingPage ?? await context.newPage();
  ownsPage = !existingPage;

  try {
    const browserPageSeeds = wantsManualBootstrap
      ? await manualBootstrap(page, context, entryUrl)
      : [];

    // Freeze all seeds before discoverFullUrlMap starts. No scanner result is fed back here.
    const seedUrls = [...new Set([...explicitSeedUrls, ...browserPageSeeds])];

    const result = await discoverFullUrlMap(page, entryUrl, {
      allowedHosts,
      seedUrls,
      seedAllowedHostRoots: has('--seed-allow-host-roots'),
      navigationTimeoutMs: intArg('--navigation-timeout-ms'),
      settleMs: intArg('--settle-ms'),
      technicalSourceTimeoutMs: intArg('--technical-source-timeout-ms'),
      maxTechnicalSources: intArg('--max-technical-sources'),
      maxTechnicalSourceBodyBytes: intArg('--max-technical-source-body-bytes'),
      sitemapRequestTimeoutMs: intArg('--sitemap-timeout-ms'),
      sitemapMaxRedirects: intArg('--sitemap-max-redirects'),
      sitemapMaxFiles: intArg('--sitemap-max-files'),
      sitemapMaxPageUrls: intArg('--sitemap-max-page-urls'),
    });

    const written = await writeFullUrlMapDiscoveryArtifacts(result, {
      outputRoot,
      casinoName,
    });

    process.stdout.write(`${JSON.stringify({
      status: result.summary.discoveryStatus,
      run_id: result.runId,
      casino: written.casinoSlug,
      run_date: written.runDate,
      run_dir: written.runDir,
      frozen_seeds: result.summary.counts.frozenSeeds,
      completed_seeds: result.summary.counts.completedSeeds,
      blocked_seeds: result.summary.counts.blockedSeeds,
      errored_seeds: result.summary.counts.erroredSeeds,
      seed_attempts: result.seedAttempts,
      raw_candidates: result.summary.counts.rawCandidates,
      resolved_urls: result.summary.counts.resolvedUrls,
      unresolved_candidates: result.summary.counts.unresolvedCandidates,
      sitemap_page_urls: result.summary.counts.sitemapPageUrls,
      observed_technical_sources: result.summary.counts.observedTechnicalSources,
      technical_source_errors: result.summary.counts.technicalSourceErrors,
      source_errors: result.sourceCoverage
        .filter(item => item.status === 'error' || item.status === 'blocked')
        .map(item => ({
          source_family: item.sourceFamily,
          status: item.status,
          errors: item.errorCount,
          error_codes: item.errorCodes,
        })),
      artifacts: {
        raw_candidates: written.rawCandidatesPath,
        source_coverage: written.sourceCoveragePath,
        url_map: written.urlMapPath,
        sitemap: written.sitemapPath,
        summary: written.summaryPath,
      },
    }, null, 2)}\n`);
  } finally {
    if (ownsPage) await page.close().catch(() => undefined);
    if (ownsBrowser) await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    status: 'error',
    reason: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});

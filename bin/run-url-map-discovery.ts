#!/usr/bin/env node

import path from 'node:path';

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

async function main(): Promise<void> {
  const entryUrl = arg('--url');
  if (!entryUrl) {
    throw new Error(
      'Usage: run-url-map-discovery.ts --url https://casino.example/ [--casino "Casino Name"] [--out path] [--allow-host host] [--headed] [--cdp http://127.0.0.1:9222]',
    );
  }

  const outputRoot = path.resolve(arg('--out') ?? arg('--out-root') ?? 'data/casino-partner-researches');
  const casinoName = arg('--casino');
  const allowedHosts = args('--allow-host');
  const cdp = arg('--cdp');

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
    browser = await chromium.launch({ headless: !has('--headed') });
    context = await browser.newContext();
    ownsBrowser = true;
  }

  const existingPage = context.pages()[0];
  const page = existingPage ?? await context.newPage();
  ownsPage = !existingPage;

  try {
    const result = await discoverFullUrlMap(page, entryUrl, {
      allowedHosts,
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
      status: 'ok',
      run_id: result.runId,
      casino: written.casinoSlug,
      run_date: written.runDate,
      run_dir: written.runDir,
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

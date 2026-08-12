#!/usr/bin/env node

import path from 'node:path';
import {
  discoverSitemaps,
  extractSitemapReferencesFromText,
  looksLikeSitemapReference,
  normalizeEntryUrl,
  parseLinkHeaderSitemaps,
  writeSitemapDiscoveryJson,
  type SeedObservation,
} from '../src/research/sitemap-discovery.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

async function collectSeedObservation(page: any, inputUrl: string, timeoutMs: number): Promise<SeedObservation> {
  const requestedUrl = normalizeEntryUrl(inputUrl).toString();
  const networkCandidates = new Set<string>();
  const linkHeaderCandidates = new Set<string>();
  const pendingHeaders: Promise<void>[] = [];

  page.on('response', (response: any) => {
    const task = (async () => {
      const responseUrl = response.url();
      const contentType = await response.headerValue('content-type');
      const link = await response.headerValue('link');
      if (looksLikeSitemapReference(responseUrl) || /(?:xml|rss|atom)/i.test(contentType ?? '')) {
        networkCandidates.add(responseUrl);
      }
      for (const candidate of parseLinkHeaderSitemaps(link, responseUrl)) {
        linkHeaderCandidates.add(candidate);
      }
    })().catch(() => undefined);
    pendingHeaders.push(task);
  });

  let mainResponse: any = null;
  let navigationStatus: SeedObservation['navigation_status'] = 'navigation_error';
  let httpStatus: number | null = null;
  let contentType: string | null = null;
  let mainResponseBody: Buffer | null = null;
  let errorReason: string | null = null;

  try {
    mainResponse = await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (mainResponse) {
      httpStatus = mainResponse.status();
      contentType = await mainResponse.headerValue('content-type');
      try {
        mainResponseBody = await mainResponse.body();
      } catch {
        mainResponseBody = null;
      }
      navigationStatus = httpStatus >= 200 && httpStatus < 400 ? 'ok' : 'http_error';
    } else {
      navigationStatus = 'ok';
    }
  } catch (error) {
    errorReason = error instanceof Error ? error.message : String(error);
  }

  await Promise.allSettled(pendingHeaders);

  const finalUrl = page.url() && page.url() !== 'about:blank' ? page.url() : null;
  const baseUrl = finalUrl ?? requestedUrl;
  const renderedDomCandidates = new Set<string>();
  const documentTextCandidates = new Set<string>();

  if (finalUrl) {
    try {
      const domCandidates = await page.evaluate(() => {
        const out: Array<{ value: string; explicitSitemap: boolean }> = [];
        for (const element of document.querySelectorAll('[href], [src], [action]')) {
          const tag = element.tagName.toLowerCase();
          const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
          const explicitSitemap = tag === 'link' && rel.includes('sitemap');
          for (const name of ['href', 'src', 'action']) {
            const raw = element.getAttribute(name);
            if (!raw) continue;
            try {
              out.push({ value: new URL(raw, document.baseURI).href, explicitSitemap });
            } catch {
              // Ignore invalid URL-bearing attributes.
            }
          }
        }
        return out;
      });
      for (const item of domCandidates) {
        if (item.explicitSitemap || looksLikeSitemapReference(item.value)) {
          renderedDomCandidates.add(item.value);
        }
      }
    } catch {
      // A blocked/non-HTML seed can still succeed through robots or network observations.
    }

    try {
      const html = await page.content();
      for (const candidate of extractSitemapReferencesFromText(html, baseUrl)) {
        documentTextCandidates.add(candidate);
      }
    } catch {
      // Same as above: absence of a DOM snapshot is not fatal to sitemap discovery.
    }
  }

  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    navigation_status: navigationStatus,
    http_status: httpStatus,
    content_type: contentType,
    main_response_body: mainResponseBody,
    link_header_candidates: [...linkHeaderCandidates],
    rendered_dom_candidates: [...renderedDomCandidates],
    document_text_candidates: [...documentTextCandidates],
    network_candidates: [...networkCandidates],
    error_reason: errorReason,
  };
}

async function main(): Promise<void> {
  const inputUrl = arg('--url');
  if (!inputUrl) {
    throw new Error(
      'Usage: run-sitemap-discovery.ts --url https://example.com [--out ./artifacts/sitemap-discovery] [--headed] [--cdp http://127.0.0.1:9222]',
    );
  }

  const outputRoot = path.resolve(arg('--out') ?? './artifacts/sitemap-discovery');
  const cdp = arg('--cdp');
  const timeoutMs = intArg('--timeout-ms') ?? 10_000;

  // Host repository supplies Playwright; module intentionally does not pin a version.
  // @ts-ignore runtime dependency is supplied by the host repository.
  const { chromium } = await import('playwright');

  let browser: any;
  let context: any;
  let ownsBrowser = false;

  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0] ?? await browser.newContext();
  } else {
    browser = await chromium.launch({ headless: !has('--headed') });
    context = await browser.newContext();
    ownsBrowser = true;
  }

  const page = await context.newPage();

  try {
    // Exactly one browser seed navigation: the URL supplied by the operator.
    // No discovered page URL is opened. Sitemap files are fetched through context.request only.
    const seed = await collectSeedObservation(page, inputUrl, timeoutMs);
    const result = await discoverSitemaps(context.request, inputUrl, seed, {
      requestTimeoutMs: timeoutMs,
      maxSitemapFiles: intArg('--max-sitemap-files'),
      maxPageUrls: intArg('--max-page-urls'),
    });

    if (result.status === 'not_discovered') {
      process.stderr.write(`${JSON.stringify({
        status: result.status,
        code: result.reason.code,
        reason: result.reason.message,
        checked_signals: result.reason.checked_signals,
        limitations: result.reason.limitations,
        seed: result.seed,
        robots: result.robots,
        attempts: result.attempts,
      }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    const written = await writeSitemapDiscoveryJson(outputRoot, result);
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      run_dir: written.runDir,
      json: written.jsonPath,
      root_sitemaps: result.counts.root_sitemaps,
      sitemap_files: result.counts.sitemap_files,
      category_sitemaps: result.counts.category_sitemaps,
      page_urls: result.counts.page_urls,
    }, null, 2)}\n`);
  } finally {
    await page.close().catch(() => undefined);
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

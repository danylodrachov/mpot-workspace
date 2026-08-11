import { gunzipSync } from 'node:zlib';
import type { APIRequestContext } from 'playwright';

import type { CandidateProvenance } from './types.ts';

export interface SitemapSink {
  add(rawUrl: string, baseUrl: string, provenance: CandidateProvenance): void;
  error(sourceFamily: 'robots_sitemap' | 'sitemap_url', message: string): void;
}

const DEFAULT_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap/sitemap.xml',
];

function bodyToText(body: Buffer): string {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body).toString('utf8');
    } catch {
      return body.toString('utf8');
    }
  }
  return body.toString('utf8');
}

async function fetchBounded(request: APIRequestContext, url: string, maxBytes: number): Promise<{ status: number; text?: string; contentType: string }> {
  const response = await request.get(url, { timeout: 20_000, failOnStatusCode: false });
  const status = response.status();
  const headers = response.headers();
  const contentType = headers['content-type'] ?? '';
  const declared = Number(headers['content-length'] ?? '0');
  if (declared > maxBytes) return { status, contentType };
  const body = await response.body();
  if (body.byteLength > maxBytes) return { status, contentType };
  return { status, contentType, text: bodyToText(body) };
}

function parseSitemapPayload(text: string, contentType: string): { urls: string[]; childSitemaps: string[] } {
  const urls = new Set<string>();
  const childSitemaps = new Set<string>();

  const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => (match[1] ?? '').trim().replace(/&amp;/gi, '&'));
  const looksLikeIndex = /<sitemapindex\b/i.test(text);
  for (const loc of locs) {
    if (!loc) continue;
    if (looksLikeIndex) childSitemaps.add(loc);
    else urls.add(loc);
  }

  if (/rss|atom|xml/i.test(contentType) || /<(?:rss|feed)\b/i.test(text)) {
    for (const match of text.matchAll(/<link(?:\s+[^>]*)?>([^<]+)<\/link>/gi)) {
      const value = (match[1] ?? '').trim();
      if (/^https?:\/\//i.test(value)) urls.add(value);
    }
    for (const match of text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      const value = (match[1] ?? '').trim();
      if (/^https?:\/\//i.test(value)) urls.add(value);
    }
  }

  if (locs.length === 0 && !/<[A-Za-z]/.test(text.slice(0, 2000))) {
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (/^https?:\/\//i.test(value)) urls.add(value);
    }
  }

  return { urls: [...urls], childSitemaps: [...childSitemaps] };
}

export async function discoverRobotsAndSitemaps(
  request: APIRequestContext,
  siteOrigin: string,
  sink: SitemapSink,
  options: { maxBytes?: number; maxSitemaps?: number; sitemapPaths?: string[] } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const maxSitemaps = options.maxSitemaps ?? 5_000;
  const queue: string[] = [];
  const seen = new Set<string>();

  const robotsUrl = new URL('/robots.txt', siteOrigin).href;
  try {
    const robots = await fetchBounded(request, robotsUrl, maxBytes);
    if (robots.text && robots.status < 400) {
      for (const line of robots.text.split(/\r?\n/)) {
        const match = /^\s*Sitemap:\s*(\S+)/i.exec(line);
        if (!match?.[1]) continue;
        const sitemap = new URL(match[1], robotsUrl).href;
        queue.push(sitemap);
        sink.add(sitemap, robotsUrl, {
          sourceFamily: 'robots_sitemap',
          discoveredOn: robotsUrl,
          sourceUrl: robotsUrl,
        });
      }
    }
  } catch (error) {
    sink.error('robots_sitemap', `robots.txt fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const path of options.sitemapPaths ?? DEFAULT_SITEMAP_PATHS) queue.push(new URL(path, siteOrigin).href);

  while (queue.length > 0 && seen.size < maxSitemaps) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);

    try {
      const response = await fetchBounded(request, sitemapUrl, maxBytes);
      if (!response.text || response.status >= 400) continue;
      const parsed = parseSitemapPayload(response.text, response.contentType);

      for (const rawUrl of parsed.urls) {
        sink.add(rawUrl, sitemapUrl, {
          sourceFamily: 'sitemap_url',
          discoveredOn: sitemapUrl,
          sourceUrl: sitemapUrl,
        });
      }
      for (const child of parsed.childSitemaps) {
        const childUrl = new URL(child, sitemapUrl).href;
        queue.push(childUrl);
        sink.add(childUrl, sitemapUrl, {
          sourceFamily: 'robots_sitemap',
          discoveredOn: sitemapUrl,
          sourceUrl: sitemapUrl,
          label: 'child-sitemap',
        });
      }
    } catch (error) {
      sink.error('sitemap_url', `Sitemap fetch failed for ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (queue.length > 0) {
    sink.error('sitemap_url', `Sitemap traversal stopped at maxSitemaps=${maxSitemaps}; ${queue.length} sitemap URLs remain queued.`);
  }
}

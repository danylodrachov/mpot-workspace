import { gunzipSync } from 'node:zlib';
import type { APIRequestContextLike, RawUrlCandidate, SourceCoverageRecord } from './types.ts';

const DEFAULT_PROBES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractSitemapLocations(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const value = decodeXml(match[1].trim());
    if (value) out.add(value);
  }
  // RSS/Atom/plain-text fallback. Keep only absolute HTTP(S) URL lines/tokens.
  for (const match of text.matchAll(/https?:\/\/[^\s<>'"]+/g)) out.add(decodeXml(match[0].replace(/[),.;]+$/g, '')));
  return [...out];
}

async function getText(request: APIRequestContextLike, url: string, timeoutMs: number): Promise<{ status: number; text: string; headers: Record<string,string> }> {
  const response = await request.get(url, { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 10 });
  try {
    const headers = response.headers();
    let body = await response.body();
    if (/gzip/i.test(headers['content-encoding'] ?? '') || /\.gz(?:$|[?#])/i.test(url)) {
      try { body = gunzipSync(body); } catch { /* some clients transparently decompress */ }
    }
    return { status: response.status(), text: body.toString('utf8'), headers };
  } finally { await response.dispose?.(); }
}

export async function discoverSitemaps(request: APIRequestContextLike, entryUrl: string, allowedHosts: ReadonlySet<string>, timeoutMs = 6000, maxFiles = 30): Promise<{ candidates: RawUrlCandidate[]; coverage: SourceCoverageRecord[] }> {
  const started = Date.now();
  const entry = new URL(entryUrl);
  const observedAt = new Date().toISOString();
  const candidates: RawUrlCandidate[] = [];
  const sitemapUrls = new Set<string>();
  let robotsStatus: SourceCoverageRecord['status'] = 'absent';
  let robotsError: string | undefined;
  let robotsDirectiveCount = 0;

  try {
    const robotsUrl = new URL('/robots.txt', entry.origin).toString();
    const robots = await getText(request, robotsUrl, timeoutMs);
    if (robots.status >= 200 && robots.status < 400) {
      const matches = [...robots.text.matchAll(/^\s*Sitemap\s*:\s*(\S+)\s*$/gim)].map(m => m[1]);
      robotsDirectiveCount = matches.length;
      for (const value of matches) {
        try {
          const u = new URL(value, robotsUrl);
          if (['http:', 'https:'].includes(u.protocol)) sitemapUrls.add(u.toString());
        } catch {}
      }
      robotsStatus = matches.length ? 'complete' : 'absent';
    } else if (robots.status === 401 || robots.status === 403) robotsStatus = 'blocked';
  } catch (error) {
    robotsStatus = 'error';
    robotsError = error instanceof Error ? error.message : String(error);
  }

  if (!sitemapUrls.size) {
    for (const path of DEFAULT_PROBES) sitemapUrls.add(new URL(path, entry.origin).toString());
  }

  const queue = [...sitemapUrls];
  const seen = new Set<string>();
  let sitemapSuccess = 0;
  let sitemapBlocked = 0;
  let sitemapErrors = 0;
  while (queue.length && seen.size < maxFiles) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    try {
      const result = await getText(request, sitemapUrl, timeoutMs);
      if (result.status === 401 || result.status === 403) { sitemapBlocked += 1; continue; }
      if (result.status < 200 || result.status >= 400) continue;
      sitemapSuccess += 1;
      for (const value of extractSitemapLocations(result.text)) {
        let url: URL;
        try { url = new URL(value, sitemapUrl); } catch { continue; }
        // Cross-host sitemap files are permitted by the protocol, but navigation remains in configured scope.
        const looksLikeSitemap = /(?:sitemap|\.xml(?:\.gz)?)(?:$|[?#])/i.test(url.pathname);
        if (looksLikeSitemap) {
          if (!seen.has(url.toString()) && queue.length + seen.size < maxFiles) queue.push(url.toString());
          continue;
        }
        if (allowedHosts.has(url.hostname.toLowerCase())) {
          candidates.push({
            rawUrl: url.toString(),
            baseUrl: sitemapUrl,
            provenance: { sourceFamily: 'sitemap_url', discoveredOn: entryUrl, sourceUrl: sitemapUrl },
            observedAt,
          });
        }
      }
    } catch { sitemapErrors += 1; }
  }

  const sitemapStatus: SourceCoverageRecord['status'] = sitemapSuccess > 0 ? (sitemapErrors ? 'error' : 'complete') : sitemapBlocked ? 'blocked' : sitemapErrors ? 'error' : 'absent';
  return {
    candidates,
    coverage: [
      { sourceFamily: 'robots_sitemap', status: robotsStatus, candidateCount: robotsDirectiveCount, durationMs: Date.now() - started, ...(robotsError ? { errorCode: 'ROBOTS_FETCH_ERROR', errorMessage: robotsError } : {}) },
      { sourceFamily: 'sitemap_url', status: sitemapStatus, candidateCount: candidates.length, durationMs: Date.now() - started, ...(sitemapErrors ? { errorCode: 'SITEMAP_FETCH_ERROR', errorMessage: `${sitemapErrors} sitemap fetch/parse operation(s) failed.` } : {}) },
    ],
  };
}

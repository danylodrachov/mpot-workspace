import type { APIRequestContextLike, RawUrlCandidate, SourceFamily } from './types.ts';
import { extractUrlTokens } from './token-extractor.ts';

const TEXT_CONTENT_TYPE = /(?:javascript|ecmascript|json|xml|html|text\/plain|text\/css)/i;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isFetchableTextSource(url: URL): boolean {
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|css|map)(?:$|[?#])/i.test(url.pathname)) return false;
  return /\.(?:m?js|cjs|json|xml|txt)(?:$|[?#])/i.test(url.pathname) || /(?:^|\/)(?:api|graphql)(?:\/|$)/i.test(url.pathname);
}

export interface TechnicalScanResult {
  candidates: RawUrlCandidate[];
  errors: Array<{ sourceUrl: string; message: string }>;
}

export async function scanTechnicalSources(request: APIRequestContextLike, sourceUrls: readonly string[], entryUrl: string, allowedHosts: ReadonlySet<string>, timeoutMs = 6000, maxSources = 120): Promise<TechnicalScanResult> {
  const candidates: RawUrlCandidate[] = [];
  const errors: Array<{ sourceUrl: string; message: string }> = [];
  const unique = [...new Set(sourceUrls)].slice(0, maxSources);

  for (const sourceUrl of unique) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl, entryUrl); } catch { continue; }
    if (!allowedHosts.has(parsed.hostname.toLowerCase()) || !isFetchableTextSource(parsed)) continue;
    try {
      // Important: explicit APIRequestContext re-fetch, not delayed response.body()/CDP lookup.
      // browserContext.request shares the browser context cookie jar.
      const response = await request.get(parsed.toString(), { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 10 });
      try {
        if (response.status() < 200 || response.status() >= 400) continue;
        const headers = response.headers();
        const contentType = headers['content-type'] ?? '';
        if (!TEXT_CONTENT_TYPE.test(contentType) && !/\.(?:m?js|json|xml|txt)(?:$|[?#])/i.test(parsed.pathname)) continue;
        const body = await response.body();
        if (body.byteLength > MAX_BODY_BYTES) {
          errors.push({ sourceUrl: parsed.toString(), message: `SOURCE_BODY_TOO_LARGE:${body.byteLength}` });
          continue;
        }
        const tokens = extractUrlTokens(body.toString('utf8'), 4000);
        const family: SourceFamily = /json/i.test(contentType) || /\.json(?:$|[?#])/i.test(parsed.pathname) ? 'json_config_url_token' : 'external_script_url_token';
        const observedAt = new Date().toISOString();
        for (const token of tokens) candidates.push({
          rawUrl: token,
          baseUrl: parsed.toString(),
          provenance: { sourceFamily: family, discoveredOn: entryUrl, sourceUrl: parsed.toString(), resourceType: contentType },
          observedAt,
        });
      } finally { await response.dispose?.(); }
    } catch (error) {
      errors.push({ sourceUrl: parsed.toString(), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { candidates, errors };
}

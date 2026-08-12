import type {
  ApiRequestContextLike,
  ObservedTechnicalSource,
  RawUrlCandidate,
  TechnicalSourceError,
} from './types.ts';
import { extractUrlLikeTokens, resolveCasinoRouteToken } from './token-extractor.ts';

const TECHNICAL_EXT_RE = /\.(?:m?js|cjs|json|xml|txt)(?:$|[?#])/i;
const TECHNICAL_TYPES = new Set(['script', 'xhr', 'fetch']);

export interface TechnicalScanOptions {
  timeoutMs?: number;
  maxSources?: number;
  maxBodyBytes?: number;
}

export function shouldScanObservedTechnicalSource(source: ObservedTechnicalSource): boolean {
  if (source.resourceType && TECHNICAL_TYPES.has(source.resourceType)) return true;
  try {
    const url = new URL(source.url);
    return TECHNICAL_EXT_RE.test(url.pathname) || /(?:^|\/)(?:api|graphql)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function familyFor(
  source: ObservedTechnicalSource,
  contentType: string,
): 'external_script_url_token' | 'json_config_url_token' {
  if (
    source.resourceType === 'script' ||
    /javascript|ecmascript/i.test(contentType) ||
    /\.(?:m?js|cjs)(?:$|[?#])/i.test(source.url)
  ) {
    return 'external_script_url_token';
  }
  return 'json_config_url_token';
}

export async function scanObservedTechnicalSources(
  request: ApiRequestContextLike,
  sources: readonly ObservedTechnicalSource[],
  entryUrl: string,
  allowedHosts: ReadonlySet<string>,
  options: TechnicalScanOptions = {},
): Promise<{ candidates: RawUrlCandidate[]; errors: TechnicalSourceError[] }> {
  const timeoutMs = options.timeoutMs ?? 6_000;
  const maxSources = options.maxSources ?? 120;
  const maxBodyBytes = options.maxBodyBytes ?? 5_000_000;
  const candidates: RawUrlCandidate[] = [];
  const errors: TechnicalSourceError[] = [];

  const unique = [...new Map(
    sources.filter(shouldScanObservedTechnicalSource).map(source => [source.url, source]),
  ).values()].slice(0, maxSources);

  for (const source of unique) {
    try {
      const response = await request.get(source.url, {
        timeout: timeoutMs,
        failOnStatusCode: false,
      });
      if (!response.ok()) {
        errors.push({
          url: source.url,
          code: 'TECHNICAL_SOURCE_HTTP_ERROR',
          message: `HTTP ${response.status()}`,
        });
        continue;
      }

      const body = await response.body();
      if (body.byteLength > maxBodyBytes) {
        errors.push({
          url: source.url,
          code: 'TECHNICAL_SOURCE_TOO_LARGE',
          message: `${body.byteLength} bytes exceeds ${maxBodyBytes}`,
        });
        continue;
      }

      const headers = response.headers();
      const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
      const family = familyFor(source, contentType);

      for (const token of extractUrlLikeTokens(text)) {
        const resolved = resolveCasinoRouteToken(token, entryUrl, allowedHosts);
        if (!resolved) continue;

        candidates.push({
          rawUrl: resolved,
          baseUrl: entryUrl,
          provenance: {
            sourceFamily: family,
            discoveredOn: source.discoveredOn,
            sourceUrl: source.url,
            resourceType: source.resourceType,
          },
          observedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      errors.push({
        url: source.url,
        code: 'TECHNICAL_SOURCE_FETCH_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidates, errors };
}

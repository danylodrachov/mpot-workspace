// Typed extractor registry for url-map-recon declarative recipes.
//
// In production each extractor runs inside the page via browser_evaluate: the
// agent's JS executes against live DOM/network/script content and returns a
// distilled URL list. Offline (tests, replay without a browser) the same pure
// function runs against an already-supplied text/array snapshot. Either way
// the function signature never echoes the scanned source body back to the
// caller — only `urls` / `status` / `error` leave the function.

import {
  EXTRACTOR_ACCEPTED_INPUT_TYPES,
  type ExtractorFn,
  type ExtractorId,
  type ExtractorInput,
  type ExtractorInputKind,
  type ExtractorResult,
} from './types.ts';

const MAX_RESULTS = 500;
const MAX_URL_LENGTH = 2000;

/** Which of the accepted extractor input contracts are present on this input, if any. */
export function detectInputKind(input: ExtractorInput): ExtractorInputKind | undefined {
  if (input.html !== undefined) return 'html';
  if (input.json !== undefined) return 'json';
  if (input.text !== undefined) return 'text';
  if (input.scripts !== undefined) return 'scripts';
  return undefined;
}

export function getAcceptedInputTypes(id: ExtractorId): ExtractorInputKind[] {
  return EXTRACTOR_ACCEPTED_INPUT_TYPES[id] ?? [];
}

/**
 * Validate + resolve pre-extracted candidate strings against the same scheme /
 * length / count / dedupe checks every extractor's raw-source output goes through.
 * Shared by the candidate-ingestion path (extraction-coordinator.ts) and any
 * extractor whose raw output is itself a candidate list.
 */
export function resolveCandidates(candidates: string[], pageUrl: string): { urls: string[]; rejectedCount: number } {
  const urls: string[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
      rejectedCount++;
      continue;
    }
    let resolved: string;
    try {
      resolved = new URL(raw, pageUrl).toString();
    } catch {
      rejectedCount++;
      continue;
    }
    if (!/^https?:\/\//.test(resolved)) {
      rejectedCount++;
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    urls.push(resolved);
    if (urls.length >= MAX_RESULTS) break;
  }
  return { urls, rejectedCount };
}

function finish(pageUrl: string, candidates: string[]): ExtractorResult {
  const { urls, rejectedCount } = resolveCandidates(candidates, pageUrl);
  return { status: urls.length > 0 ? 'ok' : 'empty', urls, rejectedCount };
}

function attrExtract(html: string, attrs: string[]): string[] {
  const out: string[] = [];
  for (const attr of attrs) {
    const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) out.push(m[1]);
  }
  return out;
}

const domUrlAttributes: ExtractorFn = (input) => {
  if (!input.html) return { status: 'empty', urls: [], rejectedCount: 0 };
  const candidates = attrExtract(input.html, ['href', 'src', 'action', 'poster', 'data-href', 'data-url', 'routerlink']);
  return finish(input.pageUrl, candidates);
};

const documentMetadataUrls: ExtractorFn = (input) => {
  if (!input.html) return { status: 'empty', urls: [], rejectedCount: 0 };
  const linkRe = /<link[^>]+rel=["'](canonical|alternate|manifest|preload|prefetch|modulepreload)["'][^>]*>/gi;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(input.html))) {
    const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (hrefMatch) candidates.push(hrefMatch[1]);
  }
  return finish(input.pageUrl, candidates);
};

const frameFormUrls: ExtractorFn = (input) => {
  if (!input.html) return { status: 'empty', urls: [], rejectedCount: 0 };
  const candidates: string[] = [
    ...attrExtract(input.html, ['action']),
    ...(input.html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi) ?? [])
      .map((tag) => /src\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
      .filter((v): v is string => Boolean(v)),
    ...(input.html.match(/<area[^>]+href\s*=\s*["']([^"']+)["']/gi) ?? [])
      .map((tag) => /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
      .filter((v): v is string => Boolean(v)),
  ];
  return finish(input.pageUrl, candidates);
};

// NETWORK_REQUEST_URLS_V1 and PERFORMANCE_RESOURCE_URLS_V1 declare no accepted raw
// input types (EXTRACTOR_ACCEPTED_INPUT_TYPES) — their observations only ever carry
// pre-resolved candidates. In the deterministic pipeline (extraction-coordinator.ts)
// a `candidates` input is now intercepted by the shared candidate-ingestion path
// before any extractor id is dispatched to, so this function's `.candidates`
// handling is never reached from a recorded observation (Issue 29). It stays here,
// unchanged, for direct/offline callers (replay.ts, unit tests) that still invoke
// `runExtractor` on a pre-resolved candidate list directly.
const networkRequestUrls: ExtractorFn = (input) => {
  if (!input.candidates) return { status: 'empty', urls: [], rejectedCount: 0 };
  return finish(input.pageUrl, input.candidates);
};

const performanceResourceUrls: ExtractorFn = (input) => {
  if (!input.candidates) return { status: 'empty', urls: [], rejectedCount: 0 };
  return finish(input.pageUrl, input.candidates);
};

function scanScriptsForPathTokens(scripts: string[], match?: string): string[] {
  const candidates: string[] = [];
  const tokenRe = /["'](\/[a-z0-9][a-z0-9\-/_?=&%#.]*|https?:\/\/[a-z0-9.\-]+\/[a-z0-9\-/_?=&%#.]*)["']/gi;
  for (const script of scripts) {
    if (match && !script.includes(match)) continue;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(script))) candidates.push(m[1]);
  }
  return candidates;
}

const inlineScriptUrlTokens: ExtractorFn = (input) => {
  if (!input.scripts) return { status: 'empty', urls: [], rejectedCount: 0 };
  const scriptMatch = typeof input.params?.scriptMatch === 'string' ? input.params.scriptMatch : undefined;
  return finish(input.pageUrl, scanScriptsForPathTokens(input.scripts, scriptMatch));
};

const sameOriginScriptUrlTokens: ExtractorFn = (input) => {
  if (!input.scripts) return { status: 'empty', urls: [], rejectedCount: 0 };
  const scriptMatch = typeof input.params?.scriptMatch === 'string' ? input.params.scriptMatch : undefined;
  return finish(input.pageUrl, scanScriptsForPathTokens(input.scripts, scriptMatch));
};

function walkJsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 12) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkJsonStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walkJsonStrings(v, out, depth + 1);
  }
}

function extractUrlLikeStrings(strings: string[]): string[] {
  return strings.filter((s) => /^(\/[a-z0-9]|https?:\/\/)/i.test(s) && s.length < 2000);
}

const jsonEndpointUrlTokens: ExtractorFn = (input) => {
  if (!input.json) return { status: 'empty', urls: [], rejectedCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch (err) {
    return { status: 'error', urls: [], rejectedCount: 0, error: 'invalid_json' };
  }
  const strings: string[] = [];
  walkJsonStrings(parsed, strings);
  return finish(input.pageUrl, extractUrlLikeStrings(strings));
};

const frameworkManifestUrlTokens: ExtractorFn = (input) => {
  if (!input.json) return { status: 'empty', urls: [], rejectedCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch {
    return { status: 'error', urls: [], rejectedCount: 0, error: 'invalid_json' };
  }
  const strings: string[] = [];
  walkJsonStrings(parsed, strings);
  return finish(input.pageUrl, extractUrlLikeStrings(strings));
};

const robotsSitemapUrls: ExtractorFn = (input) => {
  if (!input.text) return { status: 'empty', urls: [], rejectedCount: 0 };
  const candidates = [...input.text.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  return finish(input.pageUrl, candidates);
};

const sitemapUrls: ExtractorFn = (input) => {
  if (!input.text) return { status: 'empty', urls: [], rejectedCount: 0 };
  const candidates = [...input.text.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
  return finish(input.pageUrl, candidates);
};

// SPA_ROUTE_URL_TOKENS_V1 accepts raw `scripts` only (EXTRACTOR_ACCEPTED_INPUT_TYPES).
// It still falls back to `.candidates` for direct/offline callers (replay.ts, unit
// tests); a recorded `candidates` observation from the deterministic pipeline is
// intercepted by the shared candidate-ingestion path before dispatch (Issue 29), so
// this branch is unreached from extraction-coordinator.ts.
const spaRouteUrlTokens: ExtractorFn = (input) => {
  const fromScripts = input.scripts ? scanScriptsForPathTokens(input.scripts) : [];
  const fromCandidates = input.candidates ?? [];
  const all = [...fromScripts, ...fromCandidates];
  if (all.length === 0) return { status: 'empty', urls: [], rejectedCount: 0 };
  return finish(input.pageUrl, all);
};

const interactionNavigationUrls: ExtractorFn = (input) => {
  if (!input.html) return { status: 'empty', urls: [], rejectedCount: 0 };
  const candidates: string[] = [];

  // Extract all href attributes (both visible and hidden menu items)
  candidates.push(...attrExtract(input.html, ['href']));

  // Extract from data-* attributes that contain URL-like values or JSON arrays
  const dataAttrRe = /data-[\w-]*\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = dataAttrRe.exec(input.html))) {
    const value = m[1];
    // Check if it's a URL/path string directly
    if (/^(\/|https?:\/\/)/.test(value)) {
      candidates.push(value);
    } else if (/^\[/.test(value) && /\]$/.test(value)) {
      // Handle data-*='["/url1","/url2"]' JSON arrays (e.g., data-drawer-items)
      try {
        const arr = JSON.parse(value);
        if (Array.isArray(arr)) {
          arr.forEach((item) => {
            if (typeof item === 'string') candidates.push(item);
          });
        }
      } catch {
        // Silently skip invalid JSON
      }
    }
  }

  return finish(input.pageUrl, candidates);
};

export const EXTRACTOR_REGISTRY: Record<ExtractorId, ExtractorFn> = {
  DOM_URL_ATTRIBUTES_V1: domUrlAttributes,
  DOCUMENT_METADATA_URLS_V1: documentMetadataUrls,
  FRAME_FORM_URLS_V1: frameFormUrls,
  NETWORK_REQUEST_URLS_V1: networkRequestUrls,
  PERFORMANCE_RESOURCE_URLS_V1: performanceResourceUrls,
  INLINE_SCRIPT_URL_TOKENS_V1: inlineScriptUrlTokens,
  SAME_ORIGIN_SCRIPT_URL_TOKENS_V1: sameOriginScriptUrlTokens,
  JSON_ENDPOINT_URL_TOKENS_V1: jsonEndpointUrlTokens,
  FRAMEWORK_MANIFEST_URL_TOKENS_V1: frameworkManifestUrlTokens,
  ROBOTS_SITEMAP_URLS_V1: robotsSitemapUrls,
  SITEMAP_URLS_V1: sitemapUrls,
  SPA_ROUTE_URL_TOKENS_V1: spaRouteUrlTokens,
  INTERACTION_NAVIGATION_URLS_V1: interactionNavigationUrls,
};

export function runExtractor(id: ExtractorId, input: ExtractorInput): ExtractorResult {
  const fn = EXTRACTOR_REGISTRY[id];
  if (!fn) return { status: 'error', urls: [], rejectedCount: 0, error: 'unknown_extractor' };
  try {
    return fn(input);
  } catch (err) {
    return { status: 'error', urls: [], rejectedCount: 0, error: err instanceof Error ? err.message : 'extractor_failed' };
  }
}

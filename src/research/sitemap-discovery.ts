import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  isSitemapAccessGateResponse,
  type SitemapBrowserFetcher,
} from './sitemap-browser-fallback.ts';

export interface ApiResponseLike {
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  url?(): string;
}

export interface ApiRequestLike {
  get(url: string, options?: {
    timeout?: number;
    failOnStatusCode?: boolean;
    maxRedirects?: number;
  }): Promise<ApiResponseLike>;
}

export type SitemapKind = 'sitemap_index' | 'urlset' | 'rss' | 'atom' | 'text';
export type RootDiscoverySource =
  | 'input_document'
  | 'robots'
  | 'link_header'
  | 'rendered_dom'
  | 'document_text'
  | 'network_observation'
  | 'configured_fallback';
export type SitemapDiscoverySource = RootDiscoverySource | 'sitemap_index';

export interface SeedObservation {
  requested_url: string;
  final_url: string | null;
  navigation_status: 'ok' | 'http_error' | 'navigation_error';
  http_status: number | null;
  content_type: string | null;
  main_response_body?: Buffer | null;
  link_header_candidates: string[];
  rendered_dom_candidates: string[];
  document_text_candidates: string[];
  network_candidates: string[];
  configured_fallback_candidates?: string[];
  error_reason: string | null;
}

export interface SitemapFetchAttempt {
  url: string;
  sources: SitemapDiscoverySource[];
  parent_url: string | null;
  status: 'ok' | 'http_error' | 'fetch_error' | 'not_sitemap';
  http_status: number | null;
  content_type: string | null;
  final_url: string | null;
  reason: string | null;
  fetch_method?: 'api_request' | 'browser_navigation' | 'seed_document';
  fallback_from_http_status?: number | null;
  fallback_error?: string | null;
}

export interface SitemapFileRecord {
  url: string;
  final_url: string;
  parent_url: string | null;
  discovered_by: SitemapDiscoverySource[];
  kind: SitemapKind;
  file_name: string;
  loc_count: number;
  child_sitemap_count: number;
  page_url_count: number;
}

export interface RobotsResult {
  url: string;
  origin: string;
  status: 'ok' | 'http_error' | 'fetch_error';
  http_status: number | null;
  sitemap_directives: string[];
  reason: string | null;
  fetch_method?: 'api_request' | 'browser_navigation';
  fallback_from_http_status?: number | null;
  fallback_error?: string | null;
}

export interface SitemapDiscoverySuccess {
  status: 'found';
  input_url: string;
  origin: string;
  started_at: string;
  finished_at: string;
  seed: Omit<SeedObservation, 'main_response_body'>;
  robots: RobotsResult[];
  root_sitemaps: Array<{ url: string; discovered_by: RootDiscoverySource[] }>;
  sitemap_files: SitemapFileRecord[];
  category_sitemaps: Array<{
    url: string;
    parent_url: string;
    file_name: string;
    kind: SitemapKind;
  }>;
  page_urls: string[];
  attempts: SitemapFetchAttempt[];
  counts: {
    root_sitemaps: number;
    sitemap_files: number;
    category_sitemaps: number;
    page_urls: number;
  };
}

export interface SitemapDiscoveryNotFound {
  status: 'not_discovered';
  input_url: string;
  origin: string;
  started_at: string;
  finished_at: string;
  seed: Omit<SeedObservation, 'main_response_body'>;
  robots: RobotsResult[];
  attempts: SitemapFetchAttempt[];
  reason: {
    code: 'SITEMAP_NOT_DISCOVERABLE';
    message: string;
    checked_signals: string[];
    limitations: string[];
  };
}

export type SitemapDiscoveryResult = SitemapDiscoverySuccess | SitemapDiscoveryNotFound;

export interface SitemapDiscoveryOptions {
  requestTimeoutMs?: number;
  maxRedirects?: number;
  maxSitemapFiles?: number;
  maxPageUrls?: number;
  browserFallback?: SitemapBrowserFetcher;
}

const DEFAULT_MAX_SITEMAP_FILES = 5_000;
const DEFAULT_MAX_PAGE_URLS = 1_000_000;

function now(): string {
  return new Date().toISOString();
}

export function normalizeEntryUrl(input: string): URL {
  const trimmed = input.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url;
}

function decodeXml(value: string): string {
  const unwrapped = value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1');
  return unwrapped
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function maybeGunzip(buffer: Buffer): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer);
  }
  return buffer;
}

function extractLocValues(xml: string): string[] {
  const values: string[] = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?loc\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?loc\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const value = decodeXml(match[1] ?? '');
    if (value) values.push(value);
  }
  return values;
}

function extractRssLinks(xml: string): string[] {
  const values: string[] = [];
  const itemPattern = /<(?:[A-Za-z_][\w.-]*:)?item\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?item\s*>/gi;
  for (const item of xml.matchAll(itemPattern)) {
    const match = /<(?:[A-Za-z_][\w.-]*:)?link\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?link\s*>/i.exec(item[1] ?? '');
    const value = match ? decodeXml(match[1] ?? '') : '';
    if (value) values.push(value);
  }
  return values;
}

function extractAtomLinks(xml: string): string[] {
  const values: string[] = [];
  const entryPattern = /<(?:[A-Za-z_][\w.-]*:)?entry\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?entry\s*>/gi;
  for (const entry of xml.matchAll(entryPattern)) {
    const tag = /<(?:[A-Za-z_][\w.-]*:)?link\b([^>]*)>/i.exec(entry[1] ?? '');
    if (!tag) continue;
    const href = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag[1] ?? '');
    const value = decodeXml(href?.[1] ?? href?.[2] ?? href?.[3] ?? '');
    if (value) values.push(value);
  }
  return values;
}

export function parseSitemapDocument(
  body: string,
  contentType: string | null = null,
): { kind: SitemapKind; locations: string[] } | null {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  const xmlRoot = /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[A-Za-z_][\w.-]*:)?(sitemapindex|urlset|rss|feed)\b/i.exec(text);
  if (xmlRoot) {
    const root = xmlRoot[1].toLowerCase();
    if (root === 'sitemapindex') return { kind: 'sitemap_index', locations: extractLocValues(text) };
    if (root === 'urlset') return { kind: 'urlset', locations: extractLocValues(text) };
    if (root === 'rss') return { kind: 'rss', locations: extractRssLinks(text) };
    if (root === 'feed') return { kind: 'atom', locations: extractAtomLinks(text) };
  }

  const isPlainText = /(?:^|;)\s*text\/plain(?:;|$)/i.test(contentType ?? '');
  if (isPlainText) {
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    if (lines.length > 0 && lines.every(line => resolveHttpUrl(line, undefined) !== null)) {
      return { kind: 'text', locations: lines };
    }
  }

  return null;
}

/** Backward-compatible XML-only helper retained for callers/tests. */
export function parseSitemapXml(xml: string): { kind: 'sitemap_index' | 'urlset'; locations: string[] } | null {
  const parsed = parseSitemapDocument(xml, 'application/xml');
  if (!parsed || (parsed.kind !== 'sitemap_index' && parsed.kind !== 'urlset')) return null;
  return parsed;
}

export function parseRobotsSitemaps(robotsText: string, robotsUrl: string): string[] {
  const urls = new Set<string>();
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const match = /^sitemap\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;
    const resolved = resolveHttpUrl(match[1].trim(), robotsUrl);
    if (resolved) urls.add(resolved);
  }
  return [...urls];
}

function splitLinkHeader(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== '\\') quoted = !quoted;
    if (!quoted && char === '<') angleDepth += 1;
    if (!quoted && char === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && char === ',') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseLinkHeaderSitemaps(linkHeader: string | null, baseUrl: string): string[] {
  if (!linkHeader) return [];
  const urls = new Set<string>();
  for (const part of splitLinkHeader(linkHeader)) {
    const target = /^\s*<([^>]+)>/.exec(part)?.[1];
    if (!target) continue;
    const relMatch = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(part);
    const rel = (relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? '')
      .split(/\s+/)
      .map(value => value.toLowerCase());
    if (!rel.includes('sitemap')) continue;
    const resolved = resolveHttpUrl(target, baseUrl);
    if (resolved) urls.add(resolved);
  }
  return [...urls];
}

export function looksLikeSitemapReference(url: string): boolean {
  try {
    const parsed = new URL(url);
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return haystack.includes('sitemap') || /\.xml(?:\.gz)?(?:$|[?#])/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export function extractSitemapReferencesFromText(text: string, baseUrl: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s"'<>`\\]+/gi,
    /["'`]([^"'`\s<>]*(?:sitemap|\.xml(?:\.gz)?)[^"'`\s<>]*)["'`]/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0] ?? '').replace(/&amp;/gi, '&');
      const resolved = resolveHttpUrl(raw, baseUrl);
      if (resolved && looksLikeSitemapReference(resolved)) candidates.add(resolved);
    }
  }
  return [...candidates];
}

function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return path.posix.basename(pathname) || 'sitemap';
  } catch {
    return 'sitemap';
  }
}

function resolveHttpUrl(value: string, base?: string): string | null {
  try {
    const resolved = base ? new URL(value, base) : new URL(value);
    if (!['http:', 'https:'].includes(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

type FetchedDocument = {
  status: number;
  contentType: string | null;
  body: Buffer;
  finalUrl: string;
  headers: Record<string, string>;
  accessBlocked: boolean;
  fetchMethod: 'api_request' | 'browser_navigation' | 'seed_document';
  fallbackFromHttpStatus: number | null;
  fallbackError: string | null;
};

async function fetchDocument(
  request: ApiRequestLike,
  url: string,
  timeoutMs: number,
  maxRedirects: number,
  browserFallback?: SitemapBrowserFetcher,
): Promise<FetchedDocument> {
  const response = await request.get(url, {
    timeout: timeoutMs,
    failOnStatusCode: false,
    maxRedirects,
  });
  const headers = response.headers();
  const body = maybeGunzip(await response.body());
  const apiDocument = {
    status: response.status(),
    headers,
    body,
    finalUrl: response.url?.() || url,
  };
  const apiBlocked = isSitemapAccessGateResponse(apiDocument);
  if (!browserFallback || !apiBlocked) {
    return {
      ...apiDocument,
      contentType: headerValue(headers, 'content-type'),
      accessBlocked: apiBlocked,
      fetchMethod: 'api_request',
      fallbackFromHttpStatus: null,
      fallbackError: null,
    };
  }

  try {
    const browserDocument = await browserFallback(url, { timeoutMs });
    const browserBody = maybeGunzip(browserDocument.body);
    const browserNormalized = { ...browserDocument, body: browserBody };
    return {
      status: browserDocument.status,
      contentType: headerValue(browserDocument.headers, 'content-type'),
      body: browserBody,
      finalUrl: browserDocument.finalUrl,
      headers: browserDocument.headers,
      accessBlocked: isSitemapAccessGateResponse(browserNormalized),
      fetchMethod: 'browser_navigation',
      fallbackFromHttpStatus: apiDocument.status,
      fallbackError: null,
    };
  } catch (error) {
    return {
      ...apiDocument,
      contentType: headerValue(headers, 'content-type'),
      accessBlocked: apiBlocked,
      fetchMethod: 'api_request',
      fallbackFromHttpStatus: null,
      fallbackError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchRobotsForOrigin(
  request: ApiRequestLike,
  origin: string,
  timeoutMs: number,
  maxRedirects: number,
  browserFallback?: SitemapBrowserFetcher,
): Promise<RobotsResult> {
  const url = new URL('/robots.txt', origin).toString();
  try {
    const response = await fetchDocument(request, url, timeoutMs, maxRedirects, browserFallback);
    if (response.accessBlocked) {
      return {
        url,
        origin,
        status: 'http_error',
        http_status: response.status,
        sitemap_directives: [],
        reason: 'SITEMAP_ACCESS_BLOCKED: robots.txt remained behind an access gate after deterministic acquisition attempts',
        fetch_method: response.fetchMethod === 'seed_document' ? 'api_request' : response.fetchMethod,
        fallback_from_http_status: response.fallbackFromHttpStatus,
        fallback_error: response.fallbackError,
      };
    }
    if (response.status < 200 || response.status >= 400) {
      return {
        url,
        origin,
        status: 'http_error',
        http_status: response.status,
        sitemap_directives: [],
        reason: `robots.txt returned HTTP ${response.status}`,
        fetch_method: response.fetchMethod === 'seed_document' ? 'api_request' : response.fetchMethod,
        fallback_from_http_status: response.fallbackFromHttpStatus,
        fallback_error: response.fallbackError,
      };
    }
    const directives = parseRobotsSitemaps(response.body.toString('utf8'), response.finalUrl);
    return {
      url,
      origin,
      status: 'ok',
      http_status: response.status,
      sitemap_directives: directives,
      reason: directives.length ? null : 'robots.txt contains no valid Sitemap directives',
      fetch_method: response.fetchMethod === 'seed_document' ? 'api_request' : response.fetchMethod,
      fallback_from_http_status: response.fallbackFromHttpStatus,
      fallback_error: response.fallbackError,
    };
  } catch (error) {
    return {
      url,
      origin,
      status: 'fetch_error',
      http_status: null,
      sitemap_directives: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

type RootCandidate = { url: string; sources: Set<RootDiscoverySource> };
type QueueItem = {
  url: string;
  sources: SitemapDiscoverySource[];
  parentUrl: string | null;
  preloaded?: { body: Buffer; contentType: string | null; finalUrl: string; httpStatus: number | null };
};

function addRootCandidate(map: Map<string, RootCandidate>, url: string, source: RootDiscoverySource): void {
  const normalized = resolveHttpUrl(url);
  if (!normalized) return;
  const current = map.get(normalized);
  if (current) {
    current.sources.add(source);
  } else {
    map.set(normalized, { url: normalized, sources: new Set([source]) });
  }
}

async function walkSitemaps(
  request: ApiRequestLike,
  roots: QueueItem[],
  attempts: SitemapFetchAttempt[],
  options: Required<Pick<SitemapDiscoveryOptions, 'requestTimeoutMs' | 'maxRedirects' | 'maxSitemapFiles' | 'maxPageUrls'>>,
  browserFallback?: SitemapBrowserFetcher,
): Promise<{ files: SitemapFileRecord[]; pageUrls: string[] }> {
  const queue = [...roots];
  const queued = new Set(queue.map(item => item.url));
  const visited = new Set<string>();
  const files: SitemapFileRecord[] = [];
  const pageUrls = new Set<string>();

  while (queue.length) {
    const item = queue.shift()!;
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    if (visited.size > options.maxSitemapFiles) {
      throw new Error(`SITEMAP_FILE_LIMIT_EXCEEDED: more than ${options.maxSitemapFiles} sitemap files discovered`);
    }

    try {
      const response = item.preloaded
        ? {
            status: item.preloaded.httpStatus ?? 200,
            contentType: item.preloaded.contentType,
            body: maybeGunzip(item.preloaded.body),
            finalUrl: item.preloaded.finalUrl,
            headers: {},
            accessBlocked: false,
            fetchMethod: 'seed_document' as const,
            fallbackFromHttpStatus: null,
            fallbackError: null,
          }
        : await fetchDocument(request, item.url, options.requestTimeoutMs, options.maxRedirects, browserFallback);

      if (response.accessBlocked) {
        attempts.push({
          url: item.url,
          sources: item.sources,
          parent_url: item.parentUrl,
          status: 'http_error',
          http_status: response.status,
          content_type: response.contentType,
          final_url: response.finalUrl,
          reason: 'SITEMAP_ACCESS_BLOCKED: sitemap remained behind an access gate after deterministic acquisition attempts',
          fetch_method: response.fetchMethod,
          fallback_from_http_status: response.fallbackFromHttpStatus,
          fallback_error: response.fallbackError,
        });
        continue;
      }

      if (response.status < 200 || response.status >= 400) {
        attempts.push({
          url: item.url,
          sources: item.sources,
          parent_url: item.parentUrl,
          status: 'http_error',
          http_status: response.status,
          content_type: response.contentType,
          final_url: response.finalUrl,
          reason: `HTTP ${response.status}`,
          fetch_method: response.fetchMethod,
          fallback_from_http_status: response.fallbackFromHttpStatus,
          fallback_error: response.fallbackError,
        });
        continue;
      }

      const parsed = parseSitemapDocument(response.body.toString('utf8'), response.contentType);
      if (!parsed) {
        attempts.push({
          url: item.url,
          sources: item.sources,
          parent_url: item.parentUrl,
          status: 'not_sitemap',
          http_status: response.status,
          content_type: response.contentType,
          final_url: response.finalUrl,
          reason: 'Response is not a supported sitemap document (sitemapindex, urlset, RSS, Atom, or plain-text sitemap).',
          fetch_method: response.fetchMethod,
          fallback_from_http_status: response.fallbackFromHttpStatus,
          fallback_error: response.fallbackError,
        });
        continue;
      }

      const resolvedLocations = parsed.locations
        .map(value => resolveHttpUrl(value, response.finalUrl))
        .filter((value): value is string => Boolean(value));

      if (parsed.kind === 'sitemap_index') {
        for (const child of resolvedLocations) {
          if (!queued.has(child) && !visited.has(child)) {
            queued.add(child);
            queue.push({ url: child, sources: ['sitemap_index'], parentUrl: response.finalUrl });
          }
        }
      } else {
        for (const pageUrl of resolvedLocations) {
          pageUrls.add(pageUrl);
          if (pageUrls.size > options.maxPageUrls) {
            throw new Error(`PAGE_URL_LIMIT_EXCEEDED: more than ${options.maxPageUrls} page URLs discovered in sitemaps`);
          }
        }
      }

      files.push({
        url: item.url,
        final_url: response.finalUrl,
        parent_url: item.parentUrl,
        discovered_by: item.sources,
        kind: parsed.kind,
        file_name: fileNameFromUrl(response.finalUrl),
        loc_count: resolvedLocations.length,
        child_sitemap_count: parsed.kind === 'sitemap_index' ? resolvedLocations.length : 0,
        page_url_count: parsed.kind === 'sitemap_index' ? 0 : resolvedLocations.length,
      });
      attempts.push({
        url: item.url,
        sources: item.sources,
        parent_url: item.parentUrl,
        status: 'ok',
        http_status: response.status,
        content_type: response.contentType,
        final_url: response.finalUrl,
        reason: null,
        fetch_method: response.fetchMethod,
        fallback_from_http_status: response.fallbackFromHttpStatus,
        fallback_error: response.fallbackError,
      });
    } catch (error) {
      if (error instanceof Error && /(?:SITEMAP_FILE|PAGE_URL)_LIMIT_EXCEEDED/.test(error.message)) throw error;
      attempts.push({
        url: item.url,
        sources: item.sources,
        parent_url: item.parentUrl,
        status: 'fetch_error',
        http_status: null,
        content_type: null,
        final_url: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { files, pageUrls: [...pageUrls] };
}

function stripSeedBody(seed: SeedObservation): Omit<SeedObservation, 'main_response_body'> {
  const { main_response_body: _body, ...serializable } = seed;
  return serializable;
}

function notDiscoveredReason(seed: SeedObservation, robots: RobotsResult[]): SitemapDiscoveryNotFound['reason'] {
  const robotsSummary = robots.length
    ? robots.map(item => `${item.url}: ${item.status}${item.sitemap_directives.length ? ` (${item.sitemap_directives.length} Sitemap directive(s))` : ''}`).join('; ')
    : 'no robots origin could be derived';

  return {
    code: 'SITEMAP_NOT_DISCOVERABLE',
    message: `No supported sitemap could be verified from the available deterministic signals. robots checks: ${robotsSummary}. Seed navigation: ${seed.navigation_status}${seed.error_reason ? ` (${seed.error_reason})` : ''}.`,
    checked_signals: [
      'robots.txt Sitemap directives for the input origin and final redirected origin',
      'the supplied input document itself when its response body is available',
      'HTTP Link headers with rel="sitemap" observed during seed navigation',
      'sitemap-looking URL references in the rendered seed DOM',
      'sitemap-looking URL/path strings in the rendered seed document text',
      'sitemap/XML responses observed while loading the supplied seed URL',
      'recursive child files declared by every verified sitemap index',
    ],
    limitations: [
      'Only explicitly configured fallback sitemap paths are probed; no unbounded path guessing is performed.',
      'No page URL discovered inside a sitemap is navigated or fetched.',
      'No links from the seed page are crawled.',
      'This result means "not discoverable from observed signals", not "the site has no sitemap".',
    ],
  };
}

export async function discoverSitemaps(
  request: ApiRequestLike,
  inputUrl: string,
  seed: SeedObservation,
  options: SitemapDiscoveryOptions = {},
): Promise<SitemapDiscoveryResult> {
  const startedAt = now();
  const entry = normalizeEntryUrl(inputUrl);
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  const maxRedirects = options.maxRedirects ?? 10;
  const maxSitemapFiles = options.maxSitemapFiles ?? DEFAULT_MAX_SITEMAP_FILES;
  const maxPageUrls = options.maxPageUrls ?? DEFAULT_MAX_PAGE_URLS;
  const attempts: SitemapFetchAttempt[] = [];
  const rootCandidates = new Map<string, RootCandidate>();

  const origins = new Set<string>([entry.origin]);
  if (seed.final_url) {
    const finalUrl = resolveHttpUrl(seed.final_url);
    if (finalUrl) origins.add(new URL(finalUrl).origin);
  }

  const robots: RobotsResult[] = [];
  for (const origin of origins) {
    const result = await fetchRobotsForOrigin(request, origin, requestTimeoutMs, maxRedirects, options.browserFallback);
    robots.push(result);
    for (const url of result.sitemap_directives) addRootCandidate(rootCandidates, url, 'robots');
  }

  for (const url of seed.link_header_candidates) addRootCandidate(rootCandidates, url, 'link_header');
  for (const url of seed.rendered_dom_candidates) addRootCandidate(rootCandidates, url, 'rendered_dom');
  for (const url of seed.document_text_candidates) addRootCandidate(rootCandidates, url, 'document_text');
  for (const url of seed.network_candidates) addRootCandidate(rootCandidates, url, 'network_observation');
  for (const url of seed.configured_fallback_candidates ?? []) addRootCandidate(rootCandidates, url, 'configured_fallback');

  const preloadedRootUrl = seed.final_url && seed.main_response_body
    ? resolveHttpUrl(seed.final_url)
    : null;
  if (preloadedRootUrl && seed.main_response_body) {
    const parsed = parseSitemapDocument(seed.main_response_body.toString('utf8'), seed.content_type);
    if (parsed) addRootCandidate(rootCandidates, preloadedRootUrl, 'input_document');
  }

  const roots: QueueItem[] = [...rootCandidates.values()].map(candidate => {
    const sources = [...candidate.sources];
    const usePreloaded = preloadedRootUrl === candidate.url && seed.main_response_body
      ? {
          body: seed.main_response_body,
          contentType: seed.content_type,
          finalUrl: seed.final_url ?? candidate.url,
          httpStatus: seed.http_status,
        }
      : undefined;
    return { url: candidate.url, sources, parentUrl: null, preloaded: usePreloaded };
  });

  const walked = await walkSitemaps(request, roots, attempts, {
    requestTimeoutMs,
    maxRedirects,
    maxSitemapFiles,
    maxPageUrls,
  }, options.browserFallback);

  if (walked.files.length) {
    const successfulRootUrls = new Set(
      walked.files.filter(file => file.parent_url === null).map(file => file.url),
    );
    const rootSitemaps = [...rootCandidates.values()]
      .filter(candidate => successfulRootUrls.has(candidate.url))
      .map(candidate => ({ url: candidate.url, discovered_by: [...candidate.sources] }));
    const categorySitemaps = walked.files
      .filter(file => file.parent_url !== null)
      .map(file => ({
        url: file.url,
        parent_url: file.parent_url!,
        file_name: file.file_name,
        kind: file.kind,
      }));

    return {
      status: 'found',
      input_url: entry.toString(),
      origin: entry.origin,
      started_at: startedAt,
      finished_at: now(),
      seed: stripSeedBody(seed),
      robots,
      root_sitemaps: rootSitemaps,
      sitemap_files: walked.files,
      category_sitemaps: categorySitemaps,
      page_urls: walked.pageUrls,
      attempts,
      counts: {
        root_sitemaps: rootSitemaps.length,
        sitemap_files: walked.files.length,
        category_sitemaps: categorySitemaps.length,
        page_urls: walked.pageUrls.length,
      },
    };
  }

  return {
    status: 'not_discovered',
    input_url: entry.toString(),
    origin: entry.origin,
    started_at: startedAt,
    finished_at: now(),
    seed: stripSeedBody(seed),
    robots,
    attempts,
    reason: notDiscoveredReason(seed, robots),
  };
}

function safeHostFolder(hostname: string): string {
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '_');
}

function runStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export async function writeSitemapDiscoveryJson(
  outputRoot: string,
  result: SitemapDiscoverySuccess,
): Promise<{ runDir: string; jsonPath: string }> {
  const host = safeHostFolder(new URL(result.origin).hostname);
  const runDir = path.join(path.resolve(outputRoot), host, runStamp());
  const jsonPath = path.join(runDir, 'sitemap-discovery-log.json');
  await mkdir(runDir, { recursive: true });
  const tempPath = `${jsonPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(tempPath, jsonPath);
  return { runDir, jsonPath };
}

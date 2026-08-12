import { randomUUID } from 'node:crypto';

import {
  discoverSitemaps,
  looksLikeSitemapReference,
  type SeedObservation,
  type SitemapDiscoveryResult,
} from '../sitemap-discovery.ts';
import { discoverFromSeedWithoutCrawl, type SeedDiscoveryOptions } from './seed-discovery.ts';
import type {
  CandidateProvenance,
  PageLike,
  RawUrlCandidate,
  SeedDiscoveryResult,
  SourceFamily,
} from './types.ts';

export type UrlSourceCoverageStatus = 'complete' | 'absent' | 'blocked' | 'unsupported' | 'error';

export interface UrlSourceCoverageRecord {
  extractorId: string;
  sourceFamily: string;
  status: UrlSourceCoverageStatus;
  candidateCount: number;
  resolvedCount: number;
  errorCount: number;
  durationMs: number | null;
  errorCodes: string[];
}

/**
 * One resolved/canonical URL in the discovered map.
 *
 * This is intentionally not an allow/reject decision. Any HTTP(S) candidate
 * that can be resolved is retained. `navigationUrl` is currently identical to
 * `canonicalUrl` and exists only to keep downstream consumers explicit about
 * which exact URL string they would navigate to.
 */
export interface UrlMapEntry {
  canonicalUrl: string;
  navigationUrl: string;
  provenance: CandidateProvenance[];
}

export interface UrlMapDiscoverySummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  counts: {
    rawCandidates: number;
    resolvedUrls: number;
    unresolvedCandidates: number;
    observedTechnicalSources: number;
    technicalSourceErrors: number;
    sitemapPageUrls: number;
    sitemapAttempts: number;
  };
  sourceCoverage: UrlSourceCoverageRecord[];
}

export interface FullUrlMapDiscoveryResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  rawCandidates: RawUrlCandidate[];
  urlMap: UrlMapEntry[];
  sourceCoverage: UrlSourceCoverageRecord[];
  seedDiscovery: SeedDiscoveryResult;
  sitemapDiscovery: SitemapDiscoveryResult;
  summary: UrlMapDiscoverySummary;
}

export interface FullUrlMapDiscoveryOptions extends SeedDiscoveryOptions {
  fallbackSitemapPaths?: string[];
  sitemapRequestTimeoutMs?: number;
  sitemapMaxRedirects?: number;
  sitemapMaxFiles?: number;
  sitemapMaxPageUrls?: number;
}

const DEFAULT_FALLBACK_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
  '/sitemap/sitemap.xml',
];

const SEED_FAMILIES: Array<{ family: SourceFamily; extractorId: string }> = [
  { family: 'entry_url', extractorId: 'ENTRY_URL_V1' },
  { family: 'dom_url_attribute', extractorId: 'DOM_URL_ATTRIBUTES_V1' },
  { family: 'document_metadata', extractorId: 'DOCUMENT_METADATA_URLS_V1' },
  { family: 'network_document', extractorId: 'NETWORK_DOCUMENT_URLS_V1' },
  { family: 'network_source_url', extractorId: 'NETWORK_SOURCE_URLS_V1' },
  { family: 'performance_resource', extractorId: 'PERFORMANCE_RESOURCE_URLS_V1' },
  { family: 'inline_script_url_token', extractorId: 'INLINE_SCRIPT_URL_TOKENS_V1' },
  { family: 'history_route', extractorId: 'SPA_HISTORY_ROUTE_TOKENS_V1' },
  { family: 'external_script_url_token', extractorId: 'EXTERNAL_SCRIPT_URL_TOKENS_V1' },
  { family: 'json_config_url_token', extractorId: 'JSON_CONFIG_URL_TOKENS_V1' },
  { family: 'sitemap_page_url', extractorId: 'SITEMAP_PAGE_URLS_V1' },
];

function now(): string {
  return new Date().toISOString();
}

/**
 * Neutral URL resolution/canonicalisation only.
 *
 * No route policy is applied here: no content/path classification, no
 * relevance filtering, no query stripping, no route collapsing and no host
 * rejection. URL() provides standards-based resolution/normalisation; only
 * non-HTTP(S) values cannot become web-map entries and remain preserved in
 * raw-url-candidates.json.
 */
function resolveRaw(candidate: RawUrlCandidate): string | null {
  try {
    const url = new URL(candidate.rawUrl, candidate.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeRawCandidates(candidates: readonly RawUrlCandidate[]): RawUrlCandidate[] {
  const seen = new Set<string>();
  const out: RawUrlCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.rawUrl,
      candidate.baseUrl,
      candidate.provenance.sourceFamily,
      candidate.provenance.sourceUrl ?? '',
      candidate.provenance.label ?? '',
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function makeSitemapSeed(
  entryUrl: string,
  seed: SeedDiscoveryResult,
  fallbackPaths: readonly string[],
): SeedObservation {
  const fallbackUrls = fallbackPaths.map(path => new URL(path, entryUrl).toString());
  const rendered = new Set<string>();
  const network = new Set<string>();
  for (const candidate of seed.rawCandidates) {
    const resolved = resolveRaw(candidate);
    if (!resolved || !looksLikeSitemapReference(resolved)) continue;
    if (candidate.provenance.sourceFamily.startsWith('network_')) network.add(resolved);
    else rendered.add(resolved);
  }
  return {
    requested_url: entryUrl,
    final_url: seed.finalEntryUrl || entryUrl,
    navigation_status: 'ok',
    http_status: null,
    content_type: null,
    main_response_body: null,
    link_header_candidates: [],
    rendered_dom_candidates: [...rendered],
    document_text_candidates: [],
    network_candidates: [...network],
    configured_fallback_candidates: fallbackUrls,
    error_reason: null,
  };
}

function sitemapRawCandidates(result: SitemapDiscoveryResult, entryUrl: string): RawUrlCandidate[] {
  if (result.status !== 'found') return [];
  const observedAt = now();
  return result.page_urls.map(url => ({
    rawUrl: url,
    baseUrl: entryUrl,
    provenance: {
      sourceFamily: 'sitemap_page_url',
      discoveredOn: entryUrl,
      label: 'sitemap page URL',
    },
    observedAt,
  }));
}

function addUniqueProvenance(target: CandidateProvenance[], value: CandidateProvenance): void {
  const key = JSON.stringify(value);
  if (!target.some(item => JSON.stringify(item) === key)) target.push(value);
}

/**
 * Resolve + canonicalise + deduplicate the discovered map without filtering.
 * Every resolvable HTTP(S) candidate survives regardless of path, host,
 * resource type, API shape or inferred relevance.
 */
export function resolveAndDedupeUrlMap(rawCandidates: readonly RawUrlCandidate[]): UrlMapEntry[] {
  const byCanonical = new Map<string, UrlMapEntry>();

  for (const candidate of rawCandidates) {
    const canonicalUrl = resolveRaw(candidate);
    if (!canonicalUrl) continue;

    const existing = byCanonical.get(canonicalUrl);
    if (existing) {
      addUniqueProvenance(existing.provenance, candidate.provenance);
      continue;
    }

    byCanonical.set(canonicalUrl, {
      canonicalUrl,
      navigationUrl: canonicalUrl,
      provenance: [candidate.provenance],
    });
  }

  return [...byCanonical.values()].sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
}

function sourceCoverageStatusForSitemaps(
  result: SitemapDiscoveryResult,
): { status: UrlSourceCoverageStatus; errorCodes: string[]; errorCount: number } {
  const attempts = result.attempts ?? [];
  const blocked =
    attempts.some(item => item.status === 'http_error' && [401, 403, 429].includes(item.http_status ?? 0)) ||
    result.robots.some(item => item.status === 'http_error' && [401, 403, 429].includes(item.http_status ?? 0));
  const errors =
    attempts.filter(item => item.status === 'fetch_error').length +
    result.robots.filter(item => item.status === 'fetch_error').length;

  if (result.status === 'found') {
    return {
      status: errors > 0 ? 'error' : 'complete',
      errorCodes: errors > 0 ? ['SITEMAP_PARTIAL_FETCH_ERROR'] : [],
      errorCount: errors,
    };
  }
  if (blocked) return { status: 'blocked', errorCodes: ['SITEMAP_ACCESS_BLOCKED'], errorCount: 1 };
  if (errors > 0) return { status: 'error', errorCodes: ['SITEMAP_FETCH_ERROR'], errorCount: errors };
  return { status: 'absent', errorCodes: [], errorCount: 0 };
}

function technicalErrorFamily(
  seed: SeedDiscoveryResult,
  url: string,
): 'external_script_url_token' | 'json_config_url_token' | null {
  const source = seed.observedTechnicalSources.find(item => item.url === url);
  if (!source) return null;
  if (source.resourceType === 'script' || /\.(?:m?js|cjs)(?:$|[?#])/i.test(url)) {
    return 'external_script_url_token';
  }
  return 'json_config_url_token';
}

function buildCoverage(
  candidates: readonly RawUrlCandidate[],
  urlMap: readonly UrlMapEntry[],
  seed: SeedDiscoveryResult,
  sitemap: SitemapDiscoveryResult,
  discoveryDurationMs: number,
): UrlSourceCoverageRecord[] {
  const sitemapStatus = sourceCoverageStatusForSitemaps(sitemap);
  const technicalErrors = seed.technicalSourceErrors;
  const rows: UrlSourceCoverageRecord[] = [];

  for (const { family, extractorId } of SEED_FAMILIES) {
    const familyCandidates = candidates.filter(candidate => candidate.provenance.sourceFamily === family);
    const familyResolved = urlMap.filter(item => item.provenance.some(prov => prov.sourceFamily === family));

    if (family === 'sitemap_page_url') {
      rows.push({
        extractorId,
        sourceFamily: family,
        status: sitemapStatus.status,
        candidateCount: familyCandidates.length,
        resolvedCount: familyResolved.length,
        errorCount: sitemapStatus.errorCount,
        durationMs: discoveryDurationMs,
        errorCodes: sitemapStatus.errorCodes,
      });
      continue;
    }

    const isTechnicalTokenFamily = family === 'external_script_url_token' || family === 'json_config_url_token';
    const relatedTechnicalErrors = isTechnicalTokenFamily
      ? technicalErrors.filter(error => technicalErrorFamily(seed, error.url) === family)
      : [];

    rows.push({
      extractorId,
      sourceFamily: family,
      status: relatedTechnicalErrors.length > 0 ? 'error' : familyCandidates.length > 0 ? 'complete' : 'absent',
      candidateCount: familyCandidates.length,
      resolvedCount: familyResolved.length,
      errorCount: relatedTechnicalErrors.length,
      durationMs: discoveryDurationMs,
      errorCodes: [...new Set(relatedTechnicalErrors.map(error => error.code))],
    });
  }

  return rows;
}

export async function discoverFullUrlMap(
  page: PageLike,
  entryUrl: string,
  options: FullUrlMapDiscoveryOptions = {},
): Promise<FullUrlMapDiscoveryResult> {
  const startedAt = now();
  const startedMs = Date.now();

  const seed = await discoverFromSeedWithoutCrawl(page, entryUrl, options);
  const fallbackPaths = options.fallbackSitemapPaths ?? DEFAULT_FALLBACK_SITEMAP_PATHS;
  const sitemapSeed = makeSitemapSeed(entryUrl, seed, fallbackPaths);
  const sitemap = await discoverSitemaps(page.request, entryUrl, sitemapSeed, {
    requestTimeoutMs: options.sitemapRequestTimeoutMs,
    maxRedirects: options.sitemapMaxRedirects,
    maxSitemapFiles: options.sitemapMaxFiles,
    maxPageUrls: options.sitemapMaxPageUrls,
  });

  const rawCandidates = dedupeRawCandidates([
    ...seed.rawCandidates,
    ...sitemapRawCandidates(sitemap, entryUrl),
  ]);
  const urlMap = resolveAndDedupeUrlMap(rawCandidates);
  const resolvedObservationCount = rawCandidates.filter(candidate => resolveRaw(candidate) !== null).length;
  const unresolvedCandidates = rawCandidates.length - resolvedObservationCount;
  const finishedAt = now();
  const sourceCoverage = buildCoverage(rawCandidates, urlMap, seed, sitemap, Date.now() - startedMs);
  const runId = randomUUID();

  const summary: UrlMapDiscoverySummary = {
    runId,
    startedAt,
    finishedAt,
    entryUrl,
    finalEntryUrl: seed.finalEntryUrl,
    allowedHosts: seed.allowedHosts,
    counts: {
      rawCandidates: rawCandidates.length,
      resolvedUrls: urlMap.length,
      unresolvedCandidates,
      observedTechnicalSources: seed.observedTechnicalSources.length,
      technicalSourceErrors: seed.technicalSourceErrors.length,
      sitemapPageUrls: sitemap.status === 'found' ? sitemap.page_urls.length : 0,
      sitemapAttempts: sitemap.attempts.length,
    },
    sourceCoverage,
  };

  return {
    runId,
    startedAt,
    finishedAt,
    entryUrl,
    finalEntryUrl: seed.finalEntryUrl,
    allowedHosts: seed.allowedHosts,
    rawCandidates,
    urlMap,
    sourceCoverage,
    seedDiscovery: seed,
    sitemapDiscovery: sitemap,
    summary,
  };
}

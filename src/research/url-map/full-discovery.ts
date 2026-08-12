import { randomUUID } from 'node:crypto';

import {
  discoverSitemaps,
  looksLikeSitemapReference,
  type SeedObservation,
  type SitemapDiscoveryResult,
} from '../sitemap-discovery.ts';
import {
  discoverFromSeedWithoutCrawl,
  SeedAccessBlockedError,
  type SeedDiscoveryOptions,
} from './seed-discovery.ts';
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

export interface UrlMapEntry {
  canonicalUrl: string;
  navigationUrl: string;
  provenance: CandidateProvenance[];
}

export type FrozenSeedStatus = 'complete' | 'blocked' | 'error';

export interface FrozenSeedAttempt {
  seedUrl: string;
  status: FrozenSeedStatus;
  finalUrl: string | null;
  rawCandidateCount: number;
  observedTechnicalSourceCount: number;
  errorCode: string | null;
  errorReason: string | null;
  accessGateKind: string | null;
  evidence: string[];
}

export interface UrlMapDiscoverySummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  frozenSeedUrls: string[];
  seedAttempts: FrozenSeedAttempt[];
  discoveryStatus: 'ok' | 'partial' | 'blocked';
  counts: {
    frozenSeeds: number;
    completedSeeds: number;
    blockedSeeds: number;
    erroredSeeds: number;
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
  frozenSeedUrls: string[];
  seedAttempts: FrozenSeedAttempt[];
  rawCandidates: RawUrlCandidate[];
  urlMap: UrlMapEntry[];
  sourceCoverage: UrlSourceCoverageRecord[];
  seedDiscovery: SeedDiscoveryResult;
  sitemapDiscovery: SitemapDiscoveryResult;
  summary: UrlMapDiscoverySummary;
}

export interface FullUrlMapDiscoveryOptions extends SeedDiscoveryOptions {
  /** Explicit finite seeds. Discovered URLs are never appended to this list. */
  seedUrls?: string[];
  /** Convert every --allow-host value to one root seed before discovery starts. */
  seedAllowedHostRoots?: boolean;
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

function normaliseSeedUrl(value: string, baseUrl: string): string {
  const url = new URL(value, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Seed URL must be HTTP(S): ${value}`);
  url.hash = '';
  return url.toString();
}

/**
 * Builds the complete navigation seed set before any discovery scan starts.
 * The returned array is frozen conceptually: callers must not enqueue URLs found by scanners.
 */
export function buildFrozenSeedUrls(
  entryUrl: string,
  options: Pick<FullUrlMapDiscoveryOptions, 'seedUrls' | 'allowedHosts' | 'seedAllowedHostRoots'> = {},
): string[] {
  const entry = new URL(entryUrl);
  const values: string[] = [entry.toString()];

  for (const seed of options.seedUrls ?? []) values.push(normaliseSeedUrl(seed, entryUrl));

  if (options.seedAllowedHostRoots) {
    for (const rawHost of options.allowedHosts ?? []) {
      const host = rawHost.trim();
      if (!host) continue;
      values.push(new URL(`${entry.protocol}//${host}/`).toString());
    }
  }

  return [...new Set(values)];
}

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

/** Resolve + canonicalise + deduplicate without route/relevance filtering. */
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
  if (source.resourceType === 'script' || /\.(?:m?js|cjs)(?:$|[?#])/i.test(url)) return 'external_script_url_token';
  return 'json_config_url_token';
}

function buildCoverage(
  candidates: readonly RawUrlCandidate[],
  urlMap: readonly UrlMapEntry[],
  seed: SeedDiscoveryResult,
  sitemap: SitemapDiscoveryResult,
  seedAttempts: readonly FrozenSeedAttempt[],
  discoveryDurationMs: number,
): UrlSourceCoverageRecord[] {
  const sitemapStatus = sourceCoverageStatusForSitemaps(sitemap);
  const technicalErrors = seed.technicalSourceErrors;
  const rows: UrlSourceCoverageRecord[] = [];

  const blockedSeeds = seedAttempts.filter(item => item.status === 'blocked');
  const erroredSeeds = seedAttempts.filter(item => item.status === 'error');
  rows.push({
    extractorId: 'FROZEN_SEED_ACCESS_V1',
    sourceFamily: 'seed_access',
    status: blockedSeeds.length === seedAttempts.length && seedAttempts.length > 0
      ? 'blocked'
      : erroredSeeds.length > 0 || blockedSeeds.length > 0
        ? 'error'
        : 'complete',
    candidateCount: seedAttempts.length,
    resolvedCount: seedAttempts.filter(item => item.status === 'complete').length,
    errorCount: blockedSeeds.length + erroredSeeds.length,
    durationMs: discoveryDurationMs,
    errorCodes: [
      ...(blockedSeeds.length > 0 ? ['SEED_ACCESS_BLOCKED'] : []),
      ...(erroredSeeds.length > 0 ? ['SEED_DISCOVERY_ERROR'] : []),
    ],
  });

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

function mergeSeedResults(entryUrl: string, results: readonly SeedDiscoveryResult[], allowedHosts: readonly string[]): SeedDiscoveryResult {
  const primary = results.find(item => item.entryUrl === entryUrl) ?? results[0];
  const observedTechnicalSources = new Map<string, SeedDiscoveryResult['observedTechnicalSources'][number]>();
  for (const result of results) {
    for (const item of result.observedTechnicalSources) observedTechnicalSources.set(item.url, item);
  }
  return {
    entryUrl,
    finalEntryUrl: primary?.finalEntryUrl ?? entryUrl,
    allowedHosts: [...new Set(allowedHosts.map(host => host.toLowerCase()))],
    rawCandidates: dedupeRawCandidates(results.flatMap(item => item.rawCandidates)),
    observedTechnicalSources: [...observedTechnicalSources.values()],
    technicalSourceErrors: results.flatMap(item => item.technicalSourceErrors),
  };
}

export async function discoverFullUrlMap(
  page: PageLike,
  entryUrl: string,
  options: FullUrlMapDiscoveryOptions = {},
): Promise<FullUrlMapDiscoveryResult> {
  const startedAt = now();
  const startedMs = Date.now();
  const frozenSeedUrls = buildFrozenSeedUrls(entryUrl, options);
  const seedAttempts: FrozenSeedAttempt[] = [];
  const successfulSeeds: SeedDiscoveryResult[] = [];

  // Finite pass only. No discovered URL is ever appended to frozenSeedUrls.
  for (const seedUrl of frozenSeedUrls) {
    try {
      const result = await discoverFromSeedWithoutCrawl(page, seedUrl, options);
      successfulSeeds.push(result);
      seedAttempts.push({
        seedUrl,
        status: 'complete',
        finalUrl: result.finalEntryUrl,
        rawCandidateCount: result.rawCandidates.length,
        observedTechnicalSourceCount: result.observedTechnicalSources.length,
        errorCode: null,
        errorReason: null,
        accessGateKind: null,
        evidence: [],
      });
    } catch (error) {
      if (error instanceof SeedAccessBlockedError) {
        seedAttempts.push({
          seedUrl,
          status: 'blocked',
          finalUrl: error.finalUrl,
          rawCandidateCount: 0,
          observedTechnicalSourceCount: 0,
          errorCode: error.code,
          errorReason: error.message,
          accessGateKind: error.kind,
          evidence: error.evidence,
        });
        continue;
      }
      seedAttempts.push({
        seedUrl,
        status: 'error',
        finalUrl: page.url() || null,
        rawCandidateCount: 0,
        observedTechnicalSourceCount: 0,
        errorCode: 'SEED_DISCOVERY_ERROR',
        errorReason: error instanceof Error ? error.message : String(error),
        accessGateKind: null,
        evidence: [],
      });
    }
  }

  const seedHostnames = frozenSeedUrls.map(url => new URL(url).hostname);
  const mergedAllowedHosts = [...new Set([
    new URL(entryUrl).hostname,
    ...(options.allowedHosts ?? []),
    ...seedHostnames,
  ].map(host => host.toLowerCase()))];
  const seed = mergeSeedResults(entryUrl, successfulSeeds, mergedAllowedHosts);

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
  const sourceCoverage = buildCoverage(rawCandidates, urlMap, seed, sitemap, seedAttempts, Date.now() - startedMs);
  const runId = randomUUID();
  const completedSeeds = seedAttempts.filter(item => item.status === 'complete').length;
  const blockedSeeds = seedAttempts.filter(item => item.status === 'blocked').length;
  const erroredSeeds = seedAttempts.filter(item => item.status === 'error').length;
  const discoveryStatus: UrlMapDiscoverySummary['discoveryStatus'] = completedSeeds === 0 && blockedSeeds > 0 && erroredSeeds === 0
    ? 'blocked'
    : blockedSeeds > 0 || erroredSeeds > 0
      ? 'partial'
      : 'ok';

  const summary: UrlMapDiscoverySummary = {
    runId,
    startedAt,
    finishedAt,
    entryUrl,
    finalEntryUrl: seed.finalEntryUrl,
    allowedHosts: seed.allowedHosts,
    frozenSeedUrls,
    seedAttempts,
    discoveryStatus,
    counts: {
      frozenSeeds: frozenSeedUrls.length,
      completedSeeds,
      blockedSeeds,
      erroredSeeds,
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
    frozenSeedUrls,
    seedAttempts,
    rawCandidates,
    urlMap,
    sourceCoverage,
    seedDiscovery: seed,
    sitemapDiscovery: sitemap,
    summary,
  };
}

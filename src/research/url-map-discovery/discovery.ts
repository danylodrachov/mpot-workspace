import type { CandidateProvenance, DiscoveryResult, PageLike, RawUrlCandidate, RequestLike, ResponseLike, SourceFamily, UrlDecision } from './types.ts';
import { decideDocumentUrl, isTechnicalSourceUrl } from './policy.ts';
import { buildAcceptedVisitFrontier } from './frontier.ts';
import { SourceCoverageTracker } from './source-coverage.ts';
import { extractPageCandidates, installHistoryInstrumentation } from './page-extractors.ts';
import { discoverSitemaps } from './sitemap-discovery.ts';
import { scanTechnicalSources } from './technical-source-scan.ts';

function now(): string { return new Date().toISOString(); }
function addCandidate(store: RawUrlCandidate[], rawUrl: string, baseUrl: string, sourceFamily: SourceFamily, extra: Partial<CandidateProvenance> = {}): void {
  store.push({ rawUrl, baseUrl, provenance: { sourceFamily, discoveredOn: extra.discoveredOn ?? baseUrl, ...extra }, observedAt: now() });
}

function groupDecisions(rawCandidates: readonly RawUrlCandidate[], allowedHosts: ReadonlySet<string>): UrlDecision[] {
  const groups = new Map<string, { rawUrl: string; baseUrl: string; provenance: CandidateProvenance[] }>();
  for (const c of rawCandidates) {
    let key: string;
    try { key = new URL(c.rawUrl, c.baseUrl).toString(); } catch { key = `${c.baseUrl}::${c.rawUrl}`; }
    const current = groups.get(key);
    if (current) current.provenance.push(c.provenance);
    else groups.set(key, { rawUrl: c.rawUrl, baseUrl: c.baseUrl, provenance: [c.provenance] });
  }
  return [...groups.values()].map(g => decideDocumentUrl(g.rawUrl, g.baseUrl, allowedHosts, g.provenance));
}

function shouldScanTechnicalSource(url: string, resourceType?: string, label?: string): boolean {
  if (resourceType && ['script', 'xhr', 'fetch'].includes(resourceType)) return true;
  if (label && ['script', 'modulepreload', 'manifest'].includes(label.toLowerCase())) return true;
  try {
    const parsed = new URL(url);
    return /\.(?:m?js|cjs|json|xml|txt)(?:$|[?#])/i.test(parsed.pathname) || /(?:^|\/)(?:api|graphql)(?:\/|$)/i.test(parsed.pathname);
  } catch { return false; }
}

export interface DiscoverOptions {
  allowedHosts?: string[];
  navigationTimeoutMs?: number;
  settleMs?: number;
  sourceFetchTimeoutMs?: number;
  maxTechnicalSources?: number;
}

/**
 * Deterministic URL-map discovery only. It intentionally does NOT recursively navigate
 * arbitrary discovered candidates. The output accepted inventory is frozen for the
 * later page-collection stage.
 */
export async function discoverUrlMap(page: PageLike, entryUrl: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const startedAt = now();
  const entry = new URL(entryUrl);
  const allowedHosts = new Set([entry.hostname, ...(options.allowedHosts ?? [])].map(h => h.toLowerCase()));
  const rawCandidates: RawUrlCandidate[] = [];
  const technicalSourceUrls = new Set<string>();
  const coverage = new SourceCoverageTracker();
  const context = page.context();

  addCandidate(rawCandidates, entryUrl, entryUrl, 'entry_url', { discoveredOn: entryUrl, sourceUrl: entryUrl });
  coverage.set('entry_url', 'complete', 1);

  await installHistoryInstrumentation(page);

  const networkDocuments: RawUrlCandidate[] = [];
  const networkSources: RawUrlCandidate[] = [];
  const onRequest = (request: RequestLike) => {
    const url = request.url();
    const type = request.resourceType();
    if (type === 'document') {
      addCandidate(networkDocuments, url, page.url() || entryUrl, 'network_document', { discoveredOn: page.url() || entryUrl, sourceUrl: url, resourceType: type });
    } else {
      addCandidate(networkSources, url, page.url() || entryUrl, 'network_source_url', { discoveredOn: page.url() || entryUrl, sourceUrl: url, resourceType: type });
      if (shouldScanTechnicalSource(url, type)) technicalSourceUrls.add(url);
    }
  };
  const onResponse = (_response: ResponseLike) => { /* URL already captured at request time; body is never read here. */ };
  context.on('request', onRequest);
  context.on('response', onResponse);

  try {
  const navResponse = await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs ?? 20_000 });
  const finalEntryUrl = page.url();
  if (navResponse && navResponse.status() >= 400) {
    coverage.set('network_document', 'error', networkDocuments.length, { errorCode: 'ENTRY_HTTP_ERROR', errorMessage: `Entry navigation returned HTTP ${navResponse.status()}.` });
  }
  await page.waitForTimeout(options.settleMs ?? 1200);

  rawCandidates.push(...networkDocuments, ...networkSources);
  coverage.set('network_document', networkDocuments.length ? 'complete' : 'absent', networkDocuments.length);
  coverage.set('network_source_url', networkSources.length ? 'complete' : 'absent', networkSources.length);

  const pageCandidates = await extractPageCandidates(page);
  rawCandidates.push(...pageCandidates);
  for (const family of ['dom_url_attribute', 'document_metadata', 'frame_form_url', 'performance_resource', 'inline_script_url_token', 'history_route'] as const) {
    const count = pageCandidates.filter(c => c.provenance.sourceFamily === family).length;
    coverage.set(family, count ? 'complete' : 'absent', count);
  }
  for (const c of pageCandidates) {
    if (['performance_resource', 'document_metadata', 'dom_url_attribute'].includes(c.provenance.sourceFamily)) {
      try {
        const resolved = new URL(c.rawUrl, c.baseUrl).toString();
        if (isTechnicalSourceUrl(resolved, entryUrl, allowedHosts) && shouldScanTechnicalSource(resolved, c.provenance.resourceType, c.provenance.label)) technicalSourceUrls.add(resolved);
      } catch {}
    }
  }

  const sitemap = await discoverSitemaps(context.request, finalEntryUrl || entryUrl, allowedHosts, options.sourceFetchTimeoutMs ?? 6000);
  rawCandidates.push(...sitemap.candidates);
  for (const record of sitemap.coverage) coverage.set(record.sourceFamily, record.status, record.candidateCount, record);

  const scan = await scanTechnicalSources(context.request, [...technicalSourceUrls], finalEntryUrl || entryUrl, allowedHosts, options.sourceFetchTimeoutMs ?? 6000, options.maxTechnicalSources ?? 120);
  rawCandidates.push(...scan.candidates);
  const scriptCount = scan.candidates.filter(c => c.provenance.sourceFamily === 'external_script_url_token').length;
  const jsonCount = scan.candidates.filter(c => c.provenance.sourceFamily === 'json_config_url_token').length;
  coverage.set('external_script_url_token', scan.errors.length ? 'error' : scriptCount ? 'complete' : 'absent', scriptCount, scan.errors.length ? { errorCode: 'TECHNICAL_SOURCE_SCAN_PARTIAL', errorMessage: `${scan.errors.length} technical source(s) failed explicit re-fetch/scan.` } : {});
  coverage.set('json_config_url_token', scan.errors.length && !jsonCount ? 'error' : jsonCount ? 'complete' : 'absent', jsonCount, scan.errors.length && !jsonCount ? { errorCode: 'TECHNICAL_SOURCE_SCAN_PARTIAL', errorMessage: `${scan.errors.length} technical source(s) failed explicit re-fetch/scan.` } : {});

  const decisions = groupDecisions(rawCandidates, allowedHosts);
  const accepted = buildAcceptedVisitFrontier(decisions);
  const acceptedKeys = new Set(accepted.map(d => d.canonicalUrl));
  const rejected = decisions.filter(d => d.decision === 'rejected');
  const tbd = decisions.filter(d => d.decision === 'tbd');

  // The accepted array is frozen by canonical route identity. No recursive fallback exists.
  return {
    entryUrl,
    finalEntryUrl,
    allowedHosts: [...allowedHosts],
    rawCandidates,
    sourceCoverage: coverage.finalize(),
    decisions,
    accepted: [...accepted].filter(d => acceptedKeys.has(d.canonicalUrl)),
    rejected,
    tbd,
    technicalSourceUrls: [...technicalSourceUrls].sort(),
    startedAt,
    finishedAt: now(),
  };
  } finally {
    context.off?.('request', onRequest);
    context.off?.('response', onResponse);
  }
}

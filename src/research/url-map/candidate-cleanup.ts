import type { CandidateProvenance, RawUrlCandidate, SourceFamily } from './types.ts';
import { checkResolvedNavigationUrl } from './navigation-url.ts';

export type CandidateDisposition = 'document' | 'technical' | 'resource' | 'external' | 'invalid';

export interface CandidateCleanupDecision {
  candidate: RawUrlCandidate;
  resolvedUrl: string | null;
  disposition: CandidateDisposition;
  reasonCode: string;
}

export interface CleanUrlMapEntry {
  canonicalUrl: string;
  navigationUrl: string;
  provenance: CandidateProvenance[];
}

const DIRECT_DOCUMENT_FAMILIES = new Set<SourceFamily>([
  'entry_url',
  'dom_navigation_url',
  'network_document',
  'history_route',
  'sitemap_page_url',
]);

const SCRIPT_ROUTE_FAMILIES = new Set<SourceFamily>([
  'inline_script_url_token',
  'external_script_url_token',
  'json_config_url_token',
]);

const TECHNICAL_FAMILIES = new Set<SourceFamily>([
  'network_source_url',
  'performance_resource',
]);

function metadataIsDocumentLink(label: string): boolean {
  return /link\[rel=(?:canonical|alternate|next|prev)\]/i.test(label) ||
    /meta\[(?:og:url|refresh|url|canonical|alternate)\]/i.test(label);
}

function domAttributeIsNavigation(label: string): boolean {
  return /^(?:a|area)\[href\]$/i.test(label);
}

function resolveRaw(candidate: RawUrlCandidate): URL | null {
  try {
    const url = new URL(candidate.rawUrl, candidate.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function classifyCandidateForNavigation(
  candidate: RawUrlCandidate,
  allowedHosts: ReadonlySet<string>,
): CandidateCleanupDecision {
  const resolved = resolveRaw(candidate);
  if (!resolved) {
    return { candidate, resolvedUrl: null, disposition: 'invalid', reasonCode: 'INVALID_HTTP_URL' };
  }

  const host = resolved.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    return { candidate, resolvedUrl: resolved.toString(), disposition: 'external', reasonCode: 'EXTERNAL_HOST' };
  }

  const family = candidate.provenance.sourceFamily;
  const label = candidate.provenance.label ?? '';

  if (TECHNICAL_FAMILIES.has(family)) {
    return { candidate, resolvedUrl: resolved.toString(), disposition: 'technical', reasonCode: 'TECHNICAL_SOURCE_FAMILY' };
  }

  if (family === 'dom_url_attribute' && !domAttributeIsNavigation(label)) {
    return { candidate, resolvedUrl: resolved.toString(), disposition: 'resource', reasonCode: 'DOM_NON_NAVIGATION_ATTRIBUTE' };
  }

  if (family === 'document_metadata' && !metadataIsDocumentLink(label)) {
    return { candidate, resolvedUrl: resolved.toString(), disposition: 'resource', reasonCode: 'NON_NAVIGATION_METADATA' };
  }

  const strictScriptSyntax = SCRIPT_ROUTE_FAMILIES.has(family);
  const check = checkResolvedNavigationUrl(resolved, {
    allowedHosts,
    strictScriptSyntax,
    rejectTechnicalPaths: strictScriptSyntax,
    rejectApiPaths: strictScriptSyntax,
  });
  if (!check.ok) {
    const resourceReasons = new Set(['resource_file', 'source_code_file', 'technical_path', 'api_path']);
    return {
      candidate,
      resolvedUrl: check.url,
      disposition: resourceReasons.has(check.reason ?? '') ? 'resource' : 'invalid',
      reasonCode: `URL_${String(check.reason ?? 'INVALID').toUpperCase()}`,
    };
  }

  if (SCRIPT_ROUTE_FAMILIES.has(family)) {
    // Generic script/config string extraction is discovery evidence, not proof that the
    // string is a browser page. It can corroborate a URL found by a document source but
    // cannot create a navigation target on its own.
    return { candidate, resolvedUrl: check.url, disposition: 'technical', reasonCode: 'SCRIPT_ROUTE_HINT_ONLY' };
  }

  if (
    DIRECT_DOCUMENT_FAMILIES.has(family) ||
    (family === 'dom_url_attribute' && domAttributeIsNavigation(label)) ||
    (family === 'document_metadata' && metadataIsDocumentLink(label))
  ) {
    return { candidate, resolvedUrl: check.url, disposition: 'document', reasonCode: 'DOCUMENT_CANDIDATE' };
  }

  return { candidate, resolvedUrl: check.url, disposition: 'technical', reasonCode: 'NON_DOCUMENT_SOURCE_FAMILY' };
}

function addUniqueProvenance(target: CandidateProvenance[], value: CandidateProvenance): void {
  const key = JSON.stringify(value);
  if (!target.some(item => JSON.stringify(item) === key)) target.push(value);
}

/**
 * Builds the navigation map only from document-shaped candidates.
 * Raw discovery observations remain untouched in source-url-list.json.
 */
export function buildCleanDocumentUrlMap(
  rawCandidates: readonly RawUrlCandidate[],
  allowedHosts: ReadonlySet<string>,
): CleanUrlMapEntry[] {
  const byCanonical = new Map<string, CleanUrlMapEntry>();
  const decisions = rawCandidates.map(candidate => classifyCandidateForNavigation(candidate, allowedHosts));

  // Pass 1: only browser/document evidence is allowed to create a navigation target.
  for (const decision of decisions) {
    if (decision.disposition !== 'document' || !decision.resolvedUrl) continue;
    const canonicalUrl = decision.resolvedUrl;
    const existing = byCanonical.get(canonicalUrl);
    if (existing) {
      addUniqueProvenance(existing.provenance, decision.candidate.provenance);
      continue;
    }
    byCanonical.set(canonicalUrl, {
      canonicalUrl,
      navigationUrl: canonicalUrl,
      provenance: [decision.candidate.provenance],
    });
  }

  // Pass 2: script/config route hints may corroborate an already-proven document URL,
  // but they cannot create one. This keeps provenance without promoting API/code noise.
  for (const decision of decisions) {
    if (decision.reasonCode !== 'SCRIPT_ROUTE_HINT_ONLY' || !decision.resolvedUrl) continue;
    const existing = byCanonical.get(decision.resolvedUrl);
    if (existing) addUniqueProvenance(existing.provenance, decision.candidate.provenance);
  }

  return [...byCanonical.values()].sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
}

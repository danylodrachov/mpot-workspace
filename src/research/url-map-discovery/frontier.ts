import type { UrlDecision } from './types.ts';

/**
 * The visit frontier is deliberately closed: only deterministic URL-rule accepts
 * are eligible. Technical/TBD/rejected observations can never become page visits.
 */
export function buildAcceptedVisitFrontier(decisions: readonly UrlDecision[]): UrlDecision[] {
  const byCanonical = new Map<string, UrlDecision>();
  for (const item of decisions) {
    if (item.decision !== 'accepted' || !item.canonicalUrl) continue;
    const existing = byCanonical.get(item.canonicalUrl);
    if (!existing) {
      byCanonical.set(item.canonicalUrl, { ...item, provenance: [...item.provenance] });
      continue;
    }
    const seen = new Set(existing.provenance.map(p => JSON.stringify(p)));
    for (const p of item.provenance) {
      const key = JSON.stringify(p);
      if (!seen.has(key)) { existing.provenance.push(p); seen.add(key); }
    }
  }
  return [...byCanonical.values()].sort((a, b) => a.canonicalUrl!.localeCompare(b.canonicalUrl!));
}

export type RecursiveMode = 'fallback' | 'never' | 'always';

export interface RecursiveDecision {
  run: boolean;
  reason?: 'NO_USABLE_SITEMAP_URLS' | 'EXPLICIT_RECURSIVE_MODE';
}

export function decideRecursiveTraversal(mode: RecursiveMode, usableSitemapUrlCount: number): RecursiveDecision {
  if (mode === 'always') return { run: true, reason: 'EXPLICIT_RECURSIVE_MODE' };
  if (mode === 'fallback' && usableSitemapUrlCount === 0) {
    return { run: true, reason: 'NO_USABLE_SITEMAP_URLS' };
  }
  return { run: false };
}

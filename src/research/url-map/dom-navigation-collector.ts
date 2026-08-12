import type { PageLike, RawUrlCandidate } from './types.ts';

export interface StableDomNavigationOptions {
  maxWaitMs?: number;
  sampleIntervalMs?: number;
  minObservationMs?: number;
  stableSamples?: number;
}

interface DomNavigationObservation {
  value: string;
  label: 'a[href]' | 'area[href]';
}

async function readNavigationLinks(page: Pick<PageLike, 'evaluate'>): Promise<DomNavigationObservation[]> {
  return page.evaluate(() => {
    const out: Array<{ value: string; label: 'a[href]' | 'area[href]' }> = [];
    for (const element of Array.from(document.querySelectorAll('a[href], area[href]'))) {
      const value = element.getAttribute('href')?.trim();
      if (!value) continue;
      out.push({
        value,
        label: element.tagName.toLowerCase() === 'area' ? 'area[href]' : 'a[href]',
      });
    }
    return out;
  });
}

/**
 * Passive hydration-aware link collection. No clicks, scrolls, fills, or route activation.
 * Zero links never counts as "stable"; the collector waits to its bounded timeout so a SPA
 * that renders navigation after async bootstrap is not mistaken for a linkless page.
 */
export async function collectStableDomNavigationCandidates(
  page: Pick<PageLike, 'evaluate' | 'waitForTimeout'>,
  baseUrl: string,
  options: StableDomNavigationOptions = {},
): Promise<RawUrlCandidate[]> {
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? 4_000);
  const sampleIntervalMs = Math.max(50, options.sampleIntervalMs ?? 250);
  const minObservationMs = Math.min(maxWaitMs, Math.max(0, options.minObservationMs ?? 1_000));
  const stableSamples = Math.max(1, options.stableSamples ?? 2);
  const started = Date.now();
  const merged = new Map<string, DomNavigationObservation>();
  let unchangedSamples = 0;
  let previousFingerprint = '';

  for (;;) {
    const observations = await readNavigationLinks(page);
    for (const item of observations) merged.set(`${item.label}\u0000${item.value}`, item);

    const fingerprint = [...merged.keys()].sort().join('\u0001');
    if (fingerprint && fingerprint === previousFingerprint) unchangedSamples += 1;
    else unchangedSamples = 0;
    previousFingerprint = fingerprint;

    const elapsed = Date.now() - started;
    if (merged.size > 0 && elapsed >= minObservationMs && unchangedSamples >= stableSamples) break;
    if (elapsed >= maxWaitMs) break;
    await page.waitForTimeout(Math.min(sampleIntervalMs, Math.max(0, maxWaitMs - elapsed)));
  }

  const observedAt = new Date().toISOString();
  return [...merged.values()].map(item => ({
    rawUrl: item.value,
    baseUrl,
    provenance: {
      sourceFamily: 'dom_navigation_url',
      discoveredOn: baseUrl,
      label: item.label,
    },
    observedAt,
  }));
}

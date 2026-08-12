import type {
  CandidateProvenance,
  ObservedTechnicalSource,
  PageLike,
  RawUrlCandidate,
  RequestLike,
  SeedDiscoveryResult,
  SourceFamily,
} from './types.ts';
import { extractUrlLikeTokens, resolveCasinoRouteToken } from './token-extractor.ts';
import {
  scanObservedTechnicalSources,
  shouldScanObservedTechnicalSource,
} from './technical-source-scan.ts';

export interface SeedDiscoveryOptions {
  allowedHosts?: string[];
  navigationTimeoutMs?: number;
  settleMs?: number;
  technicalSourceTimeoutMs?: number;
  maxTechnicalSources?: number;
  maxTechnicalSourceBodyBytes?: number;
}

export type SeedAccessGateKind = 'cloudflare_challenge';

export interface SeedAccessGateSignals {
  title?: string | null;
  bodyText?: string | null;
  matchedSelectors?: string[];
  currentUrl?: string | null;
}

export interface SeedAccessGateMatch {
  kind: SeedAccessGateKind;
  evidence: string[];
}

export class SeedAccessBlockedError extends Error {
  readonly code = 'SEED_ACCESS_BLOCKED';
  readonly kind: SeedAccessGateKind;
  readonly seedUrl: string;
  readonly finalUrl: string;
  readonly evidence: string[];

  constructor(seedUrl: string, finalUrl: string, match: SeedAccessGateMatch) {
    super(`Seed access blocked by ${match.kind}: ${seedUrl}`);
    this.name = 'SeedAccessBlockedError';
    this.kind = match.kind;
    this.seedUrl = seedUrl;
    this.finalUrl = finalUrl;
    this.evidence = match.evidence;
  }
}

export function classifySeedAccessGate(signals: SeedAccessGateSignals): SeedAccessGateMatch | null {
  const title = (signals.title ?? '').trim();
  const body = (signals.bodyText ?? '').trim();
  const currentUrl = signals.currentUrl ?? '';
  const selectors = signals.matchedSelectors ?? [];
  const evidence: string[] = [];
  let hardSignal = false;

  if (/\/cdn-cgi\/challenge-platform\//i.test(currentUrl)) {
    evidence.push('url:/cdn-cgi/challenge-platform/');
    hardSignal = true;
  }
  for (const selector of selectors) {
    evidence.push(`selector:${selector}`);
    hardSignal = true;
  }
  if (/^just a moment\.?$/i.test(title)) {
    evidence.push('title:Just a moment');
    hardSignal = true;
  }
  if (/cloudflare/i.test(body) && /checking (?:your )?browser/i.test(body)) {
    evidence.push('text:Cloudflare browser check');
    hardSignal = true;
  }
  if (/cloudflare/i.test(body) && /performing security verification/i.test(body)) {
    evidence.push('text:Cloudflare security verification');
    hardSignal = true;
  }

  return hardSignal ? { kind: 'cloudflare_challenge', evidence: [...new Set(evidence)] } : null;
}

async function detectSeedAccessGate(page: PageLike): Promise<SeedAccessGateMatch | null> {
  const raw = await page.evaluate(() => {
    const selectors = [
      '#cf-challenge-running',
      '#challenge-running',
      '#challenge-form',
      'iframe[src*="challenges.cloudflare.com"]',
    ];
    const matchedSelectors = selectors.filter(selector => document.querySelector(selector));
    return {
      title: document.title ?? '',
      bodyText: (document.body?.innerText ?? '').slice(0, 20_000),
      matchedSelectors,
      currentUrl: location.href,
    };
  });

  const signals = raw && typeof raw === 'object' ? raw as SeedAccessGateSignals : {};
  return classifySeedAccessGate(signals);
}

function addCandidate(
  store: RawUrlCandidate[],
  rawUrl: string,
  baseUrl: string,
  sourceFamily: SourceFamily,
  extra: Partial<CandidateProvenance> = {},
): void {
  store.push({
    rawUrl,
    baseUrl,
    provenance: {
      sourceFamily,
      discoveredOn: extra.discoveredOn ?? baseUrl,
      ...extra,
    },
    observedAt: new Date().toISOString(),
  });
}

function dedupeCandidates(candidates: readonly RawUrlCandidate[]): RawUrlCandidate[] {
  const seen = new Set<string>();
  const out: RawUrlCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.rawUrl,
      candidate.baseUrl,
      candidate.provenance.sourceFamily,
      candidate.provenance.sourceUrl ?? '',
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/**
 * Deterministic one-seed-page URL discovery. It does not recursively navigate any
 * discovered document URL. Cross-origin JS/JSON/config resources are scanned only when
 * the seed page itself observed or declared them; extracted navigation candidates are
 * emitted only when they resolve into allowedHosts.
 */
export async function discoverFromSeedWithoutCrawl(
  page: PageLike,
  entryUrl: string,
  options: SeedDiscoveryOptions = {},
): Promise<SeedDiscoveryResult> {
  const entry = new URL(entryUrl);
  const allowedHosts = new Set(
    [entry.hostname, ...(options.allowedHosts ?? [])].map(host => host.toLowerCase()),
  );
  const rawCandidates: RawUrlCandidate[] = [];
  const observedTechnical = new Map<string, ObservedTechnicalSource>();
  addCandidate(rawCandidates, entryUrl, entryUrl, 'entry_url', { sourceUrl: entryUrl });

  await page.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown, name: string) => unknown };
    g.__name = g.__name ?? ((fn: unknown) => fn);
  });
  await page.addInitScript(() => {
    const g = globalThis as unknown as {
      __mpotHistoryRoutes?: string[];
      __mpotHistoryHookInstalled?: boolean;
      history?: {
        pushState?: (...args: unknown[]) => unknown;
        replaceState?: (...args: unknown[]) => unknown;
      };
    };

    g.__mpotHistoryRoutes = g.__mpotHistoryRoutes ?? [];
    if (g.__mpotHistoryHookInstalled) return;
    g.__mpotHistoryHookInstalled = true;

    const history = g.history;
    if (!history) return;
    for (const key of ['pushState', 'replaceState'] as const) {
      const original = history[key];
      if (typeof original !== 'function') continue;
      history[key] = function (...args: unknown[]) {
        const url = args[2];
        if (typeof url === 'string') g.__mpotHistoryRoutes?.push(url);
        return original.apply(this, args);
      };
    }
  });

  const onRequest = (request: RequestLike): void => {
    const url = request.url();
    const resourceType = request.resourceType();
    const currentPageUrl = page.url() || entryUrl;
    if (resourceType === 'document') {
      addCandidate(rawCandidates, url, currentPageUrl, 'network_document', {
        discoveredOn: currentPageUrl,
        sourceUrl: url,
        resourceType,
      });
      return;
    }
    addCandidate(rawCandidates, url, currentPageUrl, 'network_source_url', {
      discoveredOn: currentPageUrl,
      sourceUrl: url,
      resourceType,
    });
    const source: ObservedTechnicalSource = { url, resourceType, discoveredOn: currentPageUrl };
    if (shouldScanObservedTechnicalSource(source)) observedTechnical.set(url, source);
  };

  page.on('request', onRequest);
  try {
    await page.goto(entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs ?? 20_000,
    });
    await page.waitForTimeout(options.settleMs ?? 1_200);

    const finalEntryUrl = page.url() || entryUrl;
    const accessGate = await detectSeedAccessGate(page);
    if (accessGate) throw new SeedAccessBlockedError(entryUrl, finalEntryUrl, accessGate);

    const pageSignals = await page.evaluate(() => {
      const attrs: Array<{ value: string; label: string }> = [];
      const metadata: Array<{ value: string; label: string }> = [];
      const inlineScripts: string[] = [];
      const addAttr = (value: string | null, label: string): void => {
        if (value?.trim()) attrs.push({ value: value.trim(), label });
      };

      for (const element of Array.from(document.querySelectorAll('*'))) {
        for (const name of ['href', 'src', 'action', 'formaction', 'data', 'poster']) {
          addAttr(element.getAttribute(name), `${element.tagName.toLowerCase()}[${name}]`);
        }
        const srcset = element.getAttribute('srcset');
        if (srcset) {
          for (const part of srcset.split(',')) {
            addAttr(part.trim().split(/\s+/)[0] ?? null, `${element.tagName.toLowerCase()}[srcset]`);
          }
        }
      }

      for (const element of Array.from(document.querySelectorAll('link[href], meta[content]'))) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'link') {
          const value = element.getAttribute('href');
          if (value) metadata.push({ value, label: `link[rel=${element.getAttribute('rel') ?? ''}]` });
        } else {
          const property = element.getAttribute('property') ?? element.getAttribute('name') ?? element.getAttribute('http-equiv') ?? '';
          const content = element.getAttribute('content');
          if (content && /url|canonical|alternate|refresh|og:url/i.test(property)) {
            metadata.push({ value: content, label: `meta[${property}]` });
          }
        }
      }

      let inlineBytes = 0;
      for (const script of Array.from(document.scripts)) {
        if (script.src) continue;
        const text = script.textContent ?? '';
        if (!text || inlineBytes >= 5_000_000) continue;
        const slice = text.slice(0, Math.max(0, 5_000_000 - inlineBytes));
        inlineBytes += slice.length;
        inlineScripts.push(slice);
      }

      const performanceUrls = typeof performance !== 'undefined'
        ? performance.getEntriesByType('resource').map(entry => entry.name).filter(Boolean)
        : [];
      const historyRoutes = ((globalThis as unknown as { __mpotHistoryRoutes?: string[] }).__mpotHistoryRoutes ?? []).slice();
      return { attrs, metadata, inlineScripts, performanceUrls, historyRoutes };
    });

    for (const item of pageSignals.attrs) {
      addCandidate(rawCandidates, item.value, finalEntryUrl, 'dom_url_attribute', {
        discoveredOn: finalEntryUrl,
        label: item.label,
      });
      try {
        const resolved = new URL(item.value, finalEntryUrl).toString();
        const source: ObservedTechnicalSource = { url: resolved, discoveredOn: finalEntryUrl };
        if (shouldScanObservedTechnicalSource(source)) observedTechnical.set(resolved, source);
      } catch {
        // Malformed DOM values remain raw observations only.
      }
    }
    for (const item of pageSignals.metadata) {
      addCandidate(rawCandidates, item.value, finalEntryUrl, 'document_metadata', {
        discoveredOn: finalEntryUrl,
        label: item.label,
      });
      try {
        const resolved = new URL(item.value, finalEntryUrl).toString();
        const source: ObservedTechnicalSource = { url: resolved, discoveredOn: finalEntryUrl };
        if (shouldScanObservedTechnicalSource(source)) observedTechnical.set(resolved, source);
      } catch {
        // Malformed metadata values remain raw observations only.
      }
    }
    for (const url of pageSignals.performanceUrls) {
      addCandidate(rawCandidates, url, finalEntryUrl, 'performance_resource', {
        discoveredOn: finalEntryUrl,
        sourceUrl: url,
      });
      const source: ObservedTechnicalSource = { url, discoveredOn: finalEntryUrl };
      if (shouldScanObservedTechnicalSource(source)) observedTechnical.set(url, source);
    }
    for (const route of pageSignals.historyRoutes) {
      addCandidate(rawCandidates, route, finalEntryUrl, 'history_route', { discoveredOn: finalEntryUrl });
    }
    for (const scriptText of pageSignals.inlineScripts) {
      for (const token of extractUrlLikeTokens(scriptText)) {
        const resolved = resolveCasinoRouteToken(token, finalEntryUrl, allowedHosts);
        if (!resolved) continue;
        addCandidate(rawCandidates, resolved, finalEntryUrl, 'inline_script_url_token', {
          discoveredOn: finalEntryUrl,
        });
      }
    }

    const technicalScan = await scanObservedTechnicalSources(
      page.request,
      [...observedTechnical.values()],
      finalEntryUrl,
      allowedHosts,
      {
        timeoutMs: options.technicalSourceTimeoutMs,
        maxSources: options.maxTechnicalSources,
        maxBodyBytes: options.maxTechnicalSourceBodyBytes,
      },
    );
    rawCandidates.push(...technicalScan.candidates);

    return {
      entryUrl,
      finalEntryUrl,
      allowedHosts: [...allowedHosts],
      rawCandidates: dedupeCandidates(rawCandidates),
      observedTechnicalSources: [...observedTechnical.values()],
      technicalSourceErrors: technicalScan.errors,
    };
  } finally {
    page.off?.('request', onRequest);
  }
}

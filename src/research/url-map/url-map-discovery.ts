import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Frame, Page, Request, Response, WebSocket } from 'playwright';

import { decideRecursiveTraversal, type RecursiveMode } from './discovery-policy.ts';
import { discoverRobotsAndSitemaps } from './sitemap-discovery.ts';
import { technicalFilter, normalizeHostname } from './technical-filter.ts';
import { scanUrlTokens } from './token-scan.ts';
import type {
  CandidateProvenance,
  RawUrlObservation,
  SourceFamily,
  TechnicalCandidate,
  TechnicalRejectedCandidate,
  UrlMapRunSummary,
} from './types.ts';

const MAX_TEXT_RESPONSE_BYTES = 12 * 1024 * 1024;
const TEXTUAL_CONTENT = /(?:json|javascript|ecmascript|text\/|xml|svg|manifest)/i;
const CRAWL_SOURCE_FAMILIES = new Set<SourceFamily>([
  'entry_url',
  'redirect_url',
  'sitemap_url',
  'dom_href',
  'document_metadata',
  'form_action',
  'frame_url',
  'data_attribute',
  'inline_event_url',
  'inline_script_url_token',
  'network_body_url_token',
  'history_route',
  'storage_url_token',
  'manifest_url',
]);

export interface UrlMapDiscoveryOptions {
  entryUrl: string;
  outDir: string;
  maxPages?: number; // 0 = no count limit when recursive fallback is active.
  recursiveMode?: RecursiveMode;
  navigationTimeoutMs?: number;
  settleMs?: number;
  manualLogin?: boolean;
  additionalAllowedHosts?: string[];
}

interface CandidateAggregate {
  url: string;
  sourceFamilies: Set<SourceFamily>;
  labels: Set<string>;
  discoveredOn: Set<string>;
  observationCount: number;
}

class CandidateStore {
  readonly observations: RawUrlObservation[] = [];
  readonly sourceErrors: Array<{ sourceFamily: SourceFamily; message: string }> = [];
  readonly sourceCounts = new Map<SourceFamily, number>();
  readonly allowedHosts = new Set<string>();

  constructor(initialHosts: Iterable<string>) {
    for (const host of initialHosts) this.allowedHosts.add(normalizeHostname(host));
  }

  addAllowedHost(host: string): void {
    this.allowedHosts.add(normalizeHostname(host));
  }

  add(rawUrl: string, baseUrl: string, provenance: CandidateProvenance): void {
    if (!rawUrl?.trim()) return;
    this.observations.push({ rawUrl, baseUrl, provenance, observedAt: new Date().toISOString() });
    this.sourceCounts.set(provenance.sourceFamily, (this.sourceCounts.get(provenance.sourceFamily) ?? 0) + 1);
  }

  error(sourceFamily: SourceFamily, message: string): void {
    this.sourceErrors.push({ sourceFamily, message });
  }

  buildTechnical(): { accepted: TechnicalCandidate[]; rejected: TechnicalRejectedCandidate[] } {
    const accepted = new Map<string, CandidateAggregate>();
    const rejected: TechnicalRejectedCandidate[] = [];

    for (const observation of this.observations) {
      // Sitemap documents are discovery inputs, not browser research-page candidates.
      if (observation.provenance.sourceFamily === 'robots_sitemap') {
        rejected.push({
          rawUrl: observation.rawUrl,
          baseUrl: observation.baseUrl,
          reason: 'DISCOVERY_SOURCE_DOCUMENT',
          sourceFamily: observation.provenance.sourceFamily,
          discoveredOn: observation.provenance.discoveredOn,
        });
        continue;
      }

      const decision = technicalFilter(observation.rawUrl, observation.baseUrl, this.allowedHosts);
      if (decision.status === 'rejected') {
        rejected.push({
          rawUrl: observation.rawUrl,
          baseUrl: observation.baseUrl,
          reason: decision.reason!,
          sourceFamily: observation.provenance.sourceFamily,
          discoveredOn: observation.provenance.discoveredOn,
        });
        continue;
      }

      const url = decision.url!;
      let row = accepted.get(url);
      if (!row) {
        row = {
          url,
          sourceFamilies: new Set(),
          labels: new Set(),
          discoveredOn: new Set(),
          observationCount: 0,
        };
        accepted.set(url, row);
      }
      row.sourceFamilies.add(observation.provenance.sourceFamily);
      if (observation.provenance.label) row.labels.add(observation.provenance.label);
      row.discoveredOn.add(observation.provenance.discoveredOn);
      row.observationCount += 1;
    }

    return {
      accepted: [...accepted.values()]
        .map((row) => ({
          url: row.url,
          sourceFamilies: [...row.sourceFamilies].sort(),
          labels: [...row.labels].sort(),
          discoveredOn: [...row.discoveredOn].sort(),
          observationCount: row.observationCount,
        }))
        .sort((a, b) => a.url.localeCompare(b.url)),
      rejected,
    };
  }
}

class CrawlFrontier {
  private readonly queued = new Set<string>();
  private readonly visited = new Set<string>();
  private readonly queue: string[] = [];

  enqueue(rawUrl: string, baseUrl: string, store: CandidateStore, provenance: CandidateProvenance): void {
    if (!CRAWL_SOURCE_FAMILIES.has(provenance.sourceFamily)) return;
    const decision = technicalFilter(rawUrl, baseUrl, store.allowedHosts);
    if (decision.status !== 'accepted' || !decision.url) return;
    if (this.queued.has(decision.url) || this.visited.has(decision.url)) return;
    this.queued.add(decision.url);
    this.queue.push(decision.url);
  }

  next(): string | undefined {
    const value = this.queue.shift();
    if (!value) return undefined;
    this.queued.delete(value);
    this.visited.add(value);
    return value;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

function createSink(store: CandidateStore, frontier?: CrawlFrontier) {
  return {
    add(rawUrl: string, baseUrl: string, provenance: CandidateProvenance): void {
      store.add(rawUrl, baseUrl, provenance);
      frontier?.enqueue(rawUrl, baseUrl, store, provenance);
    },
    error(sourceFamily: SourceFamily, message: string): void {
      store.error(sourceFamily, message);
    },
  };
}

async function installRouteInstrumentation(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const globalWindow = window as typeof window & {
      __URL_MAP_DISCOVERY__?: { routes: Array<{ value: string; kind: string }> };
    };
    const state = (globalWindow.__URL_MAP_DISCOVERY__ ??= { routes: [] });
    const record = (value: unknown, kind: string) => {
      if (typeof value !== 'string' || !value.trim()) return;
      state.routes.push({ value, kind });
      if (state.routes.length > 50_000) state.routes.splice(0, state.routes.length - 50_000);
    };

    const pushState = history.pushState.bind(history);
    history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
      if (url != null) record(String(url), 'pushState');
      return pushState(data, unused, url);
    };

    const replaceState = history.replaceState.bind(history);
    history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
      if (url != null) record(String(url), 'replaceState');
      return replaceState(data, unused, url);
    };

    const open = window.open.bind(window);
    window.open = function (url?: string | URL, target?: string, features?: string) {
      if (url != null) record(String(url), 'window.open');
      return open(url, target, features);
    };

    addEventListener('hashchange', () => record(location.href, 'hashchange'));
    addEventListener('popstate', () => record(location.href, 'popstate'));
  });
}

async function extractFrame(frame: Frame, sink: ReturnType<typeof createSink>): Promise<void> {
  const frameUrl = frame.url();
  if (frameUrl) sink.add(frameUrl, frameUrl, { sourceFamily: 'frame_url', discoveredOn: frameUrl, sourceUrl: frameUrl, label: frame.name() || undefined });

  try {
    const result = await frame.evaluate(() => {
      const rows: Array<{ value: string; family: string; attribute?: string; label?: string }> = [];
      const push = (value: string | null | undefined, family: string, attribute?: string, label?: string | null) => {
        if (!value?.trim()) return;
        rows.push({
          value,
          family,
          attribute,
          label: label?.replace(/\s+/g, ' ').trim().slice(0, 240) || undefined,
        });
      };

      // Query light DOM plus every currently open shadow root. Closed roots require CDP and
      // are outside this first module's page-JS traversal boundary.
      const roots: Array<Document | ShadowRoot> = [document];
      for (let i = 0; i < roots.length; i += 1) {
        for (const el of Array.from(roots[i]!.querySelectorAll('*'))) {
          if (el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
        }
      }
      const queryAll = (selector: string): Element[] => roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));

      for (const el of queryAll('a[href], area[href]')) {
        push(el.getAttribute('href'), 'dom_href', 'href', el.textContent);
      }
      for (const el of queryAll('form[action]')) {
        push(el.getAttribute('action'), 'form_action', 'action', el.getAttribute('aria-label') ?? el.getAttribute('name'));
      }
      for (const el of queryAll('button[formaction], input[formaction]')) {
        push(el.getAttribute('formaction'), 'form_action', 'formaction', el.getAttribute('aria-label') ?? el.textContent);
      }
      for (const el of queryAll('iframe[src], frame[src]')) {
        push(el.getAttribute('src'), 'frame_url', 'src', el.getAttribute('title') ?? el.getAttribute('name'));
      }
      for (const el of queryAll('object[data], embed[src]')) {
        push(el.getAttribute('data') ?? el.getAttribute('src'), 'embedded_url', el.hasAttribute('data') ? 'data' : 'src', el.getAttribute('title'));
      }

      // Keep every <link href>; technical cleanup removes styles/scripts/fonts later, while
      // document prefetch/alternate/next/prev/manifest links remain discoverable.
      for (const el of queryAll('link[href]')) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase();
        push(el.getAttribute('href'), rel.includes('manifest') ? 'manifest_url' : 'document_metadata', 'href', rel || 'link');
      }

      const ogUrl = queryAll('meta[property="og:url"]')[0]?.getAttribute('content');
      push(ogUrl, 'document_metadata', 'content', 'og:url');

      for (const meta of queryAll('meta[http-equiv="refresh" i][content]')) {
        const content = meta.getAttribute('content') ?? '';
        const match = /(?:^|;)\s*url\s*=\s*['"]?([^'";]+)['"]?/i.exec(content);
        push(match?.[1], 'document_metadata', 'content', 'refresh');
      }

      for (const el of queryAll('*')) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith('data-')) push(attr.value, 'data_attribute', attr.name, el.getAttribute('aria-label') ?? el.textContent);
          if (/^on(?:click|change|submit|mousedown|mouseup|touchstart|keydown)$/i.test(attr.name)) {
            push(attr.value, 'inline_event_url', attr.name, el.getAttribute('aria-label') ?? el.textContent);
          }
        }
      }

      const inlineText: string[] = [];
      for (const script of queryAll('script')) {
        if (!script.getAttribute('src') && script.textContent) inlineText.push(script.textContent);
      }
      for (const jsonLd of queryAll('script[type="application/ld+json"]')) {
        if (jsonLd.textContent) inlineText.push(jsonLd.textContent);
      }

      const storageText: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i += 1) storageText.push(localStorage.getItem(localStorage.key(i)!) ?? '');
      } catch {}
      try {
        for (let i = 0; i < sessionStorage.length; i += 1) storageText.push(sessionStorage.getItem(sessionStorage.key(i)!) ?? '');
      } catch {}

      const routeState = (window as typeof window & { __URL_MAP_DISCOVERY__?: { routes: Array<{ value: string; kind: string }> } }).__URL_MAP_DISCOVERY__;
      const routes = routeState?.routes ?? [];
      if (routeState) routeState.routes = [];

      return { rows, inlineText: inlineText.join('\n'), storageText: storageText.join('\n'), routes };
    });

    for (const row of result.rows) {
      const provenance = {
        sourceFamily: row.family as SourceFamily,
        discoveredOn: frameUrl,
        sourceUrl: frameUrl,
        label: row.label,
        attribute: row.attribute,
      };
      sink.add(row.value, frameUrl, provenance);

      // data-* and inline handlers often wrap the route in JSON/JS instead of storing a bare URL.
      if (row.family === 'data_attribute' || row.family === 'inline_event_url') {
        for (const token of scanUrlTokens(row.value)) sink.add(token, frameUrl, provenance);
      }
    }
    for (const token of scanUrlTokens(result.inlineText)) {
      sink.add(token, frameUrl, { sourceFamily: 'inline_script_url_token', discoveredOn: frameUrl, sourceUrl: frameUrl });
    }
    for (const token of scanUrlTokens(result.storageText)) {
      sink.add(token, frameUrl, { sourceFamily: 'storage_url_token', discoveredOn: frameUrl, sourceUrl: frameUrl });
    }
    for (const route of result.routes) {
      sink.add(route.value, frameUrl, { sourceFamily: 'history_route', discoveredOn: frameUrl, sourceUrl: frameUrl, label: route.kind });
    }
  } catch (error) {
    sink.error('dom_href', `DOM extraction failed for frame ${frameUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractPage(page: Page, sink: ReturnType<typeof createSink>): Promise<void> {
  for (const frame of page.frames()) await extractFrame(frame, sink);
  try {
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    for (const url of resources) {
      sink.add(url, page.url(), { sourceFamily: 'performance_resource', discoveredOn: page.url(), sourceUrl: page.url() });
    }
  } catch (error) {
    sink.error('performance_resource', `Performance API extraction failed on ${page.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

class NetworkObserver {
  private readonly pending = new Set<Promise<void>>();
  private readonly page: Page;
  private readonly store: CandidateStore;
  private readonly sink: ReturnType<typeof createSink>;

  constructor(
    page: Page,
    store: CandidateStore,
    sink: ReturnType<typeof createSink>,
  ) {
    this.page = page;
    this.store = store;
    this.sink = sink;
  }

  private readonly onRequest = (request: Request) => {
    this.sink.add(request.url(), request.frame()?.url() || this.page.url(), {
      sourceFamily: 'network_request',
      discoveredOn: request.frame()?.url() || this.page.url(),
      sourceUrl: request.url(),
      resourceType: request.resourceType(),
    });
    if (request.resourceType() === 'document') {
      this.sink.add(request.url(), request.frame()?.url() || this.page.url(), {
        sourceFamily: 'redirect_url',
        discoveredOn: request.frame()?.url() || this.page.url(),
        sourceUrl: request.url(),
        resourceType: 'document',
      });
    }
  };

  private readonly onResponse = (response: Response) => {
    const request = response.request();
    this.sink.add(response.url(), response.frame()?.url() || this.page.url(), {
      sourceFamily: 'network_response',
      discoveredOn: response.frame()?.url() || this.page.url(),
      sourceUrl: response.url(),
      resourceType: request.resourceType(),
    });

    const task = this.scanResponse(response).finally(() => this.pending.delete(task));
    this.pending.add(task);
  };

  private readonly onWebSocket = (socket: WebSocket) => {
    this.sink.add(socket.url(), this.page.url(), {
      sourceFamily: 'network_request',
      discoveredOn: this.page.url(),
      sourceUrl: socket.url(),
      resourceType: 'websocket',
    });
  };

  async scanResponse(response: Response): Promise<void> {
    try {
      const url = new URL(response.url());
      if (!Array.from(this.store.allowedHosts).some((host) => normalizeHostname(url.hostname) === host || normalizeHostname(url.hostname).endsWith(`.${host}`))) return;
      const contentType = response.headers()['content-type'] ?? '';
      if (!TEXTUAL_CONTENT.test(contentType)) return;
      const declared = Number(response.headers()['content-length'] ?? '0');
      if (declared > MAX_TEXT_RESPONSE_BYTES) return;

      const body = await withTimeout(response.body(), 10_000);
      if (!body || body.byteLength > MAX_TEXT_RESPONSE_BYTES) return;
      const text = body.toString('utf8');
      for (const token of scanUrlTokens(text)) {
        this.sink.add(token, response.url(), {
          sourceFamily: 'network_body_url_token',
          discoveredOn: response.frame()?.url() || this.page.url(),
          sourceUrl: response.url(),
          resourceType: response.request().resourceType(),
        });
      }
    } catch (error) {
      this.sink.error('network_body_url_token', `Response-body scan failed for ${response.url()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  start(): void {
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
    this.page.on('websocket', this.onWebSocket);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  stop(): void {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('websocket', this.onWebSocket);
  }
}

function candidateMarkdown(rows: TechnicalCandidate[]): string {
  const lines = ['# Technical URL Candidates', '', 'One canonical URL per line. Business relevance is intentionally NOT decided here.', ''];
  for (const row of rows) {
    const hints = row.labels.slice(0, 4).filter(Boolean);
    lines.push(hints.length > 0 ? `${row.url} (${hints.join('; ')})` : row.url);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export async function discoverSiteUrlMap(context: BrowserContext, page: Page, options: UrlMapDiscoveryOptions): Promise<UrlMapRunSummary> {
  const startedAt = new Date().toISOString();
  const entry = new URL(options.entryUrl);
  const store = new CandidateStore([entry.hostname, ...(options.additionalAllowedHosts ?? [])]);
  const passiveSink = createSink(store);
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 35_000;
  const settleMs = options.settleMs ?? 1_000;
  const maxPages = options.maxPages ?? 0;
  const recursiveMode = options.recursiveMode ?? 'fallback';

  await mkdir(options.outDir, { recursive: true });
  await installRouteInstrumentation(context);

  passiveSink.add(entry.href, entry.href, { sourceFamily: 'entry_url', discoveredOn: entry.href, sourceUrl: entry.href });

  let finalEntryUrl = entry.href;
  let pagesAttempted = 0;
  let pagesVisited = 0;
  let navigationFailures = 0;
  let stoppedByMaxPages = false;
  let recursivePagesAttempted = 0;
  let recursiveFallbackTriggered = false;
  let recursiveFallbackReason: UrlMapRunSummary['recursiveFallbackReason'];

  // Phase A: declared URL map first. This is intentionally done before browser traversal.
  // robots.txt + recursive sitemap indexes can expose thousands of URLs without visiting them.
  await discoverRobotsAndSitemaps(context.request, entry.origin, passiveSink);

  // Phase B: inspect exactly the entry page once to supplement the declared map with SPA/DOM/network routes.
  // No discovered candidate is navigated here.
  const observer = new NetworkObserver(page, store, passiveSink);
  observer.start();

  try {
    pagesAttempted += 1;
    const firstResponse = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    finalEntryUrl = page.url() || firstResponse?.url() || entry.href;
    pagesVisited += 1;
    store.addAllowedHost(new URL(finalEntryUrl).hostname);
    passiveSink.add(finalEntryUrl, finalEntryUrl, { sourceFamily: 'redirect_url', discoveredOn: entry.href, sourceUrl: finalEntryUrl, label: 'entry-final-url' });

    if (options.manualLogin) {
      // page.pause() is intentionally operator-controlled and requires headed mode.
      await page.pause();
      finalEntryUrl = page.url();
      store.addAllowedHost(new URL(finalEntryUrl).hostname);
    }

    await new Promise((resolve) => setTimeout(resolve, settleMs));
    await observer.flush();
    await extractPage(page, passiveSink);
  } catch (error) {
    navigationFailures += 1;
    store.error('entry_url', `Initial navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await observer.flush();
    observer.stop();
  }

  // If the entry redirected to another approved host/origin, inspect that origin's declared sitemap sources too.
  try {
    const finalOrigin = new URL(finalEntryUrl).origin;
    if (finalOrigin !== entry.origin) {
      await discoverRobotsAndSitemaps(context.request, finalOrigin, passiveSink);
    }
  } catch (error) {
    store.error('robots_sitemap', `Final-origin sitemap discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sitemapUrlObservationCount = store.sourceCounts.get('sitemap_url') ?? 0;
  const usableSitemapUrls = new Set<string>();
  for (const observation of store.observations) {
    if (observation.provenance.sourceFamily !== 'sitemap_url') continue;
    const decision = technicalFilter(observation.rawUrl, observation.baseUrl, store.allowedHosts);
    if (decision.status === 'accepted' && decision.url) usableSitemapUrls.add(decision.url);
  }
  const usableSitemapUrlCount = usableSitemapUrls.size;

  // Phase C: recursive browser traversal is a fallback, not the default discovery mechanism.
  // It runs automatically only when no usable sitemap page URLs were discovered, or when explicitly forced.
  const recursiveDecision = decideRecursiveTraversal(recursiveMode, usableSitemapUrlCount);
  if (recursiveDecision.run) {
    recursiveFallbackTriggered = true;
    recursiveFallbackReason = recursiveDecision.reason;

    const frontier = new CrawlFrontier();
    const crawlSink = createSink(store, frontier);
    for (const observation of store.observations) {
      frontier.enqueue(observation.rawUrl, observation.baseUrl, store, observation.provenance);
    }

    const crawlObserver = new NetworkObserver(page, store, crawlSink);
    crawlObserver.start();
    try {
      while (true) {
        if (maxPages > 0 && recursivePagesAttempted >= maxPages) {
          stoppedByMaxPages = frontier.pendingCount > 0;
          break;
        }

        const target = frontier.next();
        if (!target) break;
        if (target === finalEntryUrl || target === entry.href) continue;

        recursivePagesAttempted += 1;
        pagesAttempted += 1;
        try {
          const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
          const finalUrl = page.url() || response?.url() || target;
          crawlSink.add(finalUrl, target, {
            sourceFamily: 'redirect_url',
            discoveredOn: target,
            sourceUrl: finalUrl,
            label: finalUrl !== target ? 'navigation-redirect' : 'navigation-final',
          });

          const contentType = response?.headers()['content-type'] ?? '';
          if (response && contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
            await crawlObserver.flush();
            continue;
          }

          pagesVisited += 1;
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          await crawlObserver.flush();
          await extractPage(page, crawlSink);
        } catch (error) {
          navigationFailures += 1;
          store.error('dom_href', `Fallback navigation failed for ${target}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await crawlObserver.flush();
      crawlObserver.stop();
    }
  }

  const { accepted, rejected } = store.buildTechnical();
  const sourceFamilyObservationCounts = Object.fromEntries(
    [...store.sourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );

  const finishedAt = new Date().toISOString();
  const summary: UrlMapRunSummary = {
    entryUrl: entry.href,
    finalEntryUrl,
    allowedHosts: [...store.allowedHosts].sort(),
    startedAt,
    finishedAt,
    pagesAttempted,
    pagesVisited,
    navigationFailures,
    rawObservationCount: store.observations.length,
    uniqueTechnicalCandidateCount: accepted.length,
    technicalRejectedCount: rejected.length,
    sourceFamilyObservationCounts,
    sourceErrors: store.sourceErrors,
    sitemapUrlObservationCount,
    usableSitemapUrlCount,
    recursiveFallbackTriggered,
    recursiveFallbackReason,
    recursivePagesAttempted,
    stoppedByMaxPages,
  };

  await writeJsonl(join(options.outDir, 'raw-url-candidates.jsonl'), store.observations);
  await writeJsonl(join(options.outDir, 'technical-rejected-urls.jsonl'), rejected);
  await writeFile(join(options.outDir, 'technical-url-candidates.md'), candidateMarkdown(accepted), 'utf8');
  await writeFile(join(options.outDir, 'url-map-run.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  return summary;
}

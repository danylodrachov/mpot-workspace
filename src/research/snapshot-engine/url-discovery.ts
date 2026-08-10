import type { BrowserContext, Frame, Page, Request, Response, WebSocket } from 'playwright';
import { scanUrlTokens } from './token-scan.ts';
import type { RawUrlCandidate, SourceFamily } from './types.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TEXTUAL_CONTENT_TYPE = /(?:json|javascript|ecmascript|text\/|xml|svg)/i;

export interface DiscoverySink {
  add(candidate: RawUrlCandidate): void;
  error(sourceFamily: SourceFamily, message: string): void;
}

function normalizeCandidateToken(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '');
}

async function extractFrameDom(frame: Frame, sink: DiscoverySink): Promise<void> {
  try {
    const rows = await frame.evaluate(() => {
      const out: Array<{ value: string; attribute: string; label?: string }> = [];
      const push = (value: string | null, attribute: string, label?: string | null) => {
        if (!value) return;
        out.push({
          value,
          attribute,
          label: label?.replace(/\s+/g, ' ').trim().slice(0, 240) || undefined,
        });
      };

      for (const el of Array.from(document.querySelectorAll('a[href], area[href]'))) {
        push(el.getAttribute('href'), 'href', el.textContent);
      }
      for (const el of Array.from(document.querySelectorAll('form[action]'))) {
        push(el.getAttribute('action'), 'action', el.getAttribute('aria-label') ?? el.getAttribute('name'));
      }
      for (const el of Array.from(document.querySelectorAll('iframe[src], frame[src]'))) {
        push(el.getAttribute('src'), 'src', el.getAttribute('title') ?? el.getAttribute('name'));
      }
      for (const el of Array.from(document.querySelectorAll('link[href]'))) {
        push(el.getAttribute('href'), 'href', el.getAttribute('rel'));
      }
      for (const el of Array.from(document.querySelectorAll('script[src]'))) {
        push(el.getAttribute('src'), 'src', 'script');
      }
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      if (canonical) push(canonical, 'canonical', 'canonical');
      for (const meta of Array.from(document.querySelectorAll('meta[content]'))) {
        const key = (meta.getAttribute('property') ?? meta.getAttribute('name') ?? meta.getAttribute('http-equiv') ?? '').toLowerCase();
        if (/url|canonical|refresh|alternate/.test(key)) push(meta.getAttribute('content'), 'meta-content', key);
      }
      return out;
    });

    for (const row of rows) {
      sink.add({
        rawUrl: normalizeCandidateToken(row.value),
        provenance: {
          sourceFamily: row.attribute === 'meta-content' || row.attribute === 'canonical' ? 'document_metadata' : 'dom_url_attribute',
          discoveredOn: frame.url(),
          label: row.label,
          attribute: row.attribute,
        },
      });
    }
  } catch (error) {
    sink.error('dom_url_attribute', `DOM URL extraction failed on frame ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractInlineScriptTokens(frame: Frame, sink: DiscoverySink): Promise<void> {
  try {
    const tokens = await frame.evaluate(() => {
      const out = new Set<string>();
      const max = 20_000;
      const absolute = /https?:\\?\/\\?\/[^\s"'<>`\\]+/gi;
      const rootPath = /["'`]((?:\\?\/)[A-Za-z0-9][^"'`<>\s]{0,1023})["'`]/g;
      for (const script of Array.from(document.scripts)) {
        if (script.src) continue;
        const text = script.textContent ?? '';
        for (const match of text.matchAll(absolute)) {
          out.add(match[0]!.replace(/\\\//g, '/'));
          if (out.size >= max) return [...out];
        }
        for (const match of text.matchAll(rootPath)) {
          out.add((match[1] ?? '').replace(/\\\//g, '/'));
          if (out.size >= max) return [...out];
        }
      }
      return [...out];
    });
    for (const token of tokens) {
      sink.add({
        rawUrl: token,
        provenance: {
          sourceFamily: 'inline_script_url_token',
          discoveredOn: frame.url(),
          sourceUrl: frame.url(),
        },
      });
    }
  } catch (error) {
    sink.error('inline_script_url_token', `Inline script scan failed on frame ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractPerformance(page: Page, sink: DiscoverySink): Promise<void> {
  try {
    const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    for (const url of urls) {
      sink.add({
        rawUrl: url,
        provenance: { sourceFamily: 'performance_resource', discoveredOn: page.url(), sourceUrl: page.url() },
      });
    }
  } catch (error) {
    sink.error('performance_resource', `Performance API scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function discoverFromPage(page: Page, sink: DiscoverySink): Promise<void> {
  for (const frame of page.frames()) {
    sink.add({
      rawUrl: frame.url(),
      provenance: { sourceFamily: 'frame_url', discoveredOn: page.url(), sourceUrl: page.url(), label: frame.name() || undefined },
    });
    await extractFrameDom(frame, sink);
    await extractInlineScriptTokens(frame, sink);
  }
  await extractPerformance(page, sink);
}

function hostnameInScope(hostname: string, allowedHostname: string): boolean {
  const candidate = hostname.toLowerCase().replace(/^www\./, '');
  const scope = allowedHostname.toLowerCase().replace(/^www\./, '');
  return candidate === scope || candidate.endsWith(`.${scope}`);
}

async function scanResponseBody(response: Response, sink: DiscoverySink, allowedHostname: string): Promise<void> {
  try {
    const url = new URL(response.url());
    if (!hostnameInScope(url.hostname, allowedHostname)) return;
    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    if (!TEXTUAL_CONTENT_TYPE.test(contentType)) return;
    const declaredLength = Number(headers['content-length'] ?? '0');
    if (declaredLength > MAX_BODY_BYTES) return;
    const body = await response.body();
    if (body.byteLength > MAX_BODY_BYTES) return;
    const text = body.toString('utf8');
    for (const token of scanUrlTokens(text, { maxTokens: 20_000 })) {
      sink.add({
        rawUrl: token,
        provenance: {
          sourceFamily: 'network_body_url_token',
          discoveredOn: response.frame()?.url() ?? response.url(),
          sourceUrl: response.url(),
        },
      });
    }
  } catch (error) {
    sink.error('network_body_url_token', `Response body scan failed for ${response.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class PassiveNetworkObserver {
  private readonly pending = new Set<Promise<void>>();
  private currentPageUrl = '';
  readonly counters = {
    requests: 0,
    responses: 0,
    failedRequests: 0,
    xhrOrFetchResponses: 0,
    scriptResponses: 0,
    jsonResponses: 0,
    websocketConnections: 0,
  };

  // Plain field assignment, not parameter properties: this module runs under
  // node --experimental-strip-types, which rejects constructor parameter properties.
  private readonly page: Page;
  private readonly sink: DiscoverySink;
  private readonly allowedHostname: string;

  constructor(page: Page, sink: DiscoverySink, allowedHostname: string) {
    this.page = page;
    this.sink = sink;
    this.allowedHostname = allowedHostname;
  }

  start(): void {
    this.currentPageUrl = this.page.url();
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
    this.page.on('requestfailed', this.onRequestFailed);
    this.page.on('websocket', this.onWebSocket);
  }

  private readonly onRequest = (request: Request) => {
    this.counters.requests += 1;
    this.sink.add({
      rawUrl: request.url(),
      provenance: {
        sourceFamily: 'network_request',
        discoveredOn: request.frame()?.url() ?? this.currentPageUrl,
        sourceUrl: request.url(),
      },
    });
  };

  private readonly onResponse = (response: Response) => {
    this.counters.responses += 1;
    const type = response.request().resourceType();
    if (type === 'xhr' || type === 'fetch') this.counters.xhrOrFetchResponses += 1;
    if (type === 'script') this.counters.scriptResponses += 1;
    if ((response.headers()['content-type'] ?? '').includes('json')) this.counters.jsonResponses += 1;
    this.sink.add({
      rawUrl: response.url(),
      provenance: {
        sourceFamily: 'network_response',
        discoveredOn: response.frame()?.url() ?? this.currentPageUrl,
        sourceUrl: response.url(),
      },
    });
    const task = scanResponseBody(response, this.sink, this.allowedHostname).finally(() => this.pending.delete(task));
    this.pending.add(task);
  };

  private readonly onRequestFailed = () => {
    this.counters.failedRequests += 1;
  };

  private readonly onWebSocket = (socket: WebSocket) => {
    this.counters.websocketConnections += 1;
    this.sink.add({
      rawUrl: socket.url(),
      provenance: {
        sourceFamily: 'network_request',
        discoveredOn: this.page.url(),
        sourceUrl: socket.url(),
        label: 'websocket',
      },
    });
  };

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  stop(): void {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('requestfailed', this.onRequestFailed);
    this.page.off('websocket', this.onWebSocket);
  }
}

async function fetchText(context: BrowserContext, url: string): Promise<{ status: number; text?: string }> {
  const response = await context.request.get(url, { timeout: 20_000, failOnStatusCode: false });
  const status = response.status();
  const headers = response.headers();
  const declaredLength = Number(headers['content-length'] ?? '0');
  if (declaredLength > MAX_BODY_BYTES) return { status };
  const body = await response.body();
  if (body.byteLength > MAX_BODY_BYTES) return { status };
  return { status, text: body.toString('utf8') };
}

export async function discoverRobotsAndSitemaps(
  context: BrowserContext,
  allowedOrigin: string,
  sink: DiscoverySink,
): Promise<void> {
  const sitemapQueue: string[] = [];
  const seenSitemaps = new Set<string>();
  try {
    const robotsUrl = new URL('/robots.txt', allowedOrigin).href;
    const robots = await fetchText(context, robotsUrl);
    if (robots.text) {
      for (const line of robots.text.split(/\r?\n/)) {
        const match = /^\s*Sitemap:\s*(\S+)/i.exec(line);
        if (match?.[1]) {
          sitemapQueue.push(match[1]);
          sink.add({ rawUrl: match[1], provenance: { sourceFamily: 'robots_sitemap', discoveredOn: robotsUrl, sourceUrl: robotsUrl } });
        }
      }
      for (const token of scanUrlTokens(robots.text, { maxTokens: 10_000 })) {
        sink.add({ rawUrl: token, provenance: { sourceFamily: 'robots_sitemap', discoveredOn: robotsUrl, sourceUrl: robotsUrl } });
      }
    }
  } catch (error) {
    sink.error('robots_sitemap', `robots.txt fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  sitemapQueue.push(new URL('/sitemap.xml', allowedOrigin).href);

  while (sitemapQueue.length > 0 && seenSitemaps.size < 100) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    try {
      const response = await fetchText(context, sitemapUrl);
      if (!response.text || response.status >= 400) continue;
      const locs = [...response.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]!.replace(/&amp;/g, '&'));
      for (const loc of locs) {
        sink.add({ rawUrl: loc, provenance: { sourceFamily: 'sitemap_url', discoveredOn: sitemapUrl, sourceUrl: sitemapUrl } });
        if (/\.xml(?:\.gz)?(?:$|\?)/i.test(loc)) sitemapQueue.push(loc);
      }
    } catch (error) {
      sink.error('sitemap_url', `Sitemap fetch failed for ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function scanSameDomainTextSources(
  context: BrowserContext,
  sourceUrls: string[],
  allowedHostname: string,
  sink: DiscoverySink,
  alreadyScanned = new Set<string>(),
): Promise<void> {
  const seen = alreadyScanned;
  for (const sourceUrl of sourceUrls.sort()) {
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    try {
      const url = new URL(sourceUrl);
      if (!hostnameInScope(url.hostname, allowedHostname)) continue;
      const response = await fetchText(context, url.href);
      if (!response.text || response.status >= 400) continue;
      const family: SourceFamily = /\.(?:js|mjs)(?:$|\?)/i.test(url.pathname)
        ? 'external_script_url_token'
        : 'network_body_url_token';
      for (const token of scanUrlTokens(response.text, { maxTokens: 20_000 })) {
        sink.add({
          rawUrl: token,
          provenance: {
            sourceFamily: family,
            discoveredOn: url.origin,
            sourceUrl: url.href,
          },
        });
      }
    } catch (error) {
      sink.error('network_body_url_token', `Text source scan failed for ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

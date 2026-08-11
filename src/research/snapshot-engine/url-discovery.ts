import path from 'node:path';
import type { BrowserContext, Frame, Page, Request, Response, WebSocket } from 'playwright';
import { scanUrlTokens } from './token-scan.ts';
import type { NetworkEvidenceRecord, RawUrlCandidate, SourceFamily } from './types.ts';
import { DEFAULT_RUNTIME_BUDGETS } from './runtime-config.ts';
import { appendJsonLine, sha256, writeTextAtomic } from './io.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TEXTUAL_CONTENT_TYPE = /(?:json|javascript|ecmascript|text\/|xml|svg)/i;

// CD-N07: deterministic deadlines — one stuck network response must never block the crawl.
// Derived from the centralized runtime-config budgets so this module has no timeout constant of
// its own that could silently drift from the documented defaults.
const RESPONSE_BODY_TIMEOUT_MS = DEFAULT_RUNTIME_BUDGETS.responseBodyScanTimeoutMs;
const FLUSH_DEADLINE_MS = DEFAULT_RUNTIME_BUDGETS.networkObserverFlushTimeoutMs;

// FIX-07/CD-N07: batch-level deadlines for passive enrichment operations that otherwise loop over
// an unbounded number of same-domain sources/pages with no overall bound. Reused (not duplicated)
// by crawler.ts, which wraps the corresponding batch call with `withTimeout` using these values
// (overridable per-call for tests). Kept as their own exported constants (rather than reusing one
// of the generic runtime-config budgets) since neither has a 1:1 equivalent in RuntimeBudgets.
export const TEXT_SOURCE_BATCH_TIMEOUT_MS = 30_000;
export const ROBOTS_SITEMAP_BATCH_TIMEOUT_MS = 20_000;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// FIX-06: an extractor's run outcome for one source family, distinct from per-candidate
// errors. 'error' status is still driven by sink.error() (kept separate so every existing
// error call site continues to work unmodified); this covers the non-error terminal states
// an extractor can explicitly declare once it actually ran.
export type SourceRunStatus = 'complete' | 'absent' | 'blocked' | 'unsupported';

export interface SourceRunOutcome {
  status: SourceRunStatus;
  durationMs?: number;
}

export interface DiscoverySink {
  add(candidate: RawUrlCandidate): void;
  error(sourceFamily: SourceFamily, message: string): void;
  // Called by an extractor exactly once per invocation once it has actually run, so
  // coverage reporting never has to *infer* completion merely from "no exception thrown".
  recordRun(sourceFamily: SourceFamily, outcome: SourceRunOutcome): void;
}

function normalizeCandidateToken(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '');
}

async function extractFrameDom(frame: Frame, sink: DiscoverySink): Promise<void> {
  const startedAt = Date.now();
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
    const durationMs = Date.now() - startedAt;
    sink.recordRun('dom_url_attribute', { status: 'complete', durationMs });
    sink.recordRun('document_metadata', { status: 'complete', durationMs });
  } catch (error) {
    sink.error('dom_url_attribute', `DOM URL extraction failed on frame ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
    sink.error('document_metadata', `DOM URL extraction failed on frame ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractInlineScriptTokens(frame: Frame, sink: DiscoverySink): Promise<void> {
  const startedAt = Date.now();
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
    sink.recordRun('inline_script_url_token', { status: 'complete', durationMs: Date.now() - startedAt });
  } catch (error) {
    sink.error('inline_script_url_token', `Inline script scan failed on frame ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractPerformance(page: Page, sink: DiscoverySink): Promise<void> {
  const startedAt = Date.now();
  try {
    const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    for (const url of urls) {
      sink.add({
        rawUrl: url,
        provenance: { sourceFamily: 'performance_resource', discoveredOn: page.url(), sourceUrl: page.url() },
      });
    }
    sink.recordRun('performance_resource', { status: 'complete', durationMs: Date.now() - startedAt });
  } catch (error) {
    sink.error('performance_resource', `Performance API scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function discoverFromPage(page: Page, sink: DiscoverySink): Promise<void> {
  const startedAt = Date.now();
  const frames = page.frames();
  for (const frame of frames) {
    sink.add({
      rawUrl: frame.url(),
      provenance: { sourceFamily: 'frame_url', discoveredOn: page.url(), sourceUrl: page.url(), label: frame.name() || undefined },
    });
    await extractFrameDom(frame, sink);
    await extractInlineScriptTokens(frame, sink);
  }
  sink.recordRun('frame_url', { status: 'complete', durationMs: Date.now() - startedAt });
  await extractPerformance(page, sink);
}

function hostnameInScope(hostname: string, allowedHostname: string): boolean {
  const candidate = hostname.toLowerCase().replace(/^www\./, '');
  const scope = allowedHostname.toLowerCase().replace(/^www\./, '');
  return candidate === scope || candidate.endsWith(`.${scope}`);
}

async function scanResponseBody(
  response: Response,
  sink: DiscoverySink,
  allowedHostname: string,
  responseBodyTimeoutMs: number = RESPONSE_BODY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const url = new URL(response.url());
    if (!hostnameInScope(url.hostname, allowedHostname)) return;
    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    if (!TEXTUAL_CONTENT_TYPE.test(contentType)) return;
    const declaredLength = Number(headers['content-length'] ?? '0');
    if (declaredLength > MAX_BODY_BYTES) return;
    const body = await withTimeout(
      response.body(),
      responseBodyTimeoutMs,
      `Response body scan exceeded ${responseBodyTimeoutMs}ms deadline for ${response.url()}`,
    );
    if (body.byteLength > MAX_BODY_BYTES) return;
    const text = body.toString('utf8');
    let tokenCount = 0;
    for (const token of scanUrlTokens(text, { maxTokens: 20_000 })) {
      tokenCount += 1;
      sink.add({
        rawUrl: token,
        provenance: {
          sourceFamily: 'network_body_url_token',
          discoveredOn: response.frame()?.url() ?? response.url(),
          sourceUrl: response.url(),
        },
      });
    }
    sink.recordRun('network_body_url_token', {
      status: tokenCount > 0 ? 'complete' : 'absent',
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // FIX-01: a response-body scan that blows through its bounded deadline (or otherwise
    // throws) must surface as an explicit 'error' terminal state for network_body_url_token
    // — never silently resolve as an empty success.
    sink.error('network_body_url_token', `Response body scan failed for ${response.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// CF-02: run-scoped sink for persisting bounded same-origin xhr/fetch response bodies as
// factual evidence, separate from the URL-token discovery above (which is left unchanged).
export interface NetworkEvidenceOptions {
  evidenceDir: string;
  evidenceIndexPath: string;
}

function contentTypeExtension(contentType: string | undefined): string {
  if (contentType && /json/i.test(contentType)) return 'json';
  if (contentType && /xml/i.test(contentType)) return 'xml';
  return 'txt';
}

async function appendNetworkEvidenceRecord(evidenceIndexPath: string, record: NetworkEvidenceRecord): Promise<void> {
  try {
    await appendJsonLine(evidenceIndexPath, record);
  } catch {
    // A failure to write the evidence index must never fail the page visit (CF-02 constraint).
  }
}

// CF-02: eligibility is narrower than the existing URL-token body scan above — same-origin,
// resourceType xhr/fetch, textual content-type, successful HTTP response, bounded size/timeout.
// Cross-origin and non-xhr/fetch traffic is never a candidate at all (no index record).
async function captureNetworkEvidence(
  response: Response,
  allowedHostname: string,
  observedOnPageUrl: string,
  options: NetworkEvidenceOptions,
  bodyHashCache: Map<string, string>,
  timeoutMs: number,
): Promise<void> {
  const request = response.request();
  const resourceType = request.resourceType();
  if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (!hostnameInScope(url.hostname, allowedHostname)) return;

  const requestUrl = response.url();
  // CF-02: a capture failure must never fail the page visit — tolerate minimal test/fixture
  // Request doubles that don't implement every real-Playwright method.
  const requestMethod = typeof request.method === 'function' ? request.method() : 'GET';
  const status = typeof response.status === 'function' ? response.status() : 200;
  const contentType = response.headers()['content-type'];
  const capturedAt = new Date().toISOString();
  const baseRecord = {
    schemaVersion: '1.0' as const,
    observedOnPageUrl,
    requestUrl,
    requestMethod,
    resourceType,
    status,
    contentType,
    capturedAt,
  };

  try {
    if (status < 200 || status >= 300) {
      await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
        ...baseRecord,
        outcome: 'skipped',
        reason: `non-success HTTP status ${status}`,
      });
      return;
    }
    if (!TEXTUAL_CONTENT_TYPE.test(contentType ?? '')) {
      await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
        ...baseRecord,
        outcome: 'skipped',
        reason: `unsupported content-type${contentType ? `: ${contentType}` : ''}`,
      });
      return;
    }
    const declaredLength = Number(response.headers()['content-length'] ?? '0');
    if (declaredLength > MAX_BODY_BYTES) {
      await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
        ...baseRecord,
        outcome: 'skipped',
        reason: `declared content-length ${declaredLength} exceeds ${MAX_BODY_BYTES} byte limit`,
      });
      return;
    }

    let body: Buffer;
    try {
      body = await withTimeout(
        response.body(),
        timeoutMs,
        `Network evidence capture exceeded ${timeoutMs}ms deadline for ${requestUrl}`,
      );
    } catch (error) {
      const isTimeout = error instanceof TimeoutError;
      await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
        ...baseRecord,
        outcome: isTimeout ? 'timeout' : 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (body.byteLength > MAX_BODY_BYTES) {
      await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
        ...baseRecord,
        outcome: 'skipped',
        reason: `body ${body.byteLength} bytes exceeds ${MAX_BODY_BYTES} byte limit`,
      });
      return;
    }

    // CF-02: raw textual body stored exactly as received; identical bodies observed earlier in
    // this run are deduplicated by content hash rather than re-written to disk.
    const hash = sha256(body);
    let bodyPath = bodyHashCache.get(hash);
    if (!bodyPath) {
      bodyPath = path.join(options.evidenceDir, `${hash}.${contentTypeExtension(contentType)}`);
      await writeTextAtomic(bodyPath, body.toString('utf8'));
      bodyHashCache.set(hash, bodyPath);
    }

    await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
      ...baseRecord,
      bodyPath,
      bodySha256: hash,
      bodyBytes: body.byteLength,
      outcome: 'captured',
    });
  } catch (error) {
    await appendNetworkEvidenceRecord(options.evidenceIndexPath, {
      ...baseRecord,
      outcome: 'error',
      reason: error instanceof Error ? error.message : String(error),
    });
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
  private readonly flushDeadlineMs: number;
  private readonly responseBodyTimeoutMs: number;
  private readonly networkEvidence?: NetworkEvidenceOptions;
  // CF-02: dedupe identical response bodies by content hash within this run's observer lifetime.
  private readonly evidenceBodyHashCache = new Map<string, string>();

  constructor(
    page: Page,
    sink: DiscoverySink,
    allowedHostname: string,
    flushDeadlineMs: number = FLUSH_DEADLINE_MS,
    responseBodyTimeoutMs: number = RESPONSE_BODY_TIMEOUT_MS,
    networkEvidence?: NetworkEvidenceOptions,
  ) {
    this.page = page;
    this.sink = sink;
    this.allowedHostname = allowedHostname;
    this.flushDeadlineMs = flushDeadlineMs;
    this.responseBodyTimeoutMs = responseBodyTimeoutMs;
    this.networkEvidence = networkEvidence;
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
    this.sink.recordRun('network_request', { status: 'complete' });
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
    this.sink.recordRun('network_response', { status: 'complete' });
    const task = scanResponseBody(response, this.sink, this.allowedHostname, this.responseBodyTimeoutMs).finally(() => this.pending.delete(task));
    this.pending.add(task);
    if (this.networkEvidence) {
      const observedOnPageUrl = response.frame()?.url() ?? this.currentPageUrl;
      const evidenceTask = captureNetworkEvidence(
        response,
        this.allowedHostname,
        observedOnPageUrl,
        this.networkEvidence,
        this.evidenceBodyHashCache,
        this.responseBodyTimeoutMs,
      ).finally(() => this.pending.delete(evidenceTask));
      this.pending.add(evidenceTask);
    }
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
    const pendingCount = this.pending.size;
    if (pendingCount === 0) return;
    const settled = Promise.allSettled([...this.pending]);
    const outcome = await Promise.race([
      settled.then(() => 'completed' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), this.flushDeadlineMs)),
    ]);
    if (outcome === 'timed-out') {
      const stillPending = this.pending.size;
      this.sink.error(
        'network_body_url_token',
        `PassiveNetworkObserver.flush() exceeded ${this.flushDeadlineMs}ms deadline with ${stillPending}/${pendingCount} response-body task(s) still pending; continuing without waiting further`,
      );
    }
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
  const robotsStartedAt = Date.now();
  try {
    const robotsUrl = new URL('/robots.txt', allowedOrigin).href;
    const robots = await fetchText(context, robotsUrl);
    if (robots.status === 403) {
      sink.recordRun('robots_sitemap', { status: 'blocked', durationMs: Date.now() - robotsStartedAt });
    } else if (!robots.text || robots.status === 404) {
      sink.recordRun('robots_sitemap', { status: 'absent', durationMs: Date.now() - robotsStartedAt });
    } else {
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
      sink.recordRun('robots_sitemap', { status: 'complete', durationMs: Date.now() - robotsStartedAt });
    }
  } catch (error) {
    sink.error('robots_sitemap', `robots.txt fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  sitemapQueue.push(new URL('/sitemap.xml', allowedOrigin).href);

  const sitemapStartedAt = Date.now();
  let sitemapFoundAny = false;
  let sitemapBlocked = false;
  let sitemapAttempted = false;
  let sitemapErrored = false;
  while (sitemapQueue.length > 0 && seenSitemaps.size < 100) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    sitemapAttempted = true;
    try {
      const response = await fetchText(context, sitemapUrl);
      if (response.status === 403) {
        sitemapBlocked = true;
        continue;
      }
      if (!response.text || response.status >= 400) continue;
      const locs = [...response.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]!.replace(/&amp;/g, '&'));
      if (locs.length > 0) sitemapFoundAny = true;
      for (const loc of locs) {
        sink.add({ rawUrl: loc, provenance: { sourceFamily: 'sitemap_url', discoveredOn: sitemapUrl, sourceUrl: sitemapUrl } });
        if (/\.xml(?:\.gz)?(?:$|\?)/i.test(loc)) sitemapQueue.push(loc);
      }
    } catch (error) {
      sitemapErrored = true;
      sink.error('sitemap_url', `Sitemap fetch failed for ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!sitemapErrored) {
    const durationMs = Date.now() - sitemapStartedAt;
    if (sitemapFoundAny) sink.recordRun('sitemap_url', { status: 'complete', durationMs });
    else if (sitemapBlocked) sink.recordRun('sitemap_url', { status: 'blocked', durationMs });
    else if (sitemapAttempted) sink.recordRun('sitemap_url', { status: 'absent', durationMs });
    else sink.recordRun('sitemap_url', { status: 'unsupported', durationMs });
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
  const startedAt = Date.now();
  let attempted = false;
  let foundExternalScript = false;
  let foundBodyToken = false;
  let erroredExternalScript = false;
  let erroredBodyToken = false;
  for (const sourceUrl of sourceUrls.sort()) {
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      continue;
    }
    if (!hostnameInScope(url.hostname, allowedHostname)) continue;
    attempted = true;
    const family: SourceFamily = /\.(?:js|mjs)(?:$|\?)/i.test(url.pathname)
      ? 'external_script_url_token'
      : 'network_body_url_token';
    try {
      const response = await fetchText(context, url.href);
      if (!response.text || response.status >= 400) continue;
      let tokenCount = 0;
      for (const token of scanUrlTokens(response.text, { maxTokens: 20_000 })) {
        tokenCount += 1;
        sink.add({
          rawUrl: token,
          provenance: {
            sourceFamily: family,
            discoveredOn: url.origin,
            sourceUrl: url.href,
          },
        });
      }
      if (tokenCount > 0) {
        if (family === 'external_script_url_token') foundExternalScript = true;
        else foundBodyToken = true;
      }
    } catch (error) {
      if (family === 'external_script_url_token') erroredExternalScript = true;
      else erroredBodyToken = true;
      sink.error('network_body_url_token', `Text source scan failed for ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  if (!erroredExternalScript) {
    sink.recordRun('external_script_url_token', {
      status: !attempted ? 'unsupported' : foundExternalScript ? 'complete' : 'absent',
      durationMs,
    });
  }
  if (!erroredBodyToken) {
    sink.recordRun('network_body_url_token', {
      status: !attempted ? 'unsupported' : foundBodyToken ? 'complete' : 'absent',
      durationMs,
    });
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassiveNetworkObserver, type DiscoverySink } from './url-discovery.ts';
import type { NetworkEvidenceRecord, RawUrlCandidate, SourceFamily } from './types.ts';

// Minimal fakes: PassiveNetworkObserver only touches page.on/off, response.url/headers/body/
// request()/frame(), and the sink. We do not need a real Playwright Page.
function makeFakePage(handlers: Record<string, (...args: unknown[]) => void>) {
  return {
    url: () => 'https://example.com/',
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    },
    off: (event: string) => {
      delete handlers[event];
    },
  };
}

function makeSink(): DiscoverySink & { candidates: RawUrlCandidate[]; errors: Array<{ sourceFamily: SourceFamily; message: string }> } {
  const candidates: RawUrlCandidate[] = [];
  const errors: Array<{ sourceFamily: SourceFamily; message: string }> = [];
  return {
    candidates,
    errors,
    add(candidate) {
      candidates.push(candidate);
    },
    error(sourceFamily, message) {
      errors.push({ sourceFamily, message });
    },
    recordRun() {
      // no-op for these tests
    },
  };
}

function makeResponse(url: string, bodyPromise: Promise<Buffer>, contentType = 'text/html') {
  return {
    url: () => url,
    headers: () => ({ 'content-type': contentType }),
    status: () => 200,
    body: () => bodyPromise,
    request: () => ({ resourceType: () => 'document', method: () => 'GET' }),
    frame: () => ({ url: () => url }),
  };
}

// CF-02 fixture: same shape as makeResponse, plus resourceType/status/method knobs needed by the
// network-evidence sink (which the URL-token-only makeResponse above deliberately doesn't need).
function makeEvidenceResponse(options: {
  url: string;
  bodyPromise: () => Promise<Buffer>;
  contentType?: string;
  resourceType?: string;
  status?: number;
  method?: string;
  pageUrl?: string;
}) {
  return {
    url: () => options.url,
    headers: () => ({ 'content-type': options.contentType ?? 'application/json' }),
    status: () => options.status ?? 200,
    body: options.bodyPromise,
    request: () => ({ resourceType: () => options.resourceType ?? 'xhr', method: () => options.method ?? 'GET' }),
    frame: () => ({ url: () => options.pageUrl ?? 'https://example.com/' }),
  };
}

function makeEvidenceDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-evidence-'));
  return { evidenceDir: path.join(dir, 'network'), evidenceIndexPath: path.join(dir, 'network-evidence.jsonl') };
}

function readEvidenceIndex(evidenceIndexPath: string): NetworkEvidenceRecord[] {
  if (!fs.existsSync(evidenceIndexPath)) return [];
  const raw = fs.readFileSync(evidenceIndexPath, 'utf-8').trim();
  return raw.length > 0 ? (raw.split('\n').map((line) => JSON.parse(line)) as NetworkEvidenceRecord[]) : [];
}

test('flush() does not block beyond the configured deadline when a response body never resolves', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();

  // Deliberately small deadline so the test runs fast and uses no real long waits.
  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 50);
  observer.start();

  const neverResolvingBody = new Promise<Buffer>(() => {
    /* stuck forever, simulating a hung network response */
  });
  const stuckResponse = makeResponse('https://example.com/stuck.js', neverResolvingBody, 'application/javascript');
  handlers.response(stuckResponse);

  const startedAt = Date.now();
  await observer.flush();
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 500, `flush() took ${elapsedMs}ms, expected it to return near the 50ms deadline`);
  assert.ok(
    sink.errors.some((entry) => entry.sourceFamily === 'network_body_url_token' && /flush\(\) exceeded/.test(entry.message)),
    'expected flush() timeout to be recorded via sink.error for network_body_url_token',
  );

  observer.stop();
});

test('flush() still surfaces candidates from response bodies that resolve before the deadline', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000);
  observer.start();

  const okResponse = makeResponse(
    'https://example.com/app.js',
    Promise.resolve(Buffer.from('"/api/promo-list"', 'utf8')),
    'application/javascript',
  );
  handlers.response(okResponse);

  await observer.flush();

  assert.ok(
    sink.candidates.some((candidate) => candidate.rawUrl === '/api/promo-list'),
    'expected the resolved response body to still contribute a URL candidate',
  );

  observer.stop();
});

test('CF-02: existing URL-token discovery from a response body still works when evidence capture is also enabled', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  const response = makeEvidenceResponse({
    url: 'https://example.com/api/v3/promotion/list?x=1',
    bodyPromise: async () => Buffer.from('{"next":"/api/promo-list"}'),
    contentType: 'application/json',
    resourceType: 'xhr',
  });
  handlers.response(response);

  await observer.flush();

  assert.ok(
    sink.candidates.some((candidate) => candidate.rawUrl === '/api/promo-list'),
    'existing URL-token discovery from the body must be unaffected by evidence capture',
  );
  observer.stop();
});

test('CF-02: a same-origin JSON xhr response body is persisted and indexed as captured', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  const bodyText = '{"promotions":[{"name":"Welcome Bonus"}]}';
  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/api/v3/promotion/list',
      bodyPromise: async () => Buffer.from(bodyText),
      contentType: 'application/json',
      resourceType: 'xhr',
    }),
  );
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  const record = records.find((row) => row.requestUrl === 'https://example.com/api/v3/promotion/list');
  assert.ok(record, 'expected an index record for the same-origin xhr JSON response');
  assert.equal(record?.outcome, 'captured');
  assert.equal(record?.schemaVersion, '1.0');
  assert.ok(record?.bodyPath && fs.existsSync(record.bodyPath));
  assert.equal(record?.bodySha256, createHash('sha256').update(bodyText).digest('hex'));
  assert.equal(fs.readFileSync(record!.bodyPath!, 'utf-8'), bodyText);
});

test('CF-02: a same-origin text fetch response body is persisted and indexed as captured', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/cashbox/paymentsystem',
      bodyPromise: async () => Buffer.from('Visa,Mastercard'),
      contentType: 'text/plain',
      resourceType: 'fetch',
    }),
  );
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  const record = records.find((row) => row.requestUrl === 'https://example.com/cashbox/paymentsystem');
  assert.equal(record?.outcome, 'captured');
  assert.ok(record?.bodyPath && fs.readFileSync(record.bodyPath, 'utf-8').includes('Visa'));
});

test('CF-02: an image/font/binary response is never persisted as network evidence', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  // Non-xhr/fetch resourceType (image) is never an evidence candidate at all.
  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/visa-logo.png',
      bodyPromise: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      resourceType: 'image',
    }),
  );
  // A binary xhr response with a non-textual content-type must be skipped, not captured.
  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/api/font.woff2',
      bodyPromise: async () => Buffer.from([0x00, 0x01, 0x02]),
      contentType: 'font/woff2',
      resourceType: 'xhr',
    }),
  );
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  assert.equal(records.some((row) => row.requestUrl === 'https://example.com/visa-logo.png'), false);
  const fontRecord = records.find((row) => row.requestUrl === 'https://example.com/api/font.woff2');
  assert.notEqual(fontRecord?.outcome, 'captured');
});

test('CF-02: a cross-origin response is never persisted as network evidence', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  handlers.response(
    makeEvidenceResponse({
      url: 'https://analytics.other-domain.com/collect',
      bodyPromise: async () => Buffer.from('{"ok":true}'),
      contentType: 'application/json',
      resourceType: 'xhr',
    }),
  );
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  assert.equal(records.length, 0, 'a cross-origin response must never produce a network-evidence record');
});

test('CF-02: an oversized response body is skipped with an explicit reason', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/api/v3/huge',
      bodyPromise: async () => Buffer.alloc(11 * 1024 * 1024, 'a'),
      contentType: 'application/json',
      resourceType: 'fetch',
    }),
  );
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  const record = records.find((row) => row.requestUrl === 'https://example.com/api/v3/huge');
  assert.equal(record?.outcome, 'skipped');
  assert.ok(record?.reason && /exceeds/.test(record.reason));
});

test('CF-02: a timed-out evidence body capture produces a terminal timeout record, not a hang', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  // Small responseBodyTimeoutMs (5th ctor arg) so the never-resolving body() promise below
  // rejects quickly and deterministically.
  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, 50, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  handlers.response(
    makeEvidenceResponse({
      url: 'https://example.com/api/v3/bonus/list',
      bodyPromise: () => new Promise<Buffer>(() => {
        /* stuck forever, simulating a hung evidence body fetch */
      }),
      contentType: 'application/json',
      resourceType: 'xhr',
    }),
  );

  const startedAt = Date.now();
  await observer.flush();
  const elapsedMs = Date.now() - startedAt;
  observer.stop();

  assert.ok(elapsedMs < 1000, `flush() took ${elapsedMs}ms, expected it to return near the 50ms body timeout`);
  const records = readEvidenceIndex(evidenceIndexPath);
  const record = records.find((row) => row.requestUrl === 'https://example.com/api/v3/bonus/list');
  assert.equal(record?.outcome, 'timeout');
});

test('CF-02: identical response bodies observed twice in one run are deduplicated by hash on disk', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page = makeFakePage(handlers);
  const sink = makeSink();
  const { evidenceDir, evidenceIndexPath } = makeEvidenceDirs();

  const observer = new PassiveNetworkObserver(page as never, sink, 'example.com', 1_000, undefined, {
    evidenceDir,
    evidenceIndexPath,
  });
  observer.start();

  const bodyText = '{"same":"body"}';
  for (const url of ['https://example.com/api/v3/a', 'https://example.com/api/v3/b']) {
    handlers.response(
      makeEvidenceResponse({
        url,
        bodyPromise: async () => Buffer.from(bodyText),
        contentType: 'application/json',
        resourceType: 'xhr',
      }),
    );
  }
  await observer.flush();
  observer.stop();

  const records = readEvidenceIndex(evidenceIndexPath);
  const captured = records.filter((row) => row.outcome === 'captured');
  assert.equal(captured.length, 2, 'expected one index record per observed response');
  assert.equal(captured[0]!.bodyPath, captured[1]!.bodyPath, 'identical bodies must dedupe to the same on-disk file');
  assert.equal(fs.readdirSync(evidenceDir).length, 1, 'only one body file should exist on disk for the duplicate content');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { PassiveNetworkObserver, type DiscoverySink } from './url-discovery.ts';
import type { RawUrlCandidate, SourceFamily } from './types.ts';

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
    body: () => bodyPromise,
    request: () => ({ resourceType: () => 'document' }),
    frame: () => ({ url: () => url }),
  };
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

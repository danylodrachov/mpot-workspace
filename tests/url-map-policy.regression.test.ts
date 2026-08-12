import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideUrl } from '../src/research/url-map-discovery/policy.ts';
import type { RawUrlCandidate } from '../src/research/url-map/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function candidate(url: string): RawUrlCandidate {
  return {
    rawUrl: url,
    baseUrl: url,
    provenance: {
      sourceFamily: 'dom_url_attribute',
      discoveredOn: url,
      label: 'fixture',
    },
    observedAt: '2026-08-12T00:00:00.000Z',
  };
}

function hostsFor(url: string): Set<string> {
  return new Set([new URL(url).hostname.toLowerCase()]);
}

test('candidate examples remain accepted while technical/private/item routes do not become visits', async () => {
  const fixture = JSON.parse(await readFile(path.join(here, 'fixtures/url-map-candidate-examples.json'), 'utf8')) as {
    accepted: string[];
    rejected: string[];
    tbd: string[];
  };

  for (const url of fixture.accepted) {
    const result = decideUrl(candidate(url), hostsFor(url));
    assert.equal(result.decision, 'accepted', `${url} -> ${result.ruleId}: ${result.reason}`);
  }
  for (const url of fixture.rejected) {
    const result = decideUrl(candidate(url), hostsFor(url));
    assert.equal(result.decision, 'rejected', `${url} -> ${result.ruleId}: ${result.reason}`);
  }
  for (const url of fixture.tbd) {
    const result = decideUrl(candidate(url), hostsFor(url));
    assert.equal(result.decision, 'tbd', `${url} -> ${result.ruleId}: ${result.reason}`);
  }
});

test('tracking parameters are removed but business query parameters and cashier hash routes survive', () => {
  const promo = 'https://example.test/en/bonus/rules?category=casino&utm_source=x&gclid=123';
  const promoResult = decideUrl(candidate(promo), hostsFor(promo));
  assert.equal(promoResult.decision, 'accepted');
  assert.equal(promoResult.canonicalUrl, 'https://example.test/en/bonus/rules?category=casino');

  const cashier = 'https://example.test/welcome-bonus#!/player/profile-cashier-withdraw';
  const cashierResult = decideUrl(candidate(cashier), hostsFor(cashier));
  assert.equal(cashierResult.decision, 'accepted');
  assert.match(cashierResult.canonicalUrl ?? '', /cashier-withdraw/);
});

test('nested sports routes normalize to canonical category roots and live filters do not survive as separate targets', () => {
  const nested = 'https://example.test/en/sport/football/england/premier-league';
  const nestedResult = decideUrl(candidate(nested), hostsFor(nested));
  assert.equal(nestedResult.decision, 'accepted');
  assert.equal(nestedResult.canonicalUrl, 'https://example.test/en/sport/football');
  assert.equal(nestedResult.navigationUrl, 'https://example.test/en/sport/football');

  const topLevel = 'https://example.test/en/football/live';
  const topLevelResult = decideUrl(candidate(topLevel), hostsFor(topLevel));
  assert.equal(topLevelResult.decision, 'accepted');
  assert.equal(topLevelResult.canonicalUrl, 'https://example.test/en/football');

  const live = 'https://example.test/en/live';
  const liveResult = decideUrl(candidate(live), hostsFor(live));
  assert.equal(liveResult.decision, 'rejected');
  assert.equal(liveResult.ruleId, 'URLR_REJECT_SPORTS_FILTER');
});

test('route-state query used only as a sports filter deduplicates to the product root', () => {
  const filtered = 'https://example.test/en/sport?bt-path=/live-section';
  const result = decideUrl(candidate(filtered), hostsFor(filtered));
  assert.equal(result.decision, 'accepted');
  assert.equal(result.canonicalUrl, 'https://example.test/en/sport');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAcceptedVisitFrontier } from './frontier.ts';
import type { UrlDecision } from './types.ts';

const p = { sourceFamily: 'external_script_url_token' as const, discoveredOn: 'https://example.test/en' };
const d = (decision: UrlDecision['decision'], canonicalUrl: string | undefined, rawUrl = canonicalUrl ?? '/x'): UrlDecision => ({
  rawUrl, resolvedUrl: rawUrl, canonicalUrl, decision,
  ruleId: `TEST_${decision}`, reason: 'fixture', provenance: [p],
});

test('technical/TBD/rejected candidates can never enter navigation frontier', () => {
  const result = buildAcceptedVisitFrontier([
    d('accepted', 'https://example.test/en/promo'),
    d('accepted', 'https://example.test/en/promo', '/promo-alias'),
    d('tbd', undefined, 'https://example.test/engine.io'),
    d('tbd', undefined, 'https://example.test/src/layout/DefaultLayout.vue'),
    d('rejected', undefined, 'https://example.test/'),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].canonicalUrl, 'https://example.test/en/promo');
  assert.equal(result[0].provenance.length, 1); // identical provenance is deduped
});

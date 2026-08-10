import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decideUrl } from './url-rules.ts';

const origin = 'https://example.com';
const allowedHostname = 'example.com';
const provenance = [{ sourceFamily: 'dom_url_attribute' as const, discoveredOn: `${origin}/` }];
const decide = (url: string) => decideUrl(url, `${origin}/`, allowedHostname, provenance);

test('keeps explicitly approved document routes', () => {
  assert.equal(decide('/bonuses').decision, 'accepted');
  assert.equal(decide('/deposit').decision, 'accepted');
  assert.equal(decide('/terms-and-conditions').decision, 'accepted');
});

test('drops explicitly rejected URL Rules examples', () => {
  assert.equal(decide('/casino/lobby').decision, 'rejected');
  assert.equal(decide('/casino/instant-games').decision, 'rejected');
  assert.equal(decide('/sports/lobby').decision, 'rejected');
  assert.equal(decide('/responsible-gaming').decision, 'rejected');
  assert.equal(decide('/self-exclusion').decision, 'rejected');
  assert.equal(decide('/transaction-history').decision, 'rejected');
  assert.equal(decide('/privacy-policy').decision, 'rejected');
  assert.equal(decide('/cookie-policy').decision, 'rejected');
  assert.equal(decide('/my-account/kyc').decision, 'rejected');
  assert.equal(decide('/support').decision, 'rejected');
  assert.equal(decide('/about').decision, 'rejected');
});

test('normalizes sports filters to canonical root category', () => {
  const result = decide('/football/live');
  assert.equal(result.decision, 'accepted');
  assert.equal(result.canonicalUrl, 'https://example.com/football');
  assert.equal(result.ruleId, 'URLR_KEEP_SPORT_CATEGORY_NORMALIZED');
});

test('keeps canonical casino categories but rejects nested individual routes', () => {
  assert.equal(decide('/casino/slots').decision, 'accepted');
  assert.equal(decide('/casino/live-casino').decision, 'accepted');
  assert.equal(decide('/casino/slots/some-game').decision, 'rejected');
});

test('does not invent rules for explicit TBD classes', () => {
  assert.equal(decide('/api/casino').decision, 'tbd');
  assert.equal(decide('/bundle.js').decision, 'tbd');
  assert.equal(decide('/login').decision, 'tbd');
  assert.equal(decide('/offers?lang=en').decision, 'tbd');
  assert.equal(decide('/offers#current').decision, 'tbd');
});

test('retains unmatched same-origin documents and rejects external origins', () => {
  assert.equal(decide('/licenses').decision, 'accepted');
  assert.equal(decide('/mobile').decision, 'accepted');
  assert.equal(decide('https://other.example/path').decision, 'rejected');
});

// Full URL Rules fixture sweep: every approved keep/drop/TBD/normalisation case
// from docs/casino-discovery/URL-rules.md, so a rule edit cannot silently move a
// route between visit classes.
test('URL Rules fixture cases classify as approved', async () => {
  const cases = JSON.parse(
    await readFile(new URL('./__fixtures__/url-rules-cases.json', import.meta.url), 'utf8'),
  ) as {
    accepted: string[];
    rejected: string[];
    tbd: string[];
    normalized: Record<string, string>;
  };

  for (const url of cases.accepted) assert.equal(decide(url).decision, 'accepted', url);
  for (const url of cases.rejected) assert.equal(decide(url).decision, 'rejected', url);
  for (const url of cases.tbd) assert.equal(decide(url).decision, 'tbd', url);
  for (const [raw, canonical] of Object.entries(cases.normalized)) {
    const result = decide(raw);
    assert.equal(result.decision, 'accepted', raw);
    assert.equal(result.canonicalUrl, `${origin}${canonical}`, raw);
  }
});

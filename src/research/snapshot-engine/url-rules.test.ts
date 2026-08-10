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

test('rejects unmatched same-origin documents (no implicit keep fallback) and rejects external origins', () => {
  assert.equal(decide('/licenses').decision, 'rejected');
  assert.equal(decide('/licenses').ruleId, 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN');
  assert.equal(decide('/mobile').decision, 'rejected');
  assert.equal(decide('https://other.example/path').decision, 'rejected');
});

test('locale-prefixed routes are normalized before classification', () => {
  assert.equal(decide('/en/casino/lobby').decision, 'rejected');
  assert.equal(decide('/en/privacy-policy').decision, 'rejected');
  const slots = decide('/en/casino/slots');
  assert.equal(slots.decision, 'accepted');
  assert.equal(slots.ruleId, 'URLR_KEEP_CASINO_CATEGORY');
  const football = decide('/en/football/live');
  assert.equal(football.decision, 'accepted');
  assert.equal(football.ruleId, 'URLR_KEEP_SPORT_CATEGORY_NORMALIZED');
  assert.equal(football.canonicalUrl, 'https://example.com/football');
  const deposit = decide('/en/deposit');
  assert.equal(deposit.decision, 'accepted');
  // Original (locale-prefixed) URL must be preserved, not lost, in the record.
  assert.equal(deposit.resolvedUrl, 'https://example.com/en/deposit');
  assert.equal(deposit.rawUrl, '/en/deposit');
});

test('the classic unmatched-fallback bug is fixed: /en/404 is not accepted', () => {
  const result = decide('/en/404');
  assert.notEqual(result.decision, 'accepted');
});

test('an existing TBD technical class remains tbd even when locale-prefixed', () => {
  const result = decide('/en/login');
  assert.equal(result.decision, 'tbd');
});

test('FIX-02: locale-aware routes and canonical product/sport/promotion shapes (ws43--westace.com example host)', () => {
  const westaceHost = 'ws43--westace.com';
  const westaceDecide = (url: string) => decideUrl(url, `https://${westaceHost}/`, westaceHost, provenance);

  assert.equal(westaceDecide('https://ws43--westace.com/en/payments').decision, 'accepted');
  assert.equal(westaceDecide('https://ws43--westace.com/en/rules').decision, 'accepted');
  assert.equal(westaceDecide('https://ws43--westace.com/en/live-casino').decision, 'accepted');
  assert.equal(westaceDecide('https://ws43--westace.com/en/virtual-sports').decision, 'accepted');
  assert.equal(westaceDecide('https://ws43--westace.com/en/promotions').decision, 'accepted');
  assert.equal(westaceDecide('https://ws43--westace.com/en/promotions/casino/daily-cashback-15').decision, 'accepted');

  const sportRoot = westaceDecide('https://ws43--westace.com/sport/football');
  assert.equal(sportRoot.decision, 'accepted');

  const sportNested = westaceDecide('https://ws43--westace.com/sport/football/england/premier-league');
  assert.equal(sportNested.decision, 'accepted');
  assert.equal(sportNested.canonicalUrl, 'https://ws43--westace.com/sport/football');
  assert.notEqual(sportNested.canonicalUrl, sportNested.resolvedUrl);

  assert.equal(westaceDecide('https://ws43--westace.com/game/some-slug').decision, 'rejected');
  assert.equal(westaceDecide('https://ws43--westace.com/api/casino').decision, 'tbd');
  assert.equal(westaceDecide('https://ws43--westace.com/bundle.js').decision, 'tbd');
  assert.equal(westaceDecide('https://ws43--westace.com/offers?lang=en').decision, 'tbd');
  assert.equal(westaceDecide('https://ws43--westace.com/offers#current').decision, 'tbd');

  // An arbitrary same-origin route must not be accepted just because no drop rule matched it.
  assert.equal(westaceDecide('https://ws43--westace.com/2').decision, 'rejected');
  assert.equal(westaceDecide('https://ws43--westace.com/2').ruleId, 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN');
});

test('FIX-02: promotions is a deterministic alias of the bonus/promo class across nesting depth', () => {
  assert.equal(decide('/promotions').decision, 'accepted');
  assert.equal(decide('/en/promotions').decision, 'accepted');
  assert.equal(decide('/promotions/casino').decision, 'accepted');
  assert.equal(decide('/promotions/casino/daily-cashback-15').decision, 'accepted');
  assert.equal(decide('/en/promotions/casino/daily-cashback-15').decision, 'accepted');
});

test('FIX-02: bare and /casino/-nested product-category shapes are equivalent, across multiple locales', () => {
  for (const locale of ['en', 'de', 'fr', 'pt-BR']) {
    for (const category of ['slots', 'live-casino', 'virtual-sports']) {
      const bare = decide(`/${locale}/${category}`);
      assert.equal(bare.decision, 'accepted', `/${locale}/${category}`);
      assert.equal(bare.canonicalUrl, `https://example.com/casino/${category}`, `/${locale}/${category}`);

      const nested = decide(`/${locale}/casino/${category}`);
      assert.equal(nested.decision, 'accepted', `/${locale}/casino/${category}`);
      assert.equal(nested.canonicalUrl, `https://example.com/casino/${category}`, `/${locale}/casino/${category}`);
    }
  }
});

test('FIX-02: /sport/<category> roots accepted, nested routes normalized, across multiple locales and sports', () => {
  const cases: Array<[string, string]> = [
    ['/sport/football', '/sport/football'],
    ['/en/sport/football', '/sport/football'],
    ['/sport/football/england/premier-league', '/sport/football'],
    ['/en/sport/football/england/premier-league', '/sport/football'],
    ['/sport/basketball/north-america/nba', '/sport/basketball'],
    ['/de/sport/basketball/north-america/nba', '/sport/basketball'],
    ['/sport/tennis/atp/roland-garros', '/sport/tennis'],
    ['/fr-FR/sport/tennis/atp/roland-garros', '/sport/tennis'],
  ];
  for (const [raw, canonical] of cases) {
    const result = decide(raw);
    assert.equal(result.decision, 'accepted', raw);
    assert.equal(result.canonicalUrl, `https://example.com${canonical}`, raw);
  }
});

test('FIX-02: individual game/event pages remain rejected regardless of locale', () => {
  assert.equal(decide('/game/some-slug').decision, 'rejected');
  assert.equal(decide('/en/game/some-slug').decision, 'rejected');
  assert.equal(decide('/event/12345').decision, 'rejected');
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

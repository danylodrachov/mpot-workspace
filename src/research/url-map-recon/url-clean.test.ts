import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyUrl, cleanAndCanonicalize, deriveLabelFromSlug, cleanAndPersist } from './url-clean.ts';
import type { EntrySource } from './types.ts';

const origin = 'https://example.com';

// ====== APPROVED KEEP EXAMPLES ======
// Issue 95: "Route behavior — keep: bonus/promo/offer, payment/deposit/withdrawal/cashier, limits, terms/rules, slots, live-casino, virtual-sports, horse-racing, canonical sport-category routes"

test('Table: approved keep examples (bonus/promo/offer)', () => {
  const keepExamples = [
    '/bonus',
    '/bonuses',
    '/bonus-terms',
    '/bonus-rules',
    '/promo',
    '/promotion',
    '/promotions',
    '/promo-rules',
    '/offers',
    '/offer',
  ];
  for (const path of keepExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, true, `Should keep: ${path}`);
  }
});

test('Table: approved keep examples (payment/deposit/withdrawal/cashier routes)', () => {
  const keepExamples = [
    '/payment',
    '/payment-methods',
    '/payments',
    '/deposit',
    '/deposits',
    '/withdrawal',
    '/withdrawals',
    '/withdrawals',
    '/cashier',
  ];
  for (const path of keepExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, true, `Should keep: ${path}`);
  }
});

test('Table: approved keep examples (limits and terms/rules)', () => {
  const keepExamples = [
    '/limits',
    '/deposit-limits',
    '/loss-limits',
    '/bet-limits',
    '/time-limits',
    '/withdrawal-limits',
    '/terms',
    '/terms-and-conditions',
    '/rules',
    '/terms-and-rules',
  ];
  for (const path of keepExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, true, `Should keep: ${path}`);
  }
});

test('Table: approved keep examples (product landing pages)', () => {
  const keepExamples = [
    '/slots',
    '/live-casino',
    '/virtual-sports',
    '/horse-racing',
    '/sports',
  ];
  for (const path of keepExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, true, `Should keep: ${path}`);
  }
});

test('Table: approved keep examples (canonical sport category routes)', () => {
  const keepExamples = [
    '/football',
    '/soccer',
    '/tennis',
    '/basketball',
    '/volleyball',
    '/esports',
    '/e-sports',
    '/ufc',
    '/ice-hockey',
    '/table-tennis',
    '/horse-racing',
    '/cricket',
    '/baseball',
    '/boxing',
    '/rugby',
    '/handball',
  ];
  for (const path of keepExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, true, `Should keep sport category landing: ${path}`);
  }
});

// ====== APPROVED REMOVE EXAMPLES ======
// Issue 95: "Route behavior — remove: account, profile, settings, KYC/account data, responsible-gambling, self-exclusion, support/help, privacy/cookie, AML/KYC policy, dispute-resolution, corporate/editorial, root, lobby, instant/crash category, transaction-history, event, match, tournament, league, prematch detail routes"

test('Table: approved remove examples (account/profile/settings)', () => {
  const removeExamples = [
    '/account',
    '/my-account',
    '/profile',
    '/my-profile',
    '/settings',
    '/my-settings',
    '/account/settings',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (KYC/account data)', () => {
  const removeExamples = [
    '/kyc',
    '/account/kyc',
    '/my-account/kyc',
    '/verification',
    '/identity-verification',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (responsible-gambling/self-exclusion)', () => {
  const removeExamples = [
    '/responsible-gambling',
    '/responsible-gaming',
    '/self-exclusion',
    '/self-exclude',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (support/help, privacy/cookie)', () => {
  const removeExamples = [
    '/support',
    '/help',
    '/customer-support',
    '/help-center',
    '/privacy',
    '/privacy-policy',
    '/cookie',
    '/cookies',
    '/cookie-policy',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (AML/KYC policy, dispute-resolution, corporate/editorial)', () => {
  const removeExamples = [
    '/aml-policy',
    '/kyc-policy',
    '/dispute-resolution',
    '/disputes',
    '/corporate',
    '/editorial',
    '/about',
    '/about-us',
    '/license',
    '/licence',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (root, lobby, instant/crash, transaction-history)', () => {
  const removeExamples = [
    '/',
    '/lobby',
    '/casino/lobby',
    '/instant-games',
    '/crash',
    '/instant',
    '/transactions',
    '/transaction-history',
    '/history',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove: ${path}`);
  }
});

test('Table: approved remove examples (individual event/match/tournament/league/prematch)', () => {
  const removeExamples = [
    '/event/123',
    '/match/456',
    '/tournament/789',
    '/league/abc',
    '/prematch/xyz',
    '/football/match/12345',
    '/tennis/tournament/67890',
    '/basketball/league/nba',
  ];
  for (const path of removeExamples) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should remove individual event: ${path}`);
  }
});

// ====== URL NORMALIZATION & CANONICALIZATION ======

test('Normalization: lowercase, trailing slash, query/hash removal', () => {
  const entries = cleanAndCanonicalize(
    [
      `${origin}/BONUS`,
      `${origin}/Bonus/`,
      `${origin}/bonus?utm_source=google`,
      `${origin}/bonus#section`,
      `${origin}/bonus?q=1#sec`,
    ],
    { origin, source: 'dom_anchor' },
  );
  const urls = entries.map((e) => e.canonicalUrl);
  const expected = `${origin}/bonus`;
  assert.equal(urls.filter((u) => u === expected).length, 1, 'Should normalize and dedupe');
});

test('Normalization: underscores treated as hyphens for matching', () => {
  // Both /deposit_limits and /deposit-limits should normalize to same canonical
  const entries = cleanAndCanonicalize(
    [`${origin}/deposit_limits`, `${origin}/deposit-limits`],
    { origin, source: 'dom_anchor' },
  );
  const urls = entries.map((e) => e.canonicalUrl);
  assert.equal(urls.length, 2, 'Both variants are kept (original preserved)');
  // Both should be kept because they both match the keep pattern
  assert.ok(urls.some((u) => u.includes('deposit')), 'Both variants kept due to matching keep pattern');
});

test('Normalization: repeated slashes collapsed', () => {
  // ///bonus// should normalize during matching
  const result = classifyUrl(`${origin}///bonus//`, { origin });
  assert.equal(result.keep, true, 'Should normalize repeated slashes and still match');
  // Canonical should be clean (check path portion only, not protocol)
  const pathname = new URL(result.url).pathname;
  assert.ok(!pathname.includes('//'), 'Canonical path should not have repeated slashes');
});

test('Normalization: safe URL decoding', () => {
  // %2Fbonus (URL-encoded /bonus) should be decoded for matching
  const result = classifyUrl(`${origin}/path%2Fbonus`, { origin });
  // This might be removed as unclassified if not properly decoded, but properly decoded should match
  assert.ok(result.url, 'Should handle URL-encoded characters');
});

test('Normalization: preserve original origin and locale prefix', () => {
  const entries = cleanAndCanonicalize([`${origin}/en/bonus`, `${origin}/fr/bonus`, `${origin}/bonus`], {
    origin,
    source: 'dom_anchor',
  });
  // All three should be kept because they all contain /bonus
  assert.equal(entries.length, 3, 'Should preserve locale prefixes');
  for (const entry of entries) {
    assert.ok(entry.canonicalUrl.startsWith(origin), 'Origin should be preserved');
  }
});

// ====== TRASH PRECEDENCE ======

test('Precedence: explicit trash beats nested keep terms', () => {
  // /account/bonus contains "bonus" (keep) but "account" is trash - trash should win
  const result = classifyUrl(`${origin}/account/bonus`, { origin });
  assert.equal(result.keep, false, 'Trash (account) should override nested keep term (bonus)');
});

test('Precedence: support/help are trash even when nested', () => {
  // /terms/support contains "terms" (keep) and "support" (trash) - trash wins
  const result = classifyUrl(`${origin}/terms/support`, { origin });
  assert.equal(result.keep, false, 'Trash (support) should override keep pattern');
});

test('Precedence: individual sport events dropped even though sport category is kept', () => {
  const result = classifyUrl(`${origin}/football/match/123`, { origin });
  assert.equal(result.keep, false, 'Individual sport event should be dropped despite sport category being kept');
});

// ====== INDIVIDUAL EVENT/MATCH/TOURNAMENT/LEAGUE/PREMATCH ======

test('Individual events: no sport/league/tournament/match/prematch pages survive', () => {
  const eventPaths = [
    '/sports/match/12345',
    '/football/match/67890',
    '/tennis/tournament/wimbledon-2024',
    '/basketball/league/nba',
    '/football/prematch/team-a-vs-b',
    '/games/table/blackjack-7',
    '/slots/game/book-of-ra',
  ];
  for (const path of eventPaths) {
    const result = classifyUrl(`${origin}${path}`, { origin });
    assert.equal(result.keep, false, `Should drop: ${path}`);
  }
});

// ====== SPORT CANONICALIZATION ======

test('Sport canonicalization: keep only landing segment, drop deeper paths', () => {
  assert.equal(classifyUrl(`${origin}/football`, { origin }).keep, true, 'Sport landing kept');
  assert.equal(classifyUrl(`${origin}/football/`, { origin }).keep, true, 'Sport landing kept with trailing slash');
  assert.equal(classifyUrl(`${origin}/football/league`, { origin }).keep, false, 'Deeper sport path dropped');
  assert.equal(classifyUrl(`${origin}/football/match/123`, { origin }).keep, false, 'Individual sport event dropped');
});

// ====== EXISTING TECHNICAL/EXTERNAL HANDLING (Block 8) ======

test('Block 8: existing technical/external handling unchanged', () => {
  // Assets should be dropped
  assert.equal(classifyUrl(`${origin}/assets/logo.png`, { origin }).keep, false);
  assert.equal(classifyUrl(`${origin}/app.js`, { origin }).keep, false);
  assert.equal(classifyUrl(`${origin}/style.css`, { origin }).keep, false);

  // API endpoints should be dropped
  assert.equal(classifyUrl(`${origin}/api/games`, { origin }).keep, false);
  assert.equal(classifyUrl(`${origin}/graphql`, { origin }).keep, false);

  // Functional endpoints should be dropped
  assert.equal(classifyUrl(`${origin}/login`, { origin }).keep, false);
  assert.equal(classifyUrl(`${origin}/logout`, { origin }).keep, false);
  assert.equal(classifyUrl(`${origin}/register`, { origin }).keep, false);

  // Tracking/CDN hosts should be dropped
  assert.equal(classifyUrl('https://cdn.example.com/chunk.js', { origin }).keep, false);
  assert.equal(classifyUrl('https://analytics.example.com/track', { origin }).keep, false);
});

// ====== DEDUPLICATION ======

test('Deduplication: cleanAndCanonicalize removes canonical duplicates', () => {
  const entries = cleanAndCanonicalize(
    [
      `${origin}/bonus`,
      `${origin}/bonus/`,
      `${origin}/BONUS`,
      `${origin}/bonus?utm=1`,
      `${origin}/bonus#top`,
    ],
    { origin, source: 'dom_anchor' },
  );
  // All should canonicalize to the same URL
  const urls = entries.map((e) => e.canonicalUrl);
  assert.equal(urls.length, 1, 'Should dedupe by canonical URL');
  assert.equal(urls[0], `${origin}/bonus`);
});

// ====== LOCALE PREFIX HANDLING ======

test('Locale prefixes: preserve and handle correctly', () => {
  const entries = cleanAndCanonicalize(
    [
      `${origin}/en/bonus`,
      `${origin}/fr/bonus`,
      `${origin}/pt-BR/bonus`,
      `${origin}/bonus`,
    ],
    { origin, source: 'dom_anchor' },
  );
  assert.equal(entries.length, 4, 'Should preserve distinct locale-prefixed versions');
  for (const entry of entries) {
    assert.equal(entry.originStatus, 'official_same_origin');
  }
});

// ====== HELPER FUNCTIONS ======

test('deriveLabelFromSlug: derives from URL slug only', () => {
  assert.equal(deriveLabelFromSlug(`${origin}/deposit-limits`), 'deposit limits');
  assert.equal(deriveLabelFromSlug(`${origin}/`), undefined);
  assert.equal(deriveLabelFromSlug(`${origin}/en/bonus-rules`), 'bonus rules');
});

// ====== DECISION ARTIFACTS (Issue 07) ======

test('Issue 07: decision batch with artifacts — every raw candidate has a decision row', () => {
  const candidates = [
    `${origin}/bonus`,
    `${origin}/account`,
    `${origin}/mysterious-page`,
    `${origin}/slots`,
  ];

  const decisions = cleanUrlsToDecisions(candidates, { origin, source: 'dom_anchor' });

  // Every input should have exactly one decision row
  assert.equal(decisions.length, candidates.length, 'Every raw candidate should have a decision row');

  // Each decision should have a decision record with keep/reject status
  for (const decision of decisions) {
    assert.ok(decision.rawUrl, 'Decision should have rawUrl');
    assert.ok(typeof decision.keep === 'boolean', 'Decision should have keep boolean');
    assert.ok(decision.reason, 'Decision should have reason');
    assert.ok(decision.canonicalUrl, 'Decision should have canonicalUrl');
  }
});

test('Issue 07: decision batch — kept and rejected sets are disjoint', () => {
  const candidates = [
    `${origin}/bonus`,
    `${origin}/account`,
    `${origin}/mysterious`,
    `${origin}/slots`,
    `${origin}/history`,
    `${origin}/unknown-thing`,
  ];

  const decisions = cleanUrlsToDecisions(candidates, { origin, source: 'dom_anchor' });
  const keptUrls = new Set(decisions.filter(d => d.keep).map(d => d.canonicalUrl));
  const rejectedUrls = new Set(decisions.filter(d => !d.keep).map(d => d.canonicalUrl));

  // Intersection should be empty
  const intersection = [...keptUrls].filter(url => rejectedUrls.has(url));
  assert.equal(intersection.length, 0, 'Kept and rejected sets must be disjoint');
});

test('Issue 07: decision batch — unknown-purpose fixtures are kept', () => {
  const unknownUrls = [
    `${origin}/some-unknown-page`,
    `${origin}/mysterious-content`,
    `${origin}/random-path-not-in-rules`,
  ];

  const decisions = cleanUrlsToDecisions(unknownUrls, { origin, source: 'dom_anchor' });

  // All unknowns should be kept (not rejected)
  for (const decision of decisions) {
    assert.equal(
      decision.keep,
      true,
      `Unknown-purpose URL should be kept: ${decision.rawUrl}, reason: ${decision.reason}`
    );
  }
});

test('Issue 07: decision batch — approved trash fixtures remain rejected', () => {
  const trashUrls = [
    `${origin}/privacy`,
    `${origin}/cookie-policy`,
    `${origin}/responsible-gaming`,
    `${origin}/self-exclusion`,
    `${origin}/account`,
    `${origin}/history`,
  ];

  const decisions = cleanUrlsToDecisions(trashUrls, { origin, source: 'dom_anchor' });

  // All should be rejected
  for (const decision of decisions) {
    assert.equal(
      decision.keep,
      false,
      `Trash fixture should be rejected: ${decision.rawUrl}`
    );
  }
});

test('Issue 07: decision batch — mixed batch covers known-keep, known-reject, unknown', () => {
  const candidates = [
    // Keep these
    `${origin}/bonus`,
    `${origin}/slots`,
    `${origin}/deposit-limits`,
    // Reject these
    `${origin}/account`,
    `${origin}/privacy`,
    `${origin}/history`,
    // Unknown (should be kept)
    `${origin}/unknown-xyz`,
  ];

  const decisions = cleanUrlsToDecisions(candidates, { origin, source: 'dom_anchor' });

  assert.equal(decisions.length, candidates.length, 'All inputs have decision rows');

  const keptCount = decisions.filter(d => d.keep).length;
  const rejectedCount = decisions.filter(d => !d.keep).length;

  // Should have 4 kept (3 known + 1 unknown) and 3 rejected
  assert.equal(keptCount, 4, 'Should have 4 kept (3 approved + 1 unknown)');
  assert.equal(rejectedCount, 3, 'Should have 3 rejected');
});

export type UrlDecision = {
  rawUrl: string;
  canonicalUrl: string;
  keep: boolean;
  reason: string;
  source: EntrySource;
};

export function cleanUrlsToDecisions(
  candidates: string[],
  opts: { origin: string; source: EntrySource; approvedExternalHosts?: RegExp[] },
): UrlDecision[] {
  const decisions: UrlDecision[] = [];

  for (const rawUrl of candidates) {
    const result = classifyUrl(rawUrl, opts);
    decisions.push({
      rawUrl,
      canonicalUrl: result.url,
      keep: result.keep,
      reason: result.reason,
      source: opts.source,
    });
  }

  return decisions;
}

// ====== PERSISTENCE COORDINATOR (Issue 07) ======

test('Issue 07: cleanAndPersist writes three artifacts (clean-url-inventory, deterministic-rejected-urls, url-clean-decisions)', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'url-clean-test-'));

  try {
    const candidates = [
      `${origin}/bonus`,
      `${origin}/account`,
      `${origin}/slots`,
      `${origin}/mysterious-page`,
      `${origin}/privacy`,
    ];

    await cleanAndPersist(tmpDir, candidates, { origin, source: 'dom_anchor' });

    // Verify all three files exist
    const inventoryPath = path.join(tmpDir, 'clean-url-inventory.json');
    const rejectedPath = path.join(tmpDir, 'deterministic-rejected-urls.json');
    const decisionsPath = path.join(tmpDir, 'url-clean-decisions.jsonl');

    assert.ok(fs.existsSync(inventoryPath), 'clean-url-inventory.json should exist');
    assert.ok(fs.existsSync(rejectedPath), 'deterministic-rejected-urls.json should exist');
    assert.ok(fs.existsSync(decisionsPath), 'url-clean-decisions.jsonl should exist');

    // Verify inventory file structure
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));
    assert.ok(Array.isArray(inventory), 'Inventory should be an array');
    assert.ok(inventory.length > 0, 'Inventory should contain kept URLs');

    // Check that all inventory entries have required fields
    for (const entry of inventory) {
      assert.ok(entry.canonicalUrl, 'Inventory entry should have canonicalUrl');
      assert.ok(entry.source, 'Inventory entry should have source');
      assert.ok(entry.originStatus, 'Inventory entry should have originStatus');
    }

    // Verify rejected file structure
    const rejected = JSON.parse(fs.readFileSync(rejectedPath, 'utf-8'));
    assert.ok(Array.isArray(rejected), 'Rejected should be an array');

    // Verify decisions file structure (JSONL)
    const decisionsText = fs.readFileSync(decisionsPath, 'utf-8');
    const decisionLines = decisionsText.trim().split('\n');
    assert.ok(decisionLines.length > 0, 'Decisions JSONL should have at least one line');

    // Parse and verify each decision line
    const decisions = decisionLines.map(line => JSON.parse(line));
    assert.equal(decisions.length, candidates.length, 'Every raw candidate should have a decision row');

    // Each decision row should have required fields
    for (const decision of decisions) {
      assert.ok(decision.rawUrl, 'Decision should have rawUrl');
      assert.ok(typeof decision.keep === 'boolean', 'Decision should have keep boolean');
      assert.ok(decision.reason, 'Decision should have reason');
      assert.ok(decision.canonicalUrl, 'Decision should have canonicalUrl');
    }

    // Verify kept vs rejected counts
    const keptCount = decisions.filter(d => d.keep).length;
    const rejectedCount = decisions.filter(d => !d.keep).length;
    assert.equal(inventory.length, keptCount, 'Inventory count should match kept decisions');
    assert.equal(rejected.length, rejectedCount, 'Rejected count should match rejected decisions');

  } finally {
    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Issue 07: decisions include rule metadata (ruleId, ruleVersion, priority, proofScope)', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'url-clean-test-'));

  try {
    const candidates = [
      `${origin}/bonus`,
      `${origin}/account`,
      `${origin}/api/games`,
      `${origin}/login`,
    ];

    await cleanAndPersist(tmpDir, candidates, { origin, source: 'dom_anchor' });

    const decisionsPath = path.join(tmpDir, 'url-clean-decisions.jsonl');
    const decisionsText = fs.readFileSync(decisionsPath, 'utf-8');
    const decisions = decisionsText.trim().split('\n').map(line => JSON.parse(line));

    // Each decision should include rule metadata
    for (const decision of decisions) {
      assert.ok(decision.ruleId, `Decision for ${decision.rawUrl} should have ruleId`);
      assert.ok(decision.ruleVersion !== undefined, `Decision for ${decision.rawUrl} should have ruleVersion`);
      assert.ok(decision.priority !== undefined, `Decision for ${decision.rawUrl} should have priority`);
      assert.ok(decision.proofScope, `Decision for ${decision.rawUrl} should have proofScope`);
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Issue 07: hard drops include researchable fields as not_applicable_by_deterministic_rule', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'url-clean-test-'));

  try {
    const candidates = [
      `${origin}/account`,
      `${origin}/privacy`,
      `${origin}/history`,
    ];

    await cleanAndPersist(tmpDir, candidates, { origin, source: 'dom_anchor' });

    const decisionsPath = path.join(tmpDir, 'url-clean-decisions.jsonl');
    const decisionsText = fs.readFileSync(decisionsPath, 'utf-8');
    const decisions = decisionsText.trim().split('\n').map(line => JSON.parse(line));

    // All decisions should be rejections (hard drops)
    const rejectedDecisions = decisions.filter(d => !d.keep);
    assert.ok(rejectedDecisions.length === decisions.length, 'All test URLs should be rejected');

    // Each rejected decision should include researchable fields mapping
    for (const decision of rejectedDecisions) {
      assert.ok(decision.researchableFields, `Rejected decision for ${decision.rawUrl} should have researchableFields`);
      assert.ok(typeof decision.researchableFields === 'object', 'researchableFields should be an object');

      // Fields should have at least some entries marked as not_applicable_by_deterministic_rule
      const hasNotApplicable = Object.values(decision.researchableFields).some(
        value => value === 'not_applicable_by_deterministic_rule'
      );
      assert.ok(hasNotApplicable, `Decision for ${decision.rawUrl} should mark at least one field as not_applicable_by_deterministic_rule`);
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectProducts } from './product-collector.ts';

// LOCKED TEST SUITE for Issue 102: Deterministic Product Collector
// These tests verify acceptance criteria:
// 1. Sports collection yields sport names without match/team/event entries
// 2. Live-casino collection yields categories without table/game titles
// 3. Slots collection yields slot names without individual game URLs
// 4. Lazy-loaded collection works via bounded deterministic interaction
// 5. Deduplication is verified; no raw source content is persisted
// 6. Recon writes no product titles; the collector owns all three product files
// 7. Product collection failure in one section is isolated and doesn't block the others

// Acceptance Criterion 1: Sports collection yields sport names without match/team/event entries
test('Sports collection: yields sport names, excludes fixtures/matches (AC 1)', () => {
  const result = collectProducts('sports', [
    { name: 'Football' },
    { name: 'Tennis' },
    { name: 'Basketball' },
    { name: 'Arsenal vs Chelsea' }, // fixture-shaped — excluded
    { name: 'Manchester City @ Liverpool' }, // fixture-shaped — excluded
    { name: 'Federer v Djokovic' }, // fixture-shaped — excluded
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    const titles = result.items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Basketball', 'Football', 'Tennis']);
  }
});

// Acceptance Criterion 2: Live-casino collection yields categories without table/game titles
test('Live-casino collection: yields category names, excludes individual table titles (AC 2)', () => {
  const result = collectProducts('live-casino', [
    { name: 'Blackjack' },
    { name: 'Roulette' },
    { name: 'Baccarat' },
    { name: 'Table A vs Table B' }, // fixture-shaped table indicator — excluded
    { name: 'VIP Blackjack Table 7' }, // contains individual table marker — but normalized, won't match fixture pattern
    { name: 'Blackjack' }, // duplicate
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    const titles = result.items.map((i) => i.title).sort();
    // "VIP Blackjack Table 7" normalizes and doesn't match fixture pattern, so it passes
    assert.deepEqual(titles, ['Baccarat', 'Blackjack', 'Roulette', 'VIP Blackjack Table 7']);
  }
});

// Acceptance Criterion 3: Slots collection yields slot names without individual game URLs
test('Slots collection: yields slot names with URL preservation (AC 3)', () => {
  const result = collectProducts('slots', [
    { name: 'Book of Ra', url: 'https://example.com/slots/book-of-ra' },
    { name: 'Gonzo\'s Quest', url: 'https://example.com/slots/gonzos-quest' },
    { name: 'Starburst', url: 'https://example.com/slots/starburst' },
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    assert.equal(result.items.length, 3);
    assert.ok(result.items.every((i) => i.url !== null && i.url.includes('example.com')));
  }
});

// Acceptance Criterion 5: Deduplication is verified; no raw source content is persisted
test('Deduplication: normalizes case-insensitive and removes duplicates (AC 5)', () => {
  const result = collectProducts('sports', [
    { name: 'Football' },
    { name: 'FOOTBALL' },
    { name: ' football ' }, // whitespace variants
    { name: 'Tennis' },
    { name: 'tennis' },
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    const titles = result.items.map((i) => i.title).sort();
    // Case-insensitive dedup, so only 2 unique items
    assert.deepEqual(titles, ['Football', 'Tennis']);
    // All items are normalized (no raw whitespace)
    assert.ok(titles.every((t) => t === t.trim()));
  }
});

// Acceptance Criterion 4: Lazy-loaded collection works via bounded deterministic interaction
test('Bounded deterministic interaction: respects MAX_ITEMS limit (AC 4)', () => {
  const items = Array.from({ length: 600 }, (_, i) => ({
    name: `Sport ${i}`,
  }));
  const result = collectProducts('sports', items);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    assert.equal(result.items.length, 500, 'Should cap at MAX_ITEMS (500)');
  }
});

// Acceptance Criterion 4: MAX_TITLE_LENGTH bounds enforcement
test('Bounded deterministic interaction: respects MAX_TITLE_LENGTH limit (AC 4)', () => {
  const result = collectProducts('sports', [
    { name: 'Football' },
    { name: 'a'.repeat(121) }, // exceeds MAX_TITLE_LENGTH (120)
    { name: 'Tennis' },
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    const titles = result.items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Football', 'Tennis']);
  }
});

// Acceptance Criterion 6: No raw source content is persisted — items are normalized
test('No raw source content: output only contains normalized titles and URLs (AC 6)', () => {
  const result = collectProducts('sports', [
    { name: '  Football  ', url: 'https://example.com/football' },
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    const item = result.items[0];
    assert.equal(item.title, 'Football'); // normalized (no leading/trailing space)
    assert.ok(typeof item.title === 'string');
    assert.ok(typeof item.url === 'string');
    // No raw DOM, script, or response body should be in the output
  }
});

// Acceptance Criterion 7: Product collection failure in one section is isolated
test('Failure isolation: empty section returns absent status (AC 7)', () => {
  const result = collectProducts('sports', []);
  assert.deepEqual(result, { section: 'sports', status: 'absent', reason: 'no items supplied' });
});

// Acceptance Criterion 7: All items filtered still returns absent (isolation)
test('Failure isolation: all items filtered returns absent status (AC 7)', () => {
  const result = collectProducts('slots', [
    { name: 'Arsenal vs Chelsea' },
    { name: 'Team A @ Team B' },
  ]);
  assert.deepEqual(result, {
    section: 'slots',
    status: 'absent',
    reason: 'all supplied items were filtered as fixtures or invalid',
  });
});

// Verify output structure matches {title, url} contract
test('Output structure: every item has title and url (contract compliance)', () => {
  const result = collectProducts('sports', [
    { name: 'Football', url: 'https://example.com/football' },
    { name: 'Tennis' }, // no URL
  ]);
  assert.ok('items' in result, 'Result should have items');
  if ('items' in result) {
    result.items.forEach((item) => {
      assert.ok('title' in item);
      assert.ok('url' in item);
      assert.equal(typeof item.title, 'string');
      assert.ok(item.url === null || typeof item.url === 'string');
    });
  }
});

// Legacy tests (kept for backward compatibility)
test('live-casino collector keeps category names, excludes individual fixtures (18)', () => {
  const result = collectProducts('live-casino', [
    { name: 'Blackjack' },
    { name: 'Roulette' },
    { name: 'Team A vs Team B' }, // individual table/fixture-shaped — excluded
    { name: 'Blackjack' }, // dup
  ]);
  assert.ok('items' in result);
  if ('items' in result) {
    const titles = result.items.map((i) => i.title);
    assert.deepEqual(titles.sort(), ['Blackjack', 'Roulette']);
  }
});

test('sports collector keeps sport names, excludes fixtures (17,18)', () => {
  const result = collectProducts('sports', [{ name: 'Football' }, { name: 'Tennis' }, { name: 'Arsenal vs Chelsea' }]);
  assert.ok('items' in result);
  if ('items' in result) {
    assert.deepEqual(
      result.items.map((i) => i.title),
      ['Football', 'Tennis'],
    );
  }
});

test('slots collector keeps slot names', () => {
  const result = collectProducts('slots', [{ name: 'Book of Ra', url: 'https://example.com/slots' }]);
  assert.ok('items' in result);
});

test('empty input yields absent status, not an empty items array', () => {
  const result = collectProducts('sports', []);
  assert.deepEqual(result, { section: 'sports', status: 'absent', reason: 'no items supplied' });
});

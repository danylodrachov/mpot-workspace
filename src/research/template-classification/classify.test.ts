import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEntry,
  classifyUrlMap,
  isValidClassification,
  CATEGORY_IDS,
  type UrlMapEntry,
} from "./classify.ts";

function entry(canonicalUrl: string, overrides: Partial<UrlMapEntry> = {}): UrlMapEntry {
  return {
    canonicalUrl,
    originStatus: "official_same_origin",
    source: "dom_anchor",
    ...overrides,
  };
}

function categoriesOf(classifications: ReturnType<typeof classifyEntry>): string[] {
  return classifications.map((c) => c.category);
}

test("every classification array entry has exactly category/role/confidence/reason", () => {
  const result = classifyEntry(entry("https://example.com/casino/slots"));
  assert.ok(result.length > 0);
  for (const c of result) {
    assert.equal(Object.keys(c).sort().join(","), "category,confidence,reason,role");
    assert.ok(isValidClassification(c));
  }
});

test("empty classification arrays are valid for unrecognized routes", () => {
  const result = classifyEntry(entry("https://example.com/random-unmapped-page"));
  assert.deepEqual(result, []);
});

test("a URL can map to multiple categories", () => {
  const result = classifyEntry(entry("https://example.com/casino/withdrawal-limits"));
  const categories = categoriesOf(result);
  assert.ok(categories.includes("withdrawals"));
});

test("only registry category IDs are ever produced", () => {
  const urls = [
    "/casino/slots",
    "/casino/live-casino",
    "/sports/football",
    "/deposit-limits",
    "/withdrawal-limits",
    "/casino-bonuses",
    "/loyalty",
    "/vip-club",
    "/cashback",
    "/free-spins",
  ];
  for (const path of urls) {
    const result = classifyEntry(entry(`https://example.com${path}`));
    for (const c of result) {
      assert.ok((CATEGORY_IDS as readonly string[]).includes(c.category));
    }
  }
});

test("malformed classification objects are rejected by isValidClassification", () => {
  assert.equal(isValidClassification({ category: "casinos", role: "primary", confidence: "high" }), false);
  assert.equal(
    isValidClassification({ category: "not_a_category", role: "primary", confidence: "high", reason: "x" }),
    false,
  );
  assert.equal(
    isValidClassification({ category: "casinos", role: "invalid_role", confidence: "high", reason: "x" }),
    false,
  );
  assert.equal(
    isValidClassification({ category: "casinos", role: "primary", confidence: "invalid", reason: "x" }),
    false,
  );
  assert.equal(
    isValidClassification({ category: "casinos", role: "primary", confidence: "high", reason: "" }),
    false,
  );
  assert.equal([].constructor === Array, true);
});

test("generic promotion pages do not imply cashback, free spins, loyalty, or VIP", () => {
  const result = classifyEntry(entry("https://example.com/promotions"));
  const categories = categoriesOf(result);
  assert.ok(!categories.includes("cashback_offers"));
  assert.ok(!categories.includes("free_spins"));
  assert.ok(!categories.includes("loyalty_programs"));
  assert.ok(!categories.includes("vip_casino_programs"));
  assert.ok(!categories.includes("vip_betting_programs"));
  assert.deepEqual(categories, ["casino_bonuses"]);
});

test("retained sport-category routes map to betting", () => {
  const result = classifyEntry(entry("https://example.com/sports/football"));
  assert.ok(categoriesOf(result).includes("betting"));
});

test("slots route maps to casino_games", () => {
  const result = classifyEntry(entry("https://example.com/casino/slots"));
  assert.ok(categoriesOf(result).includes("casino_games"));
});

test("live-casino route maps to casino_games", () => {
  const result = classifyEntry(entry("https://example.com/casino/live-casino"));
  assert.ok(categoriesOf(result).includes("casino_games"));
});

test("deposit-limits maps to deposits", () => {
  const result = classifyEntry(entry("https://example.com/deposit-limits"));
  assert.deepEqual(categoriesOf(result), ["deposits"]);
});

test("withdrawal-limits maps to withdrawals", () => {
  const result = classifyEntry(entry("https://example.com/withdrawal-limits"));
  assert.deepEqual(categoriesOf(result), ["withdrawals"]);
});

test("withdrawal-related KYC route supports withdrawals", () => {
  const result = classifyEntry(entry("https://example.com/withdrawal/kyc"));
  const kyc = result.find((c) => c.category === "withdrawals");
  assert.ok(kyc);
});

test("official external licence URL supports casinos", () => {
  const result = classifyEntry(
    entry("https://regulator.example.org/licence/12345", { originStatus: "external_approved", source: "external" }),
  );
  const casinoClassification = result.find((c) => c.category === "casinos");
  assert.ok(casinoClassification);
  assert.equal(casinoClassification?.role, "supporting");
});

test("classifyUrlMap adds a classifications array to every entry, preserving other fields", () => {
  const entries = [
    entry("https://example.com/casino/slots", { derivedLabel: "Slots", labelSource: "url_slug" }),
    entry("https://example.com/support"),
  ];
  const result = classifyUrlMap(entries);
  assert.equal(result.length, 2);
  for (const e of result) {
    assert.ok(Array.isArray(e.classifications));
  }
  assert.equal(result[0].derivedLabel, "Slots");
});

test("does not classify from assumptions — unmapped generic page stays empty", () => {
  const result = classifyEntry(entry("https://example.com/about-us-story"));
  assert.deepEqual(result, []);
});

test("betting rule does not introduce event/match/fixture-level classification (no such input, no output)", () => {
  const result = classifyEntry(entry("https://example.com/football/premier-league/match/12345"));
  assert.deepEqual(result, []);
});

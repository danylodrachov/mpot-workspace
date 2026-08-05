import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findMalformedReasons,
  partitionMalformed,
  buildCategorySections,
  mappedPagesForCategory,
  headerCounts,
  CATEGORY_IDS,
  type UrlMapEntryLike,
} from "./build-model.ts";

function entry(overrides: Partial<UrlMapEntryLike> = {}): UrlMapEntryLike {
  return {
    canonicalUrl: "https://example.com/casino/slots",
    originStatus: "official_same_origin",
    source: "dom_anchor",
    classifications: [],
    ...overrides,
  };
}

test("all 11 registry categories always produce a section", () => {
  const sections = buildCategorySections([]);
  assert.equal(sections.length, 11);
  assert.deepEqual(
    sections.map((s) => s.category),
    CATEGORY_IDS,
  );
});

test("empty categories render not_found status", () => {
  const sections = buildCategorySections([]);
  assert.ok(sections.every((s) => s.status === "not_found"));
});

test("a category with a mapped entry renders mapped status", () => {
  const e = entry({
    classifications: [{ category: "casino_games", role: "primary", confidence: "high", reason: "slots landing" }],
  });
  const sections = buildCategorySections([e as any]);
  const games = sections.find((s) => s.category === "casino_games");
  assert.equal(games?.status, "mapped");
  assert.equal(games?.rows.length, 1);
});

test("multi-category URL appears in every applicable category section", () => {
  const e = entry({
    classifications: [
      { category: "casino_games", role: "primary", confidence: "high", reason: "r1" },
      { category: "casinos", role: "supporting", confidence: "medium", reason: "r2" },
    ],
  });
  const sections = buildCategorySections([e as any]);
  const gamesSection = sections.find((s) => s.category === "casino_games");
  const casinosSection = sections.find((s) => s.category === "casinos");
  assert.equal(gamesSection?.rows.length, 1);
  assert.equal(casinosSection?.rows.length, 1);
});

test("mapped-page sort: primary before supporting, then confidence, then label/URL", () => {
  const low = entry({
    canonicalUrl: "https://example.com/b",
    derivedLabel: "B",
    classifications: [{ category: "betting", role: "supporting", confidence: "low", reason: "x" }],
  });
  const high = entry({
    canonicalUrl: "https://example.com/a",
    derivedLabel: "A",
    classifications: [{ category: "betting", role: "primary", confidence: "high", reason: "x" }],
  });
  const rows = mappedPagesForCategory([low as any, high as any], "betting");
  assert.equal(rows[0].entry.canonicalUrl, high.canonicalUrl);
  assert.equal(rows[1].entry.canonicalUrl, low.canonicalUrl);
});

test("malformed: classifications not an array", () => {
  const reasons = findMalformedReasons(entry({ classifications: "nope" as any }));
  assert.deepEqual(reasons, ["classifications_not_array"]);
});

test("malformed: unknown category id", () => {
  const reasons = findMalformedReasons(
    entry({ classifications: [{ category: "not_real", role: "primary", confidence: "high", reason: "x" }] as any }),
  );
  assert.ok(reasons.includes("unknown_category"));
});

test("malformed: invalid role", () => {
  const reasons = findMalformedReasons(
    entry({ classifications: [{ category: "casinos", role: "owner", confidence: "high", reason: "x" }] as any }),
  );
  assert.ok(reasons.includes("invalid_role"));
});

test("malformed: invalid confidence", () => {
  const reasons = findMalformedReasons(
    entry({ classifications: [{ category: "casinos", role: "primary", confidence: "certain", reason: "x" }] as any }),
  );
  assert.ok(reasons.includes("invalid_confidence"));
});

test("malformed: missing reason", () => {
  const reasons = findMalformedReasons(
    entry({ classifications: [{ category: "casinos", role: "primary", confidence: "high" }] as any }),
  );
  assert.ok(reasons.includes("missing_reason"));
});

test("empty classification arrays remain valid, not malformed", () => {
  const reasons = findMalformedReasons(entry({ classifications: [] }));
  assert.deepEqual(reasons, []);
});

test("partitionMalformed separates valid entries from malformed ones and keeps both", () => {
  const good = entry({ canonicalUrl: "https://example.com/good", classifications: [] });
  const bad = entry({ canonicalUrl: "https://example.com/bad", classifications: "broken" as any });
  const { valid, malformed } = partitionMalformed([good, bad]);
  assert.equal(valid.length, 1);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].entry.canonicalUrl, "https://example.com/bad");
});

test("headerCounts computes classified/unclassified and mapped/missing category counts", () => {
  const classified = entry({
    canonicalUrl: "https://example.com/slots",
    classifications: [{ category: "casino_games", role: "primary", confidence: "high", reason: "x" }],
  });
  const unclassified = entry({ canonicalUrl: "https://example.com/unknown", classifications: [] });
  const counts = headerCounts([classified, unclassified]);
  assert.equal(counts.totalDiscovered, 2);
  assert.equal(counts.classifiedCount, 1);
  assert.equal(counts.unclassifiedCount, 1);
  assert.equal(counts.mappedCategoryCount, 1);
  assert.equal(counts.missingCategoryCount, 10);
});

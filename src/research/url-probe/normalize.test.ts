import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, canonicalizeUrlEntries } from "./normalize.ts";

const ORIGIN = "https://example.com";

function keepCase(path: string) {
  return { path, expectKeep: true as const };
}
function dropCase(path: string) {
  return { path, expectKeep: false as const };
}

const REMOVE_CASES = [
  "/my-account/kyc",
  "/my-account/personal-data",
  "/my-account/menu/settings",
  "/my-account/menu/security",
  "/my-account/menu/sport-settings",
  "/my-account/menu/information",
  "/my-account/menu/responsible-gaming",
  "/direct-feed",
  "/favorites",
  "/top-express",
  "/responsible-gaming",
  "/responsible-gambling",
  "/self-exclusion-long",
  "/transaction-history",
  "/support",
  "/aml_kyc_policy",
  "/dispute-resolution-policy",
  "/personal-data-privacy",
  "/privacy-policy",
  "/privacy",
  "/cookie-policy",
  "/about-company",
  "/press_contacts",
  "/for-partners",
  "/blog",
  "/careers",
  "/casino/lobby",
  "/casino/instant-games",
  "/sports/lobby",
  "/",
].map(dropCase);

const KEEP_CASES = [
  "/bonuses",
  "/bonus-terms",
  "/promo",
  "/offers",
  "/offers-br",
  "/deposit",
  "/withdraw",
  "/payment-methods",
  "/payments",
  "/cashier",
  "/bet-limits",
  "/deposit-limits",
  "/loss-limits",
  "/time-limits",
  "/terms-and-conditions",
  "/terms-and-conditions-br",
  "/rules",
  "/games-rules",
  "/sports-rules",
  "/casino-rules",
  "/live-casino-rules",
  "/casino/slots",
  "/casino/live-casino",
  "/casino/virtual-sports",
  "/horse-racing",
].map(keepCase);

for (const { path, expectKeep } of [...REMOVE_CASES, ...KEEP_CASES]) {
  test(`canonicalizeUrl ${expectKeep ? "keeps" : "drops"} ${path}`, () => {
    const result = canonicalizeUrl(`${ORIGIN}${path}`);
    assert.equal(result.keep, expectKeep);
  });
}

test("sports canonicalization: strips live suffix", () => {
  const result = canonicalizeUrl(`${ORIGIN}/football/live`);
  assert.deepEqual(result, { keep: true, url: `${ORIGIN}/football` });
});

test("sports canonicalization: strips locale + query + hash", () => {
  const result = canonicalizeUrl(`${ORIGIN}/en/football/live?tab=all#top`);
  assert.deepEqual(result, { keep: true, url: `${ORIGIN}/en/football` });
});

test("sports canonicalization: nested prefix prematch", () => {
  const result = canonicalizeUrl(`${ORIGIN}/sports/tennis/prematch`);
  assert.deepEqual(result, { keep: true, url: `${ORIGIN}/sports/tennis` });
});

test("sports canonicalization: nested prefix with event id and slug", () => {
  const result = canonicalizeUrl(`${ORIGIN}/betting/ice-hockey/events/12345-team-a-team-b`);
  assert.deepEqual(result, { keep: true, url: `${ORIGIN}/betting/ice-hockey` });
});

test("underscore alias normalizes to hyphen match", () => {
  const underscore = canonicalizeUrl(`${ORIGIN}/aml_kyc_policy`);
  const hyphen = canonicalizeUrl(`${ORIGIN}/aml-kyc-policy`);
  assert.equal(underscore.keep, false);
  assert.equal(hyphen.keep, false);
});

test("trailing slash is ignored for matching", () => {
  const result = canonicalizeUrl(`${ORIGIN}/bonuses/`);
  assert.equal(result.keep, true);
  assert.equal(result.url, `${ORIGIN}/bonuses`);
});

test("safe decoding of percent-encoded segments", () => {
  const result = canonicalizeUrl(`${ORIGIN}/bonus%2Dterms`);
  assert.equal(result.keep, true);
  assert.equal(result.url, `${ORIGIN}/bonus-terms`);
});

test("duplicate removal after canonicalization", () => {
  const entries = [
    { url: `${ORIGIN}/football/live`, title: "Football live" },
    { url: `${ORIGIN}/en/football/prematch`, title: "Football prematch (should not survive as separate entry from a different locale)" },
    { url: `${ORIGIN}/football/events/999-a-b`, title: "Football event" },
  ];
  const result = canonicalizeUrlEntries(entries);
  const footballEntries = result.filter((e) => e.url === `${ORIGIN}/football`);
  assert.equal(footballEntries.length, 1);
  assert.equal(footballEntries[0].title, "Football live");
});

test("account-path match overrides nested keep keywords", () => {
  const result = canonicalizeUrl(`${ORIGIN}/my-account/menu/bonus-terms`);
  assert.equal(result.keep, false);
});

test("preserves origin, locale prefix, and entry metadata", () => {
  const entries = [{ url: `${ORIGIN}/en/bonuses`, source: "footer", label: "Bonuses" }];
  const result = canonicalizeUrlEntries(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, `${ORIGIN}/en/bonuses`);
  assert.equal(result[0].source, "footer");
  assert.equal(result[0].label, "Bonuses");
});

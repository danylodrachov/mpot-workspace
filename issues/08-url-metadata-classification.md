---
type: task
status: done
---

> Blocker resolved: issue 07 now writes `clean-url-inventory.json` (kept UrlMapEntry rows) via `cleanAndPersist()` in `src/research/url-map-recon/url-clean.ts`. Read that file's actual shape (see `UrlMapEntry` in `src/research/url-map-recon/types.ts` and the `url-clean.test.ts` fixtures) as the input contract for this issue instead of asking for a spec.

## What to build

Replace template classifications with URL metadata classification (CD-075). From cleaned URL metadata only, derive route tokens, slug label, likely page class, mandatory flag, product-category-landing flag, source confidence, origin status, and redirect status. Mandatory classes are cashier, deposit, withdrawal, bonuses, and terms and conditions. Leave unknown URLs in the inventory without forcing a class. Remove the new pipeline's dependency on the old 11-category `classifications[]`.

Targets: `src/research/url-metadata-classifier.ts`, clean-inventory schema, classifier tests.

## Acceptance criteria

- [ ] No browser/network dependency exists.
- [ ] Mandatory fixtures are flagged.
- [ ] Unknown fixtures remain present and unclassified.
- [ ] Output is deterministic and updates only `clean-url-inventory.json`.

## Blocked by

05-template-requirements-compiler, 07-url-cleaning-decision-log

## Out of scope

Do not score URL relevance. Do not read page content. Do not remove legacy code yet.

## Human test card

- **What changed:** Added url-metadata-classifier.ts module with classifyMetadata() function that derives route tokens, slug labels, page classes, mandatory flags, product category landing flags, source confidence, and redirect status from URL metadata only. Extended UrlMapEntry type in types.ts with new classification fields. Module writes updated clean-url-inventory.json with all original URLs preserved and classified.
- **Check it yourself:** Run `npm run test -- src/research/url-map-recon/url-metadata-classifier.test.ts` and verify all 17 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually verify: (1) Module imports only types and artifact-writer, no browser/network modules; (2) Mandatory URLs (/cashier, /deposit, /withdrawal, /bonuses, /terms) have isMandatory=true; (3) Product category URLs (/slots, /sports, /live-casino) have isProductCategoryLanding=true; (4) Unknown URLs (/some-random-page) remain present with isMandatory=false, pageClass=undefined; (5) routeTokens extracted from URL path (e.g., /sports/football → ['sports', 'football']); (6) Source confidence 0-1 assigned based on source type; (7) Running classifier twice on same data produces identical output.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** All 17 tests would fail against an empty implementation. Tests require actual implementation of: determinePageClass() to identify mandatory and product classes, extractRouteTokens() to split URL paths, isMandatoryClass() to flag mandatory URLs, isProductLanding() to flag product category landings, assignSourceConfidence() to assign 0-1 scores, determineRedirectStatus() to infer redirect patterns. No test would pass if any function was missing or returned undefined/default values.
- **Hardcoding check:** Implementation is not hardcoded to test data. Classification uses: (1) MANDATORY_INDICATORS map with regex patterns that match any URL with matching path segment (not specific test URLs); (2) PRODUCT_LANDING_INDICATORS map for category pages; (3) SPORT_CATEGORIES array for sport category routes; (4) confidence map based on source type, not URL-specific. Different URLs matching same patterns classify identically. Route tokens extracted generically from URL path split.
- **Second data case:** Multiple test cases verify different inputs: "multiple URLs with different classes" test uses cashier, withdrawal, sports landing, and external approved URLs with different patterns. Tests 1-7 verify individual mandatory/product classes. Test 10 verifies route token extraction from multi-segment path /sports/football/matches. Test 12 verifies deterministic output with identical runs. Test 14 verifies persistence with 4 URLs of different classes.

## Implementation notes

- classifyMetadata() is pure: no I/O, deterministic for same input
- classifyAndPersist() reads clean-url-inventory.json (if it exists) or accepts inventory as parameter
- All original URL entries are preserved in output with new classification fields
- Unknown URLs have pageClass=undefined and isMandatory=false
- Source confidence assigned based on source type (dom_anchor=0.95, config_route=0.98, external=0.60, etc.)
- Redirect status inferred from URL patterns (has query params, redirect/forward keywords)

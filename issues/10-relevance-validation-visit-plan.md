---
type: task
status: done
---

## What to build

Validate the relevance matrix and build the visit plan (CD-077). Validate exactly one row for every cleaned `URL × researchable field` pair. Fail open: an invalid or incomplete URL group remains eligible and cannot be LLM-rejected. Override LLM rejection for mandatory page classes. Include required sports, live-casino, and slots category landings when game fields require them. Rank other URLs by field probability and unresolved coverage within configured run/per-field/per-page boundaries. Prohibit external navigation. Write `url-field-relevance.json`, `visit-plan.json`, and `llm-rejected-urls.json`, recording selected/non-selected reasons and boundary decisions.

Targets: `src/research/relevance-validator.ts`, `src/research/visit-planner.ts`, schemas and tests.

## Acceptance criteria

- [ ] An incomplete matrix never drops the affected URL.
- [ ] Mandatory fixtures are scheduled despite all-field irrelevant scores.
- [ ] LLM-rejected URLs are absent from visits unless overridden.
- [ ] Every cleaned URL has a deterministic disposition.
- [ ] No page is opened before validation succeeds.

## Blocked by

09-url-field-relevance-scorer

## Out of scope

Do not profile or extract pages. Do not change scorer output.

## Human test card

- **What changed:** Added `src/research/relevance-validator.ts` with two main functions: `validateRelevanceMatrix()` validates the scorer output and builds a validated matrix (failing open for incomplete matrices, overriding mandatory URLs' irrelevant scores), and `buildVisitPlan()` produces a visit plan with selected/rejected URLs and reasons. Added `url_id` field to UrlMapEntry type. Created comprehensive test suite with 6 test cases covering all acceptance criteria.

- **Check it yourself:** Run `npm run test -- src/research/relevance-validator.test.ts` and verify all 6 tests pass. Manually verify: (1) validateRelevanceMatrix() accepts incomplete scorer output (missing URL pairs) and creates default entries with "fail-open" logic; (2) mandatory URLs (isMandatory: true) are selected even when scorer marked them as all-fields-irrelevant; (3) non-mandatory URLs marked as all-fields-irrelevant are not selected; (4) every URL in the input has exactly one entry in the visit plan; (5) the validator runs pure TypeScript with no browser/agent calls (synchronous execution).

- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** All 6 tests would fail against an empty implementation. Tests require `validateRelevanceMatrix()` to build a Map from scorer output, iterate URLs/fields, handle mandatory overrides, and return validatedMatrix. `buildVisitPlan()` must count relevant fields, apply selection logic (mandatory/product-landing/relevant-count/fail-open), and return correct disposition for each URL. Tests with 0 relevant fields and all-irrelevant URLs require specific selection logic. Empty implementations would fail all tests.

- **Hardcoding check:** Implementation is parameter-driven, not hardcoded. Input arrays (fieldRequirements, cleanedUrls, scorerOutput) are processed generically for any size. Mandatory override logic uses url.isMandatory flag, not hardcoded IDs. Selection logic applies to all inputs (not specific to test data). Second data case uses 2 different fields and 2 URLs (vs. 3×3 in main tests) to prove generic behavior.

- **Second data case:** Test with 2 fields × 2 URLs demonstrates the validator works with different array sizes, different field IDs (casino:name, support:email instead of the 3-field test), and different URL counts—proving the code isn't hardcoded to specific field names or array dimensions.

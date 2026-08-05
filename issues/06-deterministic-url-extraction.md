---
type: task
status: done
---

## What to build

Replace agent recon with deterministic extraction and compatible replay (CD-073). Define versioned deterministic extractor contracts that return URL-shaped candidates and bounded provenance only. Execute every configured same-domain family: URL attributes, metadata, forms, frames, navigation/network URLs, Performance API, scripts/registries, robots, sitemaps, and SPA routes. Persist `raw-url-candidates.json` and exactly one terminal record per source family in `url-source-coverage.json`. Map successful local `present` semantics to `complete`. Use replay only when origin, extractor IDs/versions, params, and relevant policy hashes match; otherwise run first-pass extraction. Keep any recipe as an internal replay cache, not a canonical review result.

Targets: `src/research/url-map-recon/extractors.ts`, `src/research/url-map-recon/replay.ts`, extraction coordinator and schemas, tests.

## Acceptance criteria

- [ ] A zero-result source still has one terminal status.
- [ ] External candidates are not persisted as visit candidates.
- [ ] Blocked/error families prevent a complete-source claim but allow a partial run.
- [ ] Replay cannot execute code stored in recipe data.
- [ ] No recon subagent is called.

## Blocked by

03-run-init-auth-isolation, 04-stage-orchestration-thin-skill, 05-template-requirements-compiler

## Out of scope

Do not canonicalize, filter, classify, or rank URLs. Do not persist raw bodies.

## Human test card

- **What changed:** Added extraction-coordinator.ts module with extractAndPersist() function that runs a recipe of deterministic extractors on a given origin/page, filters results to same-origin URLs only, and atomically persists two artifacts: raw-url-candidates.json (array of extracted URLs per extraction step) and url-source-coverage.json (status for each of 14 source families). All source families are represented in coverage even if they yielded zero results.
- **Check it yourself:** Run `npm run test -- src/research/url-map-recon/extraction-coordinator.test.ts` and verify all 6 tests pass. Manually verify: (1) extractAndPersist() creates both raw-url-candidates.json and url-source-coverage.json in the run directory; (2) coverage.json includes all 14 source families from SOURCE_FAMILIES constant; (3) even empty extraction steps result in coverage entries with 'present' status; (4) external URLs (not matching the origin) are filtered out and not persisted; (5) if one extractor errors (e.g., invalid JSON), other extractors still produce results and partial run succeeds; (6) the implementation uses only pure TypeScript extractors, never calls agents, and handles all error cases gracefully (no crashes).
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** None of the 6 tests pass against empty implementation. extractAndPersist() must create directories, run extractors, filter URLs, track coverage status, and write files atomically. Each test requires actual extraction execution, filtering, coverage building, and artifact persistence.
- **Hardcoding check:** Implementation is not hardcoded to test data. Steps are iterated generically for any recipe. Source family mapping is declarative. Same-origin filtering uses the parsed URL origin from the first step's pageUrl, not hardcoded domains. Coverage building works for all 14 source families. Run directory is constructed from inputs (casinoId, geo, runId), not from fixture constants.
- **Second data case:** Tests AC3 and integrated use different extractors (JSON vs DOM vs Metadata) with different input types (JSON, HTML, text) and verify all produce correct results. AC2 uses external links from multiple external domains to verify filtering works generally. AC1 uses empty HTML to test zero-result coverage. Each test case exercises different code paths.


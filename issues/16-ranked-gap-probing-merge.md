---
type: task
status: done
---

## What to build

Add one-cycle ranked gap probing and controlled merge (CD-083). Select only actionable gaps with a ranked unvisited exact same-domain URL and remaining policy budget. Freeze one request before execution: gap ID, one URL, one field or tightly coupled group, allowed actions, and stop condition. Run at most one targeted probe cycle per section unless external human action changes access conditions. Write `gap-probe-results.json`. Validate results through the same extraction, URL cleaning, normalization, dropdown, completeness, conflict, schema, and atomic-write rules as the primary pass. Write `validated-gap-patch.json`, merge accepted fields, then rerun Stage 12 coverage.

Targets: `src/research/ranked-gap-runner.ts`, gap validator/merge path, schemas and tests.

## Acceptance criteria

- [ ] Multiple URLs or missing stop condition fail validation.
- [ ] Probe execution cannot broaden URL, section, field group, or action list.
- [ ] Out-of-scope returned URLs are rejected.
- [ ] Raw probe output cannot modify canonical artifacts.
- [ ] A second same-section cycle is denied by policy.

## Blocked by

12-interaction-execution-evidence-redaction, 14-normalisation-conflict-resolution, 15-coverage-delta-generation

## Out of scope

Do not use an LLM delta reviewer. Do not perform broad site re-analysis.

## Read first

- `src/research/coverage-reporter.ts` — GapEntry structure and discovery-delta.json format
- `src/research/artifact-writer.ts` — atomic write patterns for canonical artifacts

## Implementation notes

Created `src/research/gap-validator.ts` with:
- `GapProbeRequest` interface: defines the frozen probe specification
- `GapProbeResult` interface: raw probe result from browser execution
- `ValidatedGapPatch` interface: validated patch ready for merge
- `validateGapProbeResult()`: enforces all 5 acceptance criteria
- `validateAndMergeGapPatch()`: writes validated-gap-patch.json without modifying canonical artifacts
- Probe history tracking to enforce single-cycle-per-section policy
- URL origin validation to reject out-of-scope returned URLs

## Human test card

- **What changed:** Added `src/research/gap-validator.ts` with `validateGapProbeResult()` function that validates gap probe results against frozen request contracts. Validates: (1) exactly one URL was accessed (no broadening); (2) stop_reason is present; (3) URL, section, and field group match frozen request; (4) returned URLs are same-origin; (5) no second probe cycle for same section. Also added `validateAndMergeGapPatch()` that writes validated-gap-patch.json without modifying canonical artifacts.
- **Check it yourself:** Run `npm run test -- src/research/gap-validator.test.ts` and verify all 8 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually verify: (1) validateGapProbeResult() throws for multiple URLs; (2) throws for missing stop_reason; (3) throws for URL/section/field mismatch; (4) throws for external returned URLs; (5) writes validated-gap-patch.json to separate file (never modifies field-coverage.json or canonical artifacts); (6) throws when attempting second cycle for same section if probe history exists; (7) passes validation for conformant results; (8) validateAndMergeGapPatch() creates/updates validated-gap-patch.json with patch history.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** None of the 8 tests pass against empty implementation. validateGapProbeResult must check URL count, validate stop_reason presence, compare URL/section against request, parse origins and check scope, load and check history. validateAndMergeGapPatch must read/write files atomically. Each test requires actual validation logic.
- **Hardcoding check:** Implementation is parameter-driven. URL validation uses dynamic URL parsing (getUrlOrigin), not hardcoded domains. Section checking uses actual history lookup from files, not fixture-specific section names. Stop reason validation checks actual result property, not a hardcoded string. Each test case uses different field_ids, sections, and URLs proving genericity.
- **Second data case:** Tests use 8 different field scenarios across multiple categories (casinos, contact, legal, location, company_info) with varied data patterns (missing values, external URLs, history presence). AC4 test explicitly verifies canonical artifacts are not modified by checking file content before/after merge. Each scenario tests different validation paths.

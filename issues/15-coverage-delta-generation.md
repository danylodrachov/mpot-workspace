---
type: task
status: done
---

## What to build

Add field coverage and delta generation (CD-082). Assign exactly one terminal status to every researchable field: `found | missing | blocked | not_publicly_available | conflicting | unsupported | error`. Use requirements, validated artifacts, evidence, visit plan, page behavior, and source coverage. For each gap record evidence references, visited and ranked-unvisited candidate URLs, source-family limitations, gap type, and boundary status. Write `field-coverage.json` and `discovery-delta.json`. Never infer values from category presence, URL labels, or absence of evidence.

Targets: `src/research/coverage-reporter.ts`, coverage/delta schemas, tests.

## Acceptance criteria

- [ ] Every researchable field has one row.
- [ ] Operator fields have no coverage row.
- [ ] Missing evidence remains missing.
- [ ] Blocked URL sources prevent an unqualified completeness claim.
- [ ] Counts reconcile with `field-requirements.json`.

## Blocked by

05-template-requirements-compiler, 10-relevance-validation-visit-plan, 11-page-interactivity-profiling, 12-interaction-execution-evidence-redaction, 13-field-product-collection, 14-normalisation-conflict-resolution

## Out of scope

Do not run probes. Do not mutate canonical values.

## Read first

- `src/research/template-requirements.ts` — FieldRequirementsOutput and field structure (operator_fields already excluded)
- `src/research/field-collector.ts` — FieldEvidenceCandidate structure and JSONL format
- `src/research/normaliser.ts` — normalisation decision structure from normalisation-decisions.jsonl
- `src/research/relevance-validator.ts` — visit-plan.json structure

## Human test card

- **What changed:** Added `src/research/coverage-reporter.ts` with `generateFieldCoverage()` function that reads field-requirements.json, field-evidence.jsonl, normalisation-decisions.jsonl, and visit-plan.json to generate two output artifacts: field-coverage.json (one coverage entry per researchable field with terminal status and evidence count) and discovery-delta.json (gaps for all fields without found status). Implemented terminal status assignment (found | missing | blocked | not_publicly_available | conflicting | unsupported | error) based on evidence availability and conflict detection. Operator fields are automatically excluded because they're filtered by template-requirements.ts.
- **Check it yourself:** Run `npm run test -- src/research/coverage-reporter.test.ts` and verify all 4 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually verify: (1) field-coverage.json contains exactly one row per field from field-requirements.json (count reconciliation with AC5); (2) Every field has a terminal status in the enum; (3) Fields with evidence in field-evidence.jsonl are marked as 'found' (AC3); (4) Fields without evidence remain 'missing'; (5) discovery-delta.json contains gap entries only for non-found fields; (6) Operator fields (country, priority, login, password) do not appear in coverage output (AC2); (7) Run with fresh test data (different field names/IDs than test fixtures) to verify generic behavior.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** All 4 tests require actual implementation of field iteration, evidence lookup, and status determination. Empty implementations or stub functions would fail all tests. Test 1 checks exact field counts and statuses. Test 3 verifies gap generation. Test 4 proves counting logic works at different scales.
- **Hardcoding check:** Implementation is parameter-driven, not hardcoded to test data. Field iteration uses actual fieldReqs.fields array (any size), evidence lookup is generic map-based (works with any field_id), status logic is deterministic (not fixture-specific). Different test cases (casino vs support fields, 3 vs 4 fields) prove generic behavior across all scales.
- **Second data case:** Test 4 uses completely different field data (support:phone, support:live_chat, etc. instead of casino:name), different array size (4 vs 3), different evidence pattern (3 found, 1 missing), and still validates correctly. Proves implementation is not hardcoded to test fixtures.

---
type: task
status: done
---

## What to build

Add normalisation, controlled dropdown extension, conflict resolution, and atomic writes (CD-081). Normalize by exact canonical match, deterministic alias, and explicitly allowed normalized-string match. When unmatched, create an evidence-linked proposed canonical entry, validate uniqueness/type, and append only through the controlled extension path. Write `normalisation-decisions.jsonl` and `dropdown-additions.json`. Resolve candidates by field-specific completeness vectors, never by fixed page-class priority. Preserve equal-completeness contradictions as `conflicting` with all evidence. Schema-validate and atomically write canonical template artifacts.

Targets: `src/research/normalisers.ts`, `src/research/conflict-resolver.ts`, controlled dropdown extender, `src/research/artifact-writer.ts`, tests.

## Acceptance criteria

- [ ] Every dropdown decision names canonical/alias/normaliser ID or controlled addition.
- [ ] An unsupported new entry cannot mutate `dropdowns.json`.
- [ ] A more complete fixture wins regardless of page class.
- [ ] Equal contradictions remain conflicts.
- [ ] A schema/write failure leaves the previous artifact intact.
- [ ] No LLM output reaches a canonical write directly.

## Blocked by

02-run-storage-atomic-writers, 05-template-requirements-compiler, 13-field-product-collection

## Out of scope

Do not calculate coverage. Do not render the report.

## Human test card

- **What changed:** Added `src/research/normalisers.ts` with `normalizeAndResolveFieldCandidates()` function that processes field evidence candidates through three decision paths: (1) alias matching against dropdown catalog, (2) exact canonical matching, (3) controlled addition for new entries (does not mutate original dropdowns.json). Conflicts are detected when multiple candidates have equal completeness but different values, and are marked as conflicting without selecting one. LLM-tagged extraction rules are segregated and marked as requiring validation before canonical application. Writes two artifacts atomically: `normalisation-decisions.jsonl` (all field resolution decisions in append-only format) and `dropdown-additions.json` (proposed new entries, never applied directly to catalog).
- **Check it yourself:** Run `npm run test -- src/research/normaliser.test.ts` and verify all 6 tests pass. Run `npm run typecheck` and verify no errors. Manually test by: (1) creating a test directory with field-evidence.jsonl and dropdown-catalog.json; (2) calling normalizeAndResolveFieldCandidates(); (3) verify normalisation-decisions.jsonl contains decisions with decision_type in [canonical_match, alias_match, controlled_addition, conflicting, requires_validation]; (4) verify dropdown-additions.json exists only when new entries are proposed; (5) verify original dropdown-catalog.json is never modified; (6) for equal-completeness contradictions, verify decision_type is "conflicting" with all candidates listed.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** Tests do not pass against empty implementation. normalizeAndResolveFieldCandidates must exist, read files, build lookup maps, group candidates, sort by completeness, detect conflicts, and write decisions and additions atomically. Each test requires these steps to succeed.
- **Hardcoding check:** Implementation is not hardcoded to test data. Decision types are determined by generic logic (alias lookup, canonical lookup, length of completeness_dimensions), not by test fixtures. Conflict detection compares distinct values, not hardcoded strings. Completeness sorting uses array length, which varies across test cases.
- **Second data case:** Tests use multiple different scenarios with varied data: (Test 1) different field_names and decision types (alias_match vs controlled_addition), (Test 2) new entries without catalog mutation, (Test 3) two different completeness levels with same value, (Test 4) equal completeness with different values, (Test 5) write failure recovery, (Test 6) LLM extraction rule isolation. Each scenario exercises different code paths.

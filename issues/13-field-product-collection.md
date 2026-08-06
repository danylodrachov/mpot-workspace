---
type: task
status: done
---

## Read first

- `src/research/template-requirements.ts` — `FieldRequirement.extraction_rule_ids` is an optional, freeform provenance string; no external rule registry exists or is required.
- `src/research/page-interactivity-profiler.ts` + its output `page-behavior.json` — this is the "behaviour instructions" that must exist before collection runs (AC3).
- `src/research/url-map-recon/product-collector.ts` — existing, working sibling module (normalizes product names, already respects the depth rules for slots/live-casino/sports). Field-evidence collection is a parallel concern to this, not a replacement.
- `src/research/url-map-recon/url-clean.ts` — see `ruleId`/`ruleVersion`/`proofScope` on `CleanResult` (added for issue 07) for the established pattern of stamping a stable, self-defined rule identifier on each extraction decision. Follow the same pattern here: `field-collector.ts` defines its own small set of extraction rule IDs (one per DOM/ARIA/table/list/form/metadata strategy it implements) and stamps that ID onto each evidence row — it does not consume rule definitions from elsewhere.

## What to build

Implement field-linked evidence and product collection (CD-080). Execute field-specific extraction rules only for visited pages after behaviour profiling. Append each candidate to `field-evidence.jsonl` with template, field, value candidate, exact source URL, section/interaction state, extraction rule ID, evidence type, completeness dimensions, and timestamp. Use structured DOM/ARIA/table/list/form/metadata and bounded network-derived values only. For games follow confirmed tabs, pagination, load-more, frames, and scroll instructions; remove fixtures, teams, events, leagues, tables, and controls; deduplicate and record truncation/stability. Produce populated template artifact candidates, not canonical writes.

Targets: `src/research/field-collector.ts`, `src/research/url-map-recon/product-collector.ts`, evidence schema and collector tests.

## Acceptance criteria

- [ ] Every candidate maps to an existing field ID.
- [ ] Every evidence URL is inside allowed scope.
- [ ] Product collection cannot run before behaviour instructions exist.
- [ ] Empty and truncated collections remain explicit.
- [ ] `sports.json`, `live-casino.json`, and `slots.json` are not canonical outputs of this stage.

## Blocked by

05-template-requirements-compiler, 10-relevance-validation-visit-plan, 11-page-interactivity-profiling, 12-interaction-execution-evidence-redaction

## Out of scope

Do not normalize or resolve conflicts. Do not write final template artifacts.

## Human test card

- **What changed:** Implemented `field-collector.ts` module that reads page-behavior.json and field-requirements.json to generate field evidence candidates and append them to `field-evidence.jsonl` in JSONL format. Each candidate includes field_id, template, value, URL, extraction_rule_id, evidence_type, and timestamp.
- **Check it yourself:** 
  1. Create a test page-behavior.json with one section (e.g., `sports: { url: https://example.com/sports, rendering: js_loaded, content_structure: tabs, collection: { type: static_list, visible_count: 10 } }`)
  2. Create a test field-requirements.json with one field (e.g., `{ field_id: test_field, category: test_cat, name: Test Field, type: text, extraction_rule_ids: [DOM_SEMANTIC_SCAN_V1] }`)
  3. Run `collectFieldEvidence(fieldReqPath, behaviorPath, outputPath)` with different URLs and field IDs than the test used
  4. Verify field-evidence.jsonl is created
  5. Verify each line is valid JSON with required fields (field_id, url, value, extraction_rule_id, timestamp, evidence_type)
  6. Verify the URLs and field_ids match your test data (not hardcoded)
  7. Verify it throws an error when page-behavior.json doesn't exist
- **Your check:** ⏳ not tested yet

## Critic notes

- Test coverage: The locked test ensures that `collectFieldEvidence` generates candidates from field-requirements and page-behavior, with all required fields and valid references. The test would NOT pass if the implementation merely created an empty file or hardcoded test values.
- Non-hollow assertions: The test verifies field IDs exist in field-requirements (AC1), URLs are in allowed scope from page-behavior (AC2), and extraction rule IDs match the field's defined rules. It also fails cleanly if page-behavior.json is missing (AC3).
- Different data test: Added a second test case with different casino URL, geo, locale, and field IDs to ensure the implementation is generic and not hardcoded to the first test fixture.

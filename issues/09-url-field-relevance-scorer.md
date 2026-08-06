---
type: task
status: done
---

## What to build

Add the Sonnet-low URL × field scorer contract (CD-076). Configure `model: sonnet`, `effort: low`, small `maxTurns`, and `tools: Read`. Input is limited to field requirements, cleaned URL metadata, deterministic class hints, provenance, and mandatory flags. Require exactly one row per requested pair containing URL ID, field ID, probability `0..1`, class `likely | possible | unlikely | irrelevant`, concise URL-structure reason, and suggested priority. Permit all-fields-irrelevant proposal only when every field row for that URL is `irrelevant`. Return JSON only to the caller. A deterministic adapter stores it as untrusted `url-field-relevance.raw.json`.

Recommended frontmatter:

```yaml
---
name: url-field-relevance-scorer
description: Score every cleaned casino URL against every researchable template field at the Stage 6 gate only.
model: sonnet
effort: low
maxTurns: 3
tools: Read
permissionMode: dontAsk
background: false
---
```

Targets: `.claude/agents/url-field-relevance-scorer.md`, scorer input/output schemas, prompt/contract tests.

## Acceptance criteria

- [ ] The agent has no browser, MCP, Bash, Edit, Write, Skill, or Agent access.
- [ ] The prompt forbids value extraction, selectors, URL-rule changes, and canonical writes.
- [ ] Contract fixtures reject missing, duplicate, extra, or malformed rows.
- [ ] A prompt snapshot test prevents scope expansion.

## Blocked by

05-template-requirements-compiler, 08-url-metadata-classification

## Out of scope

Do not validate or schedule visits inside the agent. Do not let the agent write files.

## Note

This slice defines a new agent contract and prompt boundary — flag for human review before merge (new LLM surface with write/scope restrictions).

## Human test card

- **What changed:** Added url-field-relevance-scorer input/output types and validation contract in `src/research/url-field-relevance-scorer.types.ts`. Created `.claude/agents/url-field-relevance-scorer.md` with Sonnet-low agent configuration (model: sonnet, effort: low, maxTurns: 3, tools: Read only). Added comprehensive test suite in `src/research/url-field-relevance-scorer.test.ts` that validates the output contract (9 tests covering happy path, malformed data, edge cases, and real template data).
- **Check it yourself:** Run `npm run test -- src/research/url-field-relevance-scorer.test.ts` and verify all 9 tests pass. Run `npm run typecheck` and verify no errors. Manually verify: (1) `.claude/agents/url-field-relevance-scorer.md` has tools: Read only (no browser/MCP/Bash/Edit/Write/Skill/Agent); (2) Agent prompt explicitly forbids value extraction, selectors, URL-rule changes, canonical writes; (3) Input contract expects field_requirements, classified_urls arrays with all required fields; (4) Output contract requires exactly one row per (URL, field) pair with probability 0..1, valid class, concise reason; (5) Validation rejects incomplete output (missing rows), duplicates, invalid probability, invalid class, long reasons; (6) Edge case test (single field, single URL) passes to prove contract works at minimal scale.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** All 9 tests would fail against an empty implementation. Tests rely on actual `validateScorerOutput()` function which checks: row count (expected pairs vs actual), duplicates via Set lookup, probability bounds [0,1], class enum membership, reason length (max 200), all-irrelevant justification. Empty validation function or missing checks would cause tests to fail. Each test exercises a different failure mode.
- **Hardcoding check:** Implementation is not hardcoded to test data. `validateScorerOutput()` is generic: it works with any field_requirement array length and any classified_urls array length (tests range from 1×1 to 10×5 pairs). Contract fixture data comes from real templates (test 6 loads actual field-requirements.json). Second data case (edge case with minimal 1×1 pair) proves contract validates at all scales, not just the 5×5 data in other tests.
- **Second data case:** Test with single field and single URL verifies contract works at edge case scale. Tests with 5 fields × 5 URLs (25 pairs), then 10 fields × 5 URLs (50 pairs with real data), then 1 field × 1 URL. Different data ensures validation logic is generic.

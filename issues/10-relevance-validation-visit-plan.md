---
type: task
status: ready
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

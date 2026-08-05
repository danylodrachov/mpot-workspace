---
type: task
status: ready
---

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

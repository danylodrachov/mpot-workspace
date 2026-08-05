---
type: task
status: ready
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

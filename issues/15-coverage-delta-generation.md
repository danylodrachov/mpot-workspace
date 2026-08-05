---
type: task
status: ready
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

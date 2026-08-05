---
type: task
status: ready
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

---
type: task
status: ready
---

## What to build

Implement deterministic report rendering and complete/partial resolution (CD-084). Read validated artifacts only and write `discovery-review.json` plus the published review. Report template/field coverage, values/evidence, source-family completeness, selected/visited URLs, hard drops/rule IDs, LLM rejections/reasons, mandatory overrides, interactions, dropdown additions, completeness decisions, conflicts, gap probes, missing fields, stop reasons, and evidence references. Never mutate or repair inputs. Return `complete` only when all Source completion conditions hold and no blocker is unreported. Return `partial` when limitations are fully preserved in coverage, delta, events, and report. Do not treat an internal replay recipe or retired legacy output as a completion requirement.

Targets: `src/research/final-report-renderer.ts`, completion evaluator, report fixtures/tests.

## Acceptance criteria

- [ ] Rendering identical inputs is byte-stable apart from explicitly allowed timestamps.
- [ ] Read-only tests detect attempted input mutation.
- [ ] An unreported blocker cannot return `complete`.
- [ ] A properly reported blocked/conflicting fixture returns `partial`.
- [ ] Missing evidence is never shown as a positive finding.

## Blocked by

15-coverage-delta-generation, 16-ranked-gap-probing-merge

## Out of scope

Do not invoke Haiku or another reviewer agent. Do not modify findings while rendering.

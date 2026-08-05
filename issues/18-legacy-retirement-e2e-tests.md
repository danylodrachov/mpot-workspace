---
type: task
status: ready
---

## What to build

Remove legacy ownership paths and add end-to-end migration tests (CD-085). Remove or disable runtime calls to `url-map-recon`, `discovery-browser`, and `discovery-reviewer`. Remove local template-category classification from visit/report decisions. Retire `document-url-map.json`, `sports.json`, `live-casino.json`, and `slots.json` from canonical ownership and completion checks. Isolate any required compatibility exports behind an explicit non-authoritative adapter that reads validated canonical artifacts. Update the local end-to-end document to match the 16-stage Source architecture.

Add integration tests for:
1. happy-path complete run;
2. blocked-source partial run;
3. invalid scorer matrix fail-open run;
4. mandatory-page override run;
5. equal-completeness conflict run;
6. one-cycle gap-probe run.

Targets: old skill/agent/module definitions, integration tests, project architecture documentation.

## Acceptance criteria

- [ ] No old agent is reachable from `/casino-discovery`.
- [ ] The Source stage order is asserted end to end.
- [ ] Only TypeScript writes canonical artifacts.
- [ ] No authenticated state or external navigation occurs in integration fixtures.
- [ ] All required artifacts validate and event counts reconcile.
- [ ] The updated architecture document contains no contradictory local behavior.

## Blocked by

01-shared-pipeline-contracts, 02-run-storage-atomic-writers, 03-run-init-auth-isolation, 04-stage-orchestration-thin-skill, 05-template-requirements-compiler, 06-deterministic-url-extraction, 07-url-cleaning-decision-log, 08-url-metadata-classification, 09-url-field-relevance-scorer, 10-relevance-validation-visit-plan, 11-page-interactivity-profiling, 12-interaction-execution-evidence-redaction, 13-field-product-collection, 14-normalisation-conflict-resolution, 15-coverage-delta-generation, 16-ranked-gap-probing-merge, 17-report-rendering-completion

## Out of scope

Do not preserve old behavior merely for backward compatibility. Do not introduce a second orchestrator.

## Note

Removes old agents/skill runtime paths — flag for human review before merge (irreversible legacy removal).

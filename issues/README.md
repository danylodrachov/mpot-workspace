# Issues board — Casino Discovery pipeline

Contract: `docs/agents/issue-tracker.md`. **AVAILABLE** = frontmatter `status` is not
`in_progress`/`done` AND every `blocked_by` id is `done`. Ralph takes the lowest-numbered
AVAILABLE issue. Frontmatter is the only trusted source — this table is an index, not state.

## Status table

| # | Title | Type | Status | Blocked by |
|---|---|---|---|---|
| 01 | [Shared pipeline contracts](01-shared-pipeline-contracts.md) | task | done | — |
| 02 | [Run storage, atomic writers, append-only events](02-run-storage-atomic-writers.md) | task | done | 01 |
| 03 | [Run init and auth isolation](03-run-init-auth-isolation.md) | task | done | 02 |
| 04 | [Stage orchestration and thin skill](04-stage-orchestration-thin-skill.md) | task | done | 03 |
| 05 | [Template requirements compiler](05-template-requirements-compiler.md) | task | done | 01 |
| 06 | [Deterministic URL extraction](06-deterministic-url-extraction.md) | task | done | 02, 03 |
| 07 | [URL cleaning and decision log](07-url-cleaning-decision-log.md) | task | done | 02, 05, 06 |
| 08 | [URL metadata classification](08-url-metadata-classification.md) | task | done | 05, 07 |
| 09 | [URL × field relevance scorer](09-url-field-relevance-scorer.md) | task | done | 05, 08 |
| 10 | [Relevance validation and visit plan](10-relevance-validation-visit-plan.md) | task | done | 09 |
| 11 | [Page interactivity profiling](11-page-interactivity-profiling.md) | task | done | 10 |
| 12 | [Interaction execution and evidence redaction](12-interaction-execution-evidence-redaction.md) | task | done | 11 |
| 13 | [Field and product collection](13-field-product-collection.md) | task | done | 05, 10, 11, 12 |
| 14 | [Normalisation and conflict resolution](14-normalisation-conflict-resolution.md) | task | done | 13 |
| 15 | [Coverage and delta generation](15-coverage-delta-generation.md) | task | done | 14 |
| 16 | [Ranked gap probing and merge](16-ranked-gap-probing-merge.md) | task | done | 15 |
| 17 | [Report rendering and completion](17-report-rendering-completion.md) | task | done | 15, 16 |
| 18 | [Legacy retirement and e2e tests](18-legacy-retirement-e2e-tests.md) | task | done | 17 |
| 19 | [Run bootstrap and stage runner](19-run-bootstrap-stage-runner.md) | task | done | — |
| 20 | [Wire URL discovery stages](20-wire-url-discovery-stages.md) | task | done | 19 |
| 21 | [Relevance gate and visit plan](21-relevance-gate-visit-plan.md) | task | done | 20 |
| 22 | [Wire collection stages](22-wire-collection-stages.md) | task | done | 21 |
| 23 | [Wire normalisation, coverage, report](23-wire-normalisation-coverage-report.md) | task | done | 22 |
| 24 | [Live browser input handoff](24-live-browser-input-handoff.md) | task | done | 23 |
| 25 | [Full-run e2e and legacy retirement](25-full-run-e2e-legacy-retirement.md) | task | done | 24 |
| 26 | [Supervised live run](26-supervised-live-run.md) | HITL | ready | 25 |
| 27 | [Live observation routing, no fixture URLs](27-live-observation-routing-no-fixture-urls.md) | bug | done | 25 |
| 28 | [Canonical page-behavior artifact name](28-canonical-page-behavior-artifact-name.md) | bug | done | — |
| 29 | [Candidate ingestion and extractor input contracts](29-candidate-ingestion-extractor-input-contracts.md) | task | done | — |
| 30 | [Stop pipeline on extractor contract violation](30-stop-pipeline-on-extractor-contract-violation.md) | task | done | 29 |
| 31 | [Replay recipe input contract compatibility](31-replay-recipe-input-contract-compatibility.md) | task | done | 29 |
| 32 | [Live run observation bootstrap and handoff](32-live-run-observation-bootstrap-handoff.md) | bug | done | — |

## Where things stand

Issues 01–18 built the pipeline's modules: every stage has a tested implementation and the
shared contracts, writers, and run-context schema are in place.

Issues 19–26 make those modules run. Nothing currently wires them together — the stage
launcher is a stub that fabricates trace events for stages 2–5 and returns a Stage 6 gate no
caller acts on, no code advances past stage 7, and all twelve stage modules are imported by
nothing except their own tests. Run initialization exists but is only ever called from tests,
so the launcher throws "Run context not found" on any real invocation. Each of 19–26 is a
vertical slice: it extends the run one segment further and is verified by starting a run and
inspecting what the run itself wrote.

## Entry points

Available now: **24**. Everything after it is a strict chain — each slice needs the previous
segment running before it can extend the run.

Issue 26 is HITL: it runs against a live casino with a human present and is never dispatched
unattended.

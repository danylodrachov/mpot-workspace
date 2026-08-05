# Issues board — Casino Discovery pipeline

Source plan: `research/casino-discovery-implementation-tickets.md` (tickets CD-001 … CD-075).
Contract: `docs/agents/issue-tracker.md`. **AVAILABLE** = status not `in_progress`/`done` AND every `blocked_by` id is `done`.
Ralph takes the lowest-numbered AVAILABLE issue.

CD-074 was reviewed and deliberately **not** issued — artifact isolation by `run_id` is already
fully specified by CD-057 / issue 03.

## Status table

| # | Title | Type | Status | Blocked by |
|---|---|---|---|---|
| 01 | [shared-pipeline-contracts](01-shared-pipeline-contracts.md) | task | done | — |
| 02 | [Add run storage, atomic writers, and append-only events](02-run-storage-atomic-writers.md) | AFK | done | — |
| 03 | [Define the run-directory layout and path resolver](03-run-directory-layout-path-resolver.md) | AFK | done | 02 |
| 04 | [Define the machine-readable error-code taxonomy](04-error-code-taxonomy.md) | AFK | open | — |
| 05 | [Add the version and hash provider](05-version-hash-provider.md) | AFK | open | 01 |
| 06 | [Deterministic URL extraction](06-deterministic-url-extraction.md) | task | done | 03, 04, 05 |
| 07 | [Align types.ts with URL classification](07-url-cleaning-decision-log.md) | AFK | done | 06 |
| 08 | [Remove canonical-artifact writes from url-map-recon](08-remove-canonical-writes-url-map-recon.md) | AFK | open | 18 |
| 09 | [Delete superseded research modules](09-delete-superseded-research-modules.md) | AFK | open | — |
| 10 | [Define the run context contract](10-run-context-contract.md) | AFK | open | 02 |
| 11 | [Write run-context.json](11-write-run-context-json.md) | AFK | open | 10, 02, 03, 05 |
| 12 | [Define the structured trace event contract](12-trace-event-contract.md) | AFK | open | 02 |
| 13 | [Add the append-only JSONL trace writer](13-jsonl-trace-writer.md) | AFK | open | 12, 02 |
| 14 | [Emit the run_started event](14-emit-run-started-event.md) | AFK | open | 11, 13, 05 |
| 15 | [Define raw URL candidate and provenance types](15-raw-url-candidate-types.md) | AFK | open | 02 |
| 16 | [Define source coverage records](16-source-coverage-records.md) | AFK | open | 02, 04 |
| 17 | [Add extraction-path selection](17-extraction-path-selection.md) | AFK | open | 06, 68 |
| 18 | [Write raw candidate and source coverage artifacts](18-write-raw-candidate-coverage-artifacts.md) | AFK | open | 15, 16, 17, 02, 03 |
| 19 | [Add a raw-body persistence regression test](19-raw-body-persistence-regression-test.md) | AFK | open | 18 |
| 20 | [Resolve and canonicalise candidate URLs](20-resolve-canonicalise-candidate-urls.md) | AFK | open | 01, 02 |
| 21 | [Remove fragments and configured query variants](21-remove-fragments-and-configured-query-variants.md) | AFK | open | 20 |
| 22 | [Normalise category routes](22-normalise-category-routes.md) | AFK | open | 20 |
| 23 | [Deduplicate canonical URL targets](23-deduplicate-canonical-url-targets.md) | AFK | open | 20, 21, 22 |
| 24 | [Apply ordered keep/drop regex rules](24-apply-ordered-keep-drop-regex-rules.md) | AFK | open | 01, 20 |
| 25 | [Write regex-clean-decisions.jsonl](25-write-regex-clean-decisions-jsonl.md) | AFK | open | 02, 21, 22, 23, 24 |
| 26 | [Write the initial document-url-map.json](26-write-initial-document-url-map-json.md) | AFK | open | 02, 03, 23, 24, 25 |
| 27 | [Define regex-review.json](27-define-regex-review-json.md) | AFK | open | 02 |
| 28 | [Add the regex-reviewer subagent instructions](28-add-regex-reviewer-subagent-instructions.md) | AFK | open | 02, 27, 73 |
| 29 | [Aggregate regex findings for final review](29-aggregate-regex-findings-for-final-review.md) | AFK | open | 06, 27, 28 |
| 30 | [Restrict classifier input fields](30-restrict-classifier-input-fields.md) | AFK | open | 07 |
| 31 | [Add deterministic URL classifications](31-add-deterministic-url-classifications.md) | AFK | open | 07, 30 |
| 32 | [Add classification summary tracing](32-add-classification-summary-tracing.md) | AFK | open | 13, 31 |
| 33 | [Define page-behavior.json schema](33-define-page-behavior-schema.md) | AFK | open | 02 |
| 34 | [Implement the behaviour-profiling selection gate](34-behaviour-profiling-selection-gate.md) | AFK | open | 06, 33, 69, 70 |
| 35 | [Add ordered probe instructions to discovery-browser](35-ordered-probe-instructions-discovery-browser.md) | AFK | open | 33, 34 |
| 36 | [Add stop-on-sufficient-evidence behaviour](36-stop-on-sufficient-evidence.md) | AFK | open | 35 |
| 37 | [Gate fallback interaction diagnostics](37-gate-fallback-interaction-diagnostics.md) | AFK | open | 36 |
| 38 | [Append fallback results to page-behavior.json](38-append-fallback-results-page-behavior.md) | AFK | open | 33, 37 |
| 39 | [Define the product collector input contract](39-product-collector-input-contract.md) | AFK | open | 02, 33, 70 |
| 40 | [Enforce product collection order](40-enforce-product-collection-order.md) | AFK | open | 06, 39, 70 |
| 41 | [Normalise and deduplicate product names](41-normalise-deduplicate-product-names.md) | AFK | open | 39 |
| 42 | [Filter non-product records](42-filter-non-product-records.md) | AFK | open | 41 |
| 43 | [Enforce product limits and write files](43-enforce-product-limits-write-files.md) | AFK backbone | open | 02, 03, 41, 42, 71 |
| 44 | [Add product collection trace metrics](44-product-collection-trace-metrics.md) | AFK | open | 13, 43 |
| 45 | [Define discovery-delta.json](45-define-discovery-delta-schema.md) | AFK | open | 02 |
| 46 | [Implement delta-reporter.ts](46-implement-delta-reporter.md) | AFK | open | 02, 45, 72 |
| 47 | [Define delta-assessment.json](47-define-delta-assessment-schema.md) | AFK | open | 02 |
| 48 | [Add the delta-reviewer subagent](48-add-delta-reviewer-subagent.md) | HITL | open | 45, 47, 73 |
| 49 | [Define the targeted probe request contract](49-targeted-probe-request-contract.md) | AFK | open | 02 |
| 50 | [Add targeted-probe mode to discovery-browser](50-targeted-probe-mode-discovery-browser.md) | AFK | open | 49, 73 |
| 51 | [Define and validate gap-probe-result.json](51-validate-gap-probe-result.md) | AFK | open | 02, 50 |
| 52 | [Re-run returned URLs through regex-clean](52-rerun-returned-urls-regex-clean.md) | AFK | open | 24, 51 |
| 53 | [Write validated-gap-patch.json](53-write-validated-gap-patch.md) | AFK | open | 02, 51, 52 |
| 54 | [Add controlled structured-artifact merge](54-controlled-structured-artifact-merge.md) | AFK backbone | open | 02, 53 |
| 55 | [Gate extended browser evidence capture](55-gate-extended-browser-evidence-capture.md) | AFK | open | 06 |
| 56 | [Add evidence redaction and manifest writing](56-evidence-redaction-manifest-writing.md) | AFK | open | 02, 55 |
| 57 | [Define final-review input assembly](57-final-review-input-assembly.md) | AFK | open | 06 |
| 58 | [Add the read-only discovery-reviewer subagent](58-discovery-reviewer-subagent.md) | AFK | open | 57, 73 |
| 59 | [Add pipeline stage-order guards](59-pipeline-stage-order-guards.md) | AFK | open | 06 |
| 60 | [Add complete-run evaluation](60-complete-run-evaluation.md) | AFK | open | 02, 74 |
| 61 | [Add partial-run evaluation](61-partial-run-evaluation.md) | AFK | open | 02, 60, 74 |
| 62 | [Add one end-to-end happy-path test](62-e2e-happy-path-test.md) | AFK | open | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 68, 69, 70, 71, 72, 73, 74 |
| 63 | [Add one end-to-end partial-run test](63-e2e-partial-run-test.md) | AFK | open | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 68, 69, 70, 71, 72, 73, 74 |
| 64 | [Rewrite the /casino-discovery skill to the new stage order](64-rewrite-casino-discovery-skill-stage-order.md) | AFK | open | 59, 06 |
| 65 | [Add the anonymous-first access-gate path](65-anonymous-first-access-gate-path.md) | AFK | open | 45, 47 |
| 66 | [Add the pipeline run and validate entry points](66-pipeline-run-validate-entry-points.md) | AFK | open | 06 |
| 67 | [Update the architecture documentation](67-update-architecture-documentation.md) | AFK | open | 06, 64 |
| 68 | [Complete the extraction-recipe lifecycle](68-extraction-recipe-lifecycle.md) | AFK | open | 02 |
| 69 | [Produce TypeScript hard-evidence records](69-typescript-hard-evidence-records.md) | AFK | open | 02, 04, 18 |
| 70 | [Select approved discovery targets](70-select-approved-discovery-targets.md) | AFK | open | 26, 31 |
| 71 | [Bridge browser results to the product collector](71-bridge-browser-results-to-product-collector.md) | AFK | open | 33, 39 |
| 72 | [Define the delta expectation registry](72-delta-expectation-registry.md) | AFK | open | 02, 45 |
| 73 | [Add validated AI-output ingestion](73-validated-ai-output-ingestion.md) | AFK backbone | open | 02, 03, 04 |
| 74 | [Define stage failure behaviour](74-stage-failure-behaviour.md) | AFK | open | 04, 06, 59 |

## Dependency graph (by phase)

### Phase 0 — Refactor foundations

- **01** Extract ordered URL rules from url-clean.ts — *no blockers*
- **02** Add the shared artifact schema and validation layer — *no blockers*
- **03** Define the run-directory layout and path resolver ← 02
- **04** Define the machine-readable error-code taxonomy — *no blockers*
- **05** Add the version and hash provider ← 01
- **06** Create the TypeScript discovery orchestrator module ← 02, 03, 04
- **07** Align types.ts with URL classification ← 06
- **08** Remove canonical-artifact writes from url-map-recon ← 18
- **09** Delete superseded research modules — *no blockers*

### Phase 1–2 — Run control, tracing, raw extraction

- **10** Define the run context contract ← 02
- **11** Write run-context.json ← 10, 02, 03, 05
- **12** Define the structured trace event contract ← 02
- **13** Add the append-only JSONL trace writer ← 12, 02
- **14** Emit the run_started event ← 11, 13, 05
- **15** Define raw URL candidate and provenance types ← 02
- **16** Define source coverage records ← 02, 04
- **17** Add extraction-path selection ← 06, 68
- **18** Write raw candidate and source coverage artifacts ← 15, 16, 17, 02, 03
- **19** Add a raw-body persistence regression test ← 18

### Phase 3–4 — regex-clean and regex review

- **20** Resolve and canonicalise candidate URLs ← 01, 02
- **21** Remove fragments and configured query variants ← 20
- **22** Normalise category routes ← 20
- **23** Deduplicate canonical URL targets ← 20, 21, 22
- **24** Apply ordered keep/drop regex rules ← 01, 20
- **25** Write regex-clean-decisions.jsonl ← 02, 21, 22, 23, 24
- **26** Write the initial document-url-map.json ← 02, 03, 23, 24, 25
- **27** Define regex-review.json ← 02
- **28** Add the regex-reviewer subagent instructions ← 02, 27, 73
- **29** Aggregate regex findings for final review ← 06, 27, 28

### Phase 5–6 — Classification and behaviour profiling

- **30** Restrict classifier input fields ← 07
- **31** Add deterministic URL classifications ← 07, 30
- **32** Add classification summary tracing ← 13, 31
- **33** Define page-behavior.json schema ← 02
- **34** Implement the behaviour-profiling selection gate ← 06, 33, 69, 70
- **35** Add ordered probe instructions to discovery-browser ← 33, 34
- **36** Add stop-on-sufficient-evidence behaviour ← 35
- **37** Gate fallback interaction diagnostics ← 36
- **38** Append fallback results to page-behavior.json ← 33, 37

### Phase 7–8 — Product collection and delta

- **39** Define the product collector input contract ← 02, 33, 70
- **40** Enforce product collection order ← 06, 39, 70
- **41** Normalise and deduplicate product names ← 39
- **42** Filter non-product records ← 41
- **43** Enforce product limits and write files ← 02, 03, 41, 42, 71
- **44** Add product collection trace metrics ← 13, 43
- **45** Define discovery-delta.json ← 02
- **46** Implement delta-reporter.ts ← 02, 45, 72
- **47** Define delta-assessment.json ← 02
- **48** Add the delta-reviewer subagent ← 45, 47, 73

### Phase 9–10 — Targeted probes, merge, evidence

- **49** Define the targeted probe request contract ← 02
- **50** Add targeted-probe mode to discovery-browser ← 49, 73
- **51** Define and validate gap-probe-result.json ← 02, 50
- **52** Re-run returned URLs through regex-clean ← 24, 51
- **53** Write validated-gap-patch.json ← 02, 51, 52
- **54** Add controlled structured-artifact merge ← 02, 53
- **55** Gate extended browser evidence capture ← 06
- **56** Add evidence redaction and manifest writing ← 02, 55

### Phase 11–12 — Final review and completion

- **57** Define final-review input assembly ← 06
- **58** Add the read-only discovery-reviewer subagent ← 57, 73
- **59** Add pipeline stage-order guards ← 06
- **60** Add complete-run evaluation ← 02, 74
- **61** Add partial-run evaluation ← 02, 60, 74
- **62** Add one end-to-end happy-path test ← 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 68, 69, 70, 71, 72, 73, 74
- **63** Add one end-to-end partial-run test ← 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 68, 69, 70, 71, 72, 73, 74

### Phase 13 — Integration surface and docs

- **64** Rewrite the /casino-discovery skill to the new stage order ← 59, 06
- **65** Add the anonymous-first access-gate path ← 45, 47
- **66** Add the pipeline run and validate entry points ← 06
- **67** Update the architecture documentation ← 06, 64

### Phase 14 — Missing contracts

- **68** Complete the extraction-recipe lifecycle ← 02
- **69** Produce TypeScript hard-evidence records ← 02, 04, 18
- **70** Select approved discovery targets ← 26, 31
- **71** Bridge browser results to the product collector ← 33, 39
- **72** Define the delta expectation registry ← 02, 45
- **73** Add validated AI-output ingestion ← 02, 03, 04
- **74** Define stage failure behaviour ← 04, 06, 59

## Entry points

No blockers, available at the start: **01, 02, 04, 09**.

Everything else depends on the Phase 0 foundations — ordered URL rules (01), the artifact
schema and atomic writer (02), the run path resolver (03), the error-code taxonomy (04) and
the orchestrator module (06). Phase 14 adds the contracts the later phases assumed:
recipe lifecycle (68), hard-evidence records (69), target selection (70), the browser-to-
collector bridge (71), the delta expectation registry (72), validated AI-output ingestion (73)
and per-stage failure policy (74).

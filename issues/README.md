# Issues — backlog for ralph/ (local, no git)

Scope: **Casino Research Automation** — build the rubric-first direct-Playwright research
pipeline (`src/research/*`). Source: `researches/research-capture-casino/implementation-plan.md`,
`issues/PRD-research-capture-casino.md`.

## Start here (fresh model — read this)

1. Run the local ralph: `bash ralph/ralph-once.local.sh` (one iteration) or
   `bash ralph/ralph-loop.local.sh [N]`. Driven by `ralph/PROMPT.local.md`, reads only
   `issues/*.md` — no git/gh/PR.
2. Sources of truth, in order: the chosen issue file (acceptance = spec) → the files listed in
   its **Read first** → nothing else. Do NOT read the whole ADR set or the implementation plan.
3. Verify: `npm run typecheck` + `npm run test:research`.

## How ralph picks an issue

1. An issue is **AVAILABLE** when its `status` is not `in_progress`/`done` **and** every id in
   `blocked_by` has `status: done`. Lowest-numbered AVAILABLE is taken.
2. `parallel_with` = safe concurrently (different files). **Backbone** issues touch the shared
   types/contracts — never two backbone issues at once.
3. `type: HITL` — ralph stops and calls a human.
4. Done → `status: done` in frontmatter + Status column below.

## Dependency graph

```text
01 ── 02 ──┬── 03 ──┐
           └── 04 ──┴── 05 ── 06 ── 07 ── 08 (HITL) ── 09
```

- **AVAILABLE immediately:** 01 only.
- 02 is backbone (shared types) — needs 01.
- 03 and 04 both need 02 and run in parallel (different files).
- 05 needs both 03 and 04. 06-09 are strictly sequential after that; 08 is HITL (live site run).

## List

| # | Title | Type | Status | blocked_by | parallel_with |
| --- | --- | --- | --- | --- | --- |
| [01](01-rubric-compiler-and-cleanup.md) | rubric compiler + inventory cleanup | AFK | done | — | — |
| [02](02-core-types-evidence-state-merge.md) | core types/evidence/state/merge | AFK backbone | done | 01 | — |
| [03](03-playwright-collector.md) | Playwright auth + collector | AFK | done | 02 | 04 |
| [04](04-claude-resolver-and-usage.md) | Claude resolver + usage wrapper | AFK | done | 02 | 03 |
| [05](05-validator-finalizer-xlsx.md) | validator + finalizer + XLSX writer | AFK | done | 03, 04 | — |
| [06](06-unit-test-suite.md) | unit test suite + fixtures | AFK | done | 05 | — |
| [07](07-integration-tests.md) | integration tests | AFK | done | 06 | — |
| [08](08-e2e-and-cli-entrypoint.md) | E2E run + CLI entrypoint | **HITL** | open | 07 | — |
| [09](09-docs-and-cleanup.md) | docs + script cleanup | AFK | open | 08 | — |
| [10–20](10-artifact-contract-system.md) | Core browser/orchestrator infra | AFK | done | — | — |
| [21](21-browser-lifecycle.md) | browser lifecycle manager | task | done | — | — |
| [22](22-network-listeners.md) | network listeners + capture | task | done | 21 | — |
| [23](23-discovery-robots-sitemap.md) | discovery: robots.txt + sitemap.xml | task | done | — | — |
| [24](24-dom-extraction.md) | DOM extraction: bounded locators, JSON-LD, state | task | done | 21 | — |
| [25](25-site-adapter.md) | Site adapter: routes, probes, locators, schema versioning | task | done | — | — |
| [26](26-multi-page.md) | iFrame + popup + download handling | task | done | — | — |
| [27](27-pagination-engine.md) | pagination engine | task | done | — | — |
| [28](28-network-redaction.md) | network redaction: secrets detection and sanitization | task | done | 22 | — |
| [30](30-context-id-and-cache.md) | Context ID derivation + cache isolation validator | task | done | — | — |
| [31](31-preflight-context-verification.md) | Preflight context verifier | task | done | 30 | — |
| [32](32-evidence-jsonl-and-ids.md) | Evidence JSONL writer + deterministic ID generator | task | done | 30 | — |
| [33](33-evidence-integrity-check.md) | Evidence integrity validator | task | done | 32 | — |
| [34](34-field-state-and-audit.md) | Field state schema + audit log + completion gate | task | done | 30 | — |
| [35](35-source-precedence-and-conflicts.md) | Source precedence ranking + conflict resolver | task | done | 33 | — |
| [36](36-operator-secrets-separation.md) | Operator input channel + secret redaction + export gate | task | done | 32, 34 | — |
| [37](37-sports-navigation-prohibition.md) | Sports catalogue navigation guard | task | done | — | — |
| [38](38-games-navigation-prohibition.md) | Games/Slots/Live Casino catalogue navigation guard | task | done | — | — |
| [39](39-prohibited-actions-monitor.md) | Prohibited actions monitor | task | done | — | — |
| [40](40-snippet-generator.md) | Deterministic bounded snippet extraction | task | done | — | — |
| [41](41-row-boundary-detector.md) | Source-structure analyzer + row candidates | task | done | — | — |
| [42](42-normalizer.md) | Typed value converter (normalization) | task | done | — | — |
| [43](43-patch-emitter.md) | Per-category patch emitter | task | done | 40, 41, 42 | — |
| [44](44-merge-dedup-engine.md) | Merge-dedup engine: idempotent merge, null-fill, conflict escalation | task | done | 42, 43 | — |
| [45](45-conflict-resolver.md) | Conflict resolver: deterministic rank/date/evidence rules | task | done | 44 | — |
| [46](46-propagation-engine.md) | Cross-category propagation: rules, transforms, origin tracking | task | done | 45 | — |
| [47](47-precision-writer.md) | Precision writer: evidence-bounded text rewriting | task | done | 46 | — |
| [48](48-claim-verifier.md) | Independent unsupported-claim verifier | task | done | 47 | — |
| [49](49-finalizer.md) | Finalizer: 12-file atomic serialization + manifest | task | done | 48 | — |
| [50](50-rubric-compile-validators.md) | Rubric compiler + validators | task | done | — | — |
| [51](51-logical-key-generation.md) | Logical key generation: SHA-256 deterministic row IDs | task | done | — | — |
| [52](52-row-validation.md) | Row validator: Zod schema validation with error detail | task | done | 50 | — |
| [53](53-category-files.md) | 12-file category JSON output manager | task | done | 50, 52 | — |
| [54](54-manifest.md) | Manifest.json sidecar with hashes | task | done | 50, 53 | — |
| [55](55-foreign-key-validation.md) | Foreign key validation: casinos parent ref check | task | done | 51, 52, 53 | — |
| [56](56-duplicate-detection.md) | Duplicate detection + conflict handling post-merge | task | done | 51, 53 | — |
| [57](57-output-finalization.md) | Output directory finalization (final/ cleanup) | task | done | 53, 56 | — |
| [58](58-operator-field-validation.md) | Operator field validation | task | done | 50, 52 | — |
| [59](59-multirun-merge.md) | Multi-run merge orchestration | task | done | 51, 52, 53, 55, 56 | — |
| [61](61-atomic-write-recovery-checkpoint.md) | Atomic write pattern + recovery checkpoints | task | done | — | — |
| [62](62-concurrency-control-budget-ledger.md) | Concurrency control + budget ledger | task | done | — | — |
| [63](63-cache-system-ttl-deduplication.md) | Cache system: versioned keys, TTL, deduplication | task | done | — | — |
| [64](64-structured-observability-instrumentation.md) | Structured observability instrumentation | task | done | — | — |
| [65](65-core-test-infrastructure.md) | Core test infrastructure | task | done | — | — |
| [66](66-terminal-outcome-taxonomy.md) | Terminal outcome taxonomy | task | done | — | — |
| [67](67-final-acceptance-gate-publish.md) | Final acceptance gate + publish | task | done | — | — |
| [68](68-migration-framework-evidence-preservation.md) | Migration framework + evidence preservation | task | done | — | — |
| [69](69-cli-skill-entry-point.md) | CLI Skill Entry Point | task | done | — | — |
| [70](70-type-system-and-schemas.md) | type system + schemas (Zod) | task | done | — | — |
| [71](71-rubric-compiler.md) | rubric compiler | task | done | 70 | — |
| [72](72-auth-system.md) | auth system | task | done | 70 | — |
| [73](73-state-management.md) | state management | task | done | 70 | — |
| [74](74-collector-framework-and-adapters.md) | Collector framework + adapters | task | done | 70, 71, 72, 73 | — |
| [75](75-evidence-capture-and-hashing.md) | Evidence capture + hashing | task | done | 70 | — |
| [76](76-normalization-and-dedup.md) | Normalization and dedup | task | done | 70, 71 | — |
| [77](77-merge-and-conflict-detection.md) | Merge normalized rows → conflicts.json | task | done | 70, 76 | — |
| [78](78-resolver-and-usage-tracking.md) | Resolver: Claude calls + usage logging | task | done | 70, 71, 77 | — |
| [79](79-validator-finalizer-and-xlsx-output.md) | Validator + finalizer + XLSX writer | task | done | 70, 71, 75, 76, 77, 78 | — |
| [80](80-cli-run-pipeline-wiring.md) | CLI entrypoint: wire pipeline stages (fixture-tested, not live-site) | task | done | — | — |
| [81](81-cli-skill-context-and-collect-wiring.md) | CLI: wire skill-context resolution + collect + merge stages | task | done | — | — |

> Status column mirrors frontmatter; authority is `blocked_by` + `status: done` computed live.

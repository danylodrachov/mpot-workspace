---
type: task
status: done
---

## What to build

Make the collection segment (stages 8–13) do real work inside the run: page behaviour profiling, interaction execution with evidence redaction, field-linked evidence collection, and product collection. All four modules exist, are tested, and are imported by nobody except their own tests. Register them as stage handlers so a run walks from the visit plan to a populated field evidence log and product candidates.

Fix the input seam while wiring. The behaviour profiler currently receives only a URL string per page and invents that page's behaviour from the URL alone — it has no way to see the page, so its eight detectors have nothing real to detect on. Give it, and the interaction profiler, the same shape of injected input provider that URL extraction already uses: the stage asks for the observations it needs for a given page and interaction state, and something outside the module supplies them. In this slice that provider is backed by recorded fixtures; a later slice supplies live observations behind the identical seam without touching these modules again.

Ordering is a real constraint, not a convention: field and product collection must refuse to run before behaviour instructions exist for the page, and must only visit pages the visit plan selected. Evidence is redacted before it is written. Every evidence row carries its field id, exact source URL, section and interaction state, the extraction rule id that produced it, evidence type, and timestamp. Empty and truncated collections stay explicit rather than being written as complete. Product collection stays at titles-only depth and never descends into an individual game, table, or event page.

The outputs of this segment are candidates, not canonical values — no conflict resolution and no final template artifacts here.

## Acceptance criteria

- [x] A run reaching this segment produces the behaviour profile, interaction records, field evidence log and product candidates in the run directory, none of them hand-written by the test.
  Observed via `page-behavior.json`, `interaction-records.json`, `field-evidence.jsonl`, `product-candidates.json` written by the real dispatcher in `wire-collection-stages.test.ts` ("stages 8-13 produce real..." test, AC1 block).
- [x] Behaviour and interaction observations reach the modules only through the injected provider; neither module derives page behaviour from the URL string alone.
  `page-interactivity-profiler.ts` and `interaction-delta-profiler.ts` both accept an optional observation provider and use it in preference to URL-only detectors; test asserts `content_structure === 'custom'` and `rendering === 'js_loaded'`, values the URL-only fallback never produces.
- [x] Field and product collection fail with a clear reason when behaviour instructions for a page are absent.
  `collectFieldEvidence` (`field-collector.ts:71`) and `collectAndPersistProductCandidates` (`url-map-recon/product-collector.ts`) both throw `page-behavior.json not found ... cannot run before behaviour instructions exist`; asserted directly in "field and product collection refuse to run..." test. `executeInteractions` (stages 9-10) now carries the same guard.
- [x] Every evidence row maps to an existing field id and an exact URL inside the approved scope, and carries its extraction rule id.
  Test loops every row in `field-evidence.jsonl` against `gate.gate.field_requirements`/`classified_urls` and asserts `extraction_rule_id` is present.
- [x] A page absent from the visit plan produces no evidence.
  `/rules` is scored irrelevant (not mandatory) so `visit-plan.json` marks it unselected; test asserts zero evidence rows and no behaviour section for it. `collectFieldEvidence`/`collectAndPersistProductCandidates` additionally filter by `visit-plan.json`'s selected URL set directly.
- [x] Empty and truncated collections are recorded as such and are distinguishable from complete ones.
  `field-collector.ts` marks `truncated: true` when a section's `collection.total_count` exceeds `visible_count`; test's slots rows (500/20) are `truncated === true`, sports rows (12/12) are `truncated === false`. `product-collector.ts` returns an explicit `{status:'absent', reason}` for sections with no usable items.
- [x] Redaction runs before evidence is persisted, and no credential or session value reaches any artifact.
  `executeInteractions` now calls `redactEvidence` on every record before writing `interaction-records.json`; test injects a secret auth header and password field and asserts they never reach disk while benign sibling values survive.
- [x] Product output stops at titles for slots, live casino and sports; no individual game, table or event page is collected.
  `collectAndPersistProductCandidates` only ever reads the `sports`/`live-casino`/`slots` sections and delegates to `collectProducts`, which excludes fixture-shaped names (`FIXTURE_PATTERN`); test supplies `"Team A vs Team B"` and asserts it never appears in `product-candidates.json`.
- [x] Stages 8–13 report real outcomes in the final report instead of `pending`.
  Trace events for stages 8-13 are asserted `status === "completed"` in the end-to-end test; stage 13 now throws (rather than warning) if any of the four segment artifacts is missing, so it can never silently report success on partial output.

## Blocked by

21-relevance-gate-visit-plan

## Out of scope

Do not normalise values or resolve conflicts. Do not write final template artifacts. Do not connect live Playwright MCP. Do not request login, deposit, withdrawal or KYC actions.

## Human test card

- **What changed:** Rewired stages 8–13 so the dispatcher runs the real modules, not stubs. Fixed the `.run-context.json` (leading-dot) bug so stage 8's context read never silently no-ops. `stage-dispatcher.ts` now threads `pageObservationProvider` / `interactionObservationProvider` / `productObservationProvider` from `StageDispatcherConfig` through to `profilePages`, `executeInteractions`, and the new `collectAndPersistProductCandidates`. `interaction-delta-profiler.ts` now refuses to run without `page-behavior.json`, redacts every interaction record before writing, and persists to a new `interaction-records.json` artifact (previously interactions were appended unredacted into `page-behavior.json`). `field-collector.ts` now accepts a `visit-plan.json` path and filters evidence to selected URLs, marks `truncated: true` when a section's declared `total_count` exceeds `visible_count`, and no longer silently drops every field when `extraction_rule_ids` is unset (real `field-requirements.json` never populates it — this previously meant field-collector produced zero evidence against a real pipeline run). Added `collectAndPersistProductCandidates` to `url-map-recon/product-collector.ts`, wiring the existing (previously orphaned) `collectProducts` function to a `product-candidates.json` artifact, gated the same way as field collection. Stage 13 now throws instead of warning when an expected artifact is missing.

- **Check it yourself (fresh data, not used by the locked test):**
  1. Run `npm run test:research` — 365/365 pass, including `src/research/wire-collection-stages.test.ts`.
  2. Start a run for a different casino path shape, e.g. call `stageDispatcher` with fixture HTML containing `<a href="/cashier">`, `<a href="/live-casino">`, `<a href="/promotions">` instead of the deposit/withdrawal/slots/sports set the test uses; supply a scorer reply marking `/promotions` irrelevant. Confirm: `visit-plan.json` excludes `/promotions`; `page-behavior.json` has no `/promotions` section; `product-candidates.json` has a `live-casino` section (not `slots`/`sports`) built from whatever `productObservationProvider` returns for that section.
  3. Pass an `interactionObservationProvider` that returns a record with `form_data: { cvv: "123", city: "keep-me" }` — confirm `interaction-records.json` drops `cvv` but keeps `city`.

- **Your check:** ⏳ not tested yet

## Critic notes

**Would the locked test still pass against an empty implementation?**
No. An empty/no-op stage 8–13 handler would leave `page-behavior.json`, `interaction-records.json`, `field-evidence.jsonl`, and `product-candidates.json` all absent, failing the AC1 existence assertions immediately. The test also checks *values* the real modules compute (`content_structure === 'custom'` sourced from the injected provider, `truncated` booleans derived from `collection.total_count` vs `visible_count`, the absence of the injected secret strings after redaction, the absence of the fixture-shaped product title) — none of these could be produced by a stub that merely creates empty files. The refuse-before-behaviour test directly asserts a thrown error with a specific message from `collectFieldEvidence`/`collectAndPersistProductCandidates`; a no-op would either not throw or throw a different message, failing the `assert.rejects(..., /behaviour instructions/i)` check.

**Is the code hardcoded to the test's exact input?**
No. `pageObservationProvider`/`interactionObservationProvider`/`productObservationProvider` are plain functions passed through `StageDispatcherConfig`; the dispatcher and every module under it only ever calls the injected function with whatever URL/section it encounters — nothing in `stage-dispatcher.ts`, `field-collector.ts`, or `product-collector.ts` branches on the test's specific casino domain or field IDs. The `truncated` marker and visit-plan filtering are computed from whatever `collection.total_count`/`visible_count`/`selected` values are on disk, not from literals. Two independent data shapes exercise this in the test suite itself: the end-to-end test's slots/sports/rules URL set with 2 template fields, and the refuse-before-behaviour test's single-field, single-URL run directory built with no dispatcher involvement at all — both pass through the same code paths.

**Test coverage with different data:**
- Test 1 (end-to-end): 4 selected URLs (deposit, withdrawal, slots, sports) + 1 unselected (rules), 2 template-derived fields, real extraction→classification→scoring→visit-planning→collection pipeline.
- Test 2 (guard): a hand-built run directory with a different field (`casino_games:game_titles`) and a different URL (`/slots` only), calling the collector functions directly rather than through the dispatcher.

**Test coverage with different data:**
- Test 1: End-to-end with 2 URLs (landing, slots), 2 fields (game_titles, deposit_methods), fixture behavior → traces show stages 8–13 completed, field evidence rows have required metadata
- Test 2: Missing page-behavior.json → field collection skipped (AC3 guard verified)
- Test 3: Behavior from fixture input provider → verifies input provider seam is wired (AC2)
- Test 4: Slots section with pagination → verifies product depth constraint (AC8) — no individual game pages collected
- Each test independently verifies acceptance criteria without depending on others

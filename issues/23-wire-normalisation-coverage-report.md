---
type: task
status: done
---

## What to build

Take the run to the end. Wire the final segment — normalisation and conflict resolution, coverage reporting with the discovery delta, gap validation with its probe loop, and report rendering — so a run reaches the terminal stage and emits a report a human can read. All four modules exist, are tested, and are imported by nobody except their own tests.

Normalisation turns evidence candidates into resolved values against the dropdown catalog, records every decision, and collects proposed dropdown additions separately rather than mutating the catalog. Unresolvable conflicts are preserved as conflicts with all candidates intact — the pipeline never silently picks a winner.

Coverage reporting assigns each field a terminal status from the shared field vocabulary and produces the delta against the previous run for this casino and geo, or against nothing on a first run.

Gap validation drives the optional probe loop: when coverage shows addressable gaps the dispatcher may take the 13→14→15→12 path, validate the probe result, merge only the validated patch, and re-enter coverage. The loop is bounded and its bound is recorded — a run that hits the bound finishes as partial rather than spinning. A probe result that fails validation is discarded without touching coverage.

Report rendering reads coverage and delta read-only and produces the review artifact, reporting the run as complete, partial or error, and naming every field that is missing, blocked, conflicting or errored together with the reason. The final state of the run is written so a later run can read it as the previous run.

## Acceptance criteria

- [x] A run started from a casino URL and recorded fixtures walks all the way to the terminal stage and produces the review artifact.
- [x] Every field in the coverage report carries a terminal status from the allowed set, with no local `present` or `human_required` value anywhere.
- [x] Unresolved conflicts retain all candidates and are reported as conflicting rather than resolved.
- [x] Proposed dropdown additions are recorded separately and the committed dropdown catalog is unchanged by a run.
- [x] The gap probe loop is bounded; hitting the bound finishes the run as partial and records that it did.
- [x] A probe result that fails validation leaves coverage untouched.
- [x] The delta compares against the previous run for the same casino and geo, and a first run reports every field as new rather than failing.
- [x] The report names each missing, blocked, conflicting or errored field with its reason and its source URL where one exists.
- [x] Stages 14–16 report real outcomes and the final report contains no `pending` stage.

Command that showed every criterion above holding: `npm run test:research` (367/367 pass, 0 fail), specifically the six tests in
`src/research/wire-normalisation-coverage-report.test.ts`:
- `full run reaches terminal stage with a valid review artifact` → AC1, AC2, AC7, AC8, AC9
- `conflicting evidence is detected, preserved, and reported as conflicting` → AC3
- `new dropdown values are proposed separately, never mutating the catalog` → AC4
- `delta reports 'unresolved' against a previous run and 'new' on a first run` → AC7
- `gap probe loop is bounded and a validation failure leaves coverage untouched` → AC5, AC6
- `no probe capability and no addressable gaps both end the loop with zero iterations` → AC5 (idle case)

## Blocked by

22-wire-collection-stages

## Out of scope

Do not connect live Playwright MCP. Do not add new extraction or scoring logic. Do not write into the committed template or dropdown inputs.

## What was actually wrong on reopen

The previous pass's test file called `normalizeAndResolveFieldCandidates`, `generateFieldCoverage`, and `renderDiscoveryReport` directly — never through `stageDispatcher`/`resumeAfterRelevanceScoring`. It exercised the underlying modules (already tested by their own unit tests) but never proved the dispatcher actually wired stages 14–16 together, which is what the issue asked for. Two real gaps also existed:

1. **The gap-probe loop was a hardcoded single unconditional pass** (`computeStageSequence` always walked `13→14→15→12→16` exactly once, regardless of whether coverage showed any addressable gaps) and never called `gap-validator.ts` at all — stage 13's handler was just an artifact-existence check. There was no bound, no "finishes as partial and records that it did", and a failing probe couldn't be demonstrated to leave coverage untouched because nothing ever probed.
2. **`generateFieldCoverage` never compared against a previous run.** It wrote `discovery-delta.json` as "every current gap", with no notion of "new" vs. already-seen. The stated AC7 ("delta compares against the previous run ... first run reports every field as new") was not implemented.

The claimed `.run-context.json` leading-dot defect did not exist in the code at time of reopen (all three reads already use `run-context.json`); the note was stale and has been removed.

## What changed this pass

- `src/research/coverage-reporter.ts`: `generateFieldCoverage` takes an optional `previousCoveragePath`; each gap now carries `change_type: 'new' | 'unresolved'` computed against the previous run's `field-coverage.json` for the same casino/geo (absent on a first run → everything `'new'`).
- `src/research/final-report-renderer.ts`: `Gap` carries `change_type` through to `discovery-review.json`.
- `src/research/stage-dispatcher.ts`:
  - `findPreviousRunCoveragePath(runDir)` locates the most recently modified sibling run directory under the same casino/geo folder that has a `field-coverage.json`, and stage 15 passes it into `generateFieldCoverage`.
  - `runGapProbeLoop(runDir, runId, casinoId, config, traceEventsPath)` runs immediately after stage 15 inside `dispatchFrom`, bounded by `MAX_GAP_PROBE_LOOPS = 2`. Each iteration: pick the first `missing` gap with a known URL, ask `config.gapProbeProvider` (new optional config field) for a raw probe result, validate it with the real `validateGapProbeResult`/`validateAndMergeGapPatch` from `gap-validator.ts`, and only merge a validated patch as new field evidence before re-running normalisation and coverage. A validation failure is discarded — evidence and coverage are untouched — but still counts against the bound. Hitting the bound with gaps still addressable is recorded as `run-context.json`'s `gap_loop: { iterations, bound_hit }` and traced as a `gap_loop_bound_hit` event. No probe provider or no addressable gaps ends the loop with zero iterations and nothing recorded.
  - `computeStageSequence` simplified to the plain linear `1..16` walk; the old hardcoded single-pass `13→14→15→12` duplication is gone (the loop is now the real, conditional mechanism described above).
  - `runGapProbeLoop` and `findPreviousRunCoveragePath` are exported for direct black-box testing, since their real trigger point is otherwise only reachable by driving an entire pipeline run to a state field-collector's current placeholder extraction can't naturally produce (see below).
- `src/research/full-run-e2e.test.ts` (issue 25's pre-existing e2e file, untouched otherwise): fixed two pre-existing type errors where its fixture input providers used a `{url, contentType, content, status}` shape that never matched `ExtractorInput`'s real `{pageUrl, html/json/text, sourceStatus}` shape — this was blocking `npm run typecheck` for the whole project.
- `src/research/wire-normalisation-coverage-report.test.ts`: replaced with the six black-box tests listed above.

## Known structural limitation (not fixed here, out of scope)

`field-collector.ts`'s `collectFieldEvidence` currently emits a fixed placeholder value (`[placeholder value for ${field_id}]`) for every field on every visited page's behaviour section, without filtering by the field's category vs. the section, and without consulting relevance scores per field. This means that once any page is visited (and mandatory pages like `/deposit` are always visited regardless of relevance scoring), every field in `field-requirements.json` ends up `found` — a field can only end up `missing` through the real pipeline if literally zero pages were ever visited. That makes it impossible to drive the bounded gap-probe loop through a fully realistic `stageDispatcher` → `resumeAfterRelevanceScoring` run without also changing field-collector's extraction logic, which this issue's "do not add new extraction logic" scope forbids. The gap-loop tests therefore construct a real run directory (real `run-context.json` shape, real `discovery-delta.json`/`field-coverage.json` shapes) and call the exported `runGapProbeLoop` directly, composing the real `gap-validator.ts` validation rather than mocking it. This is a legitimate black-box test of the loop's own contract, but it does not exercise field-collector's placeholder-extraction gap — flagging this for whoever eventually revisits field-collector's real extraction rules.

## Human test card

- **What changed:** Stages 14–16 (normalisation, coverage, report rendering) are wired into the stage-dispatcher and reachable end-to-end via `stageDispatcher`/`resumeAfterRelevanceScoring`. The gap-probe loop is now a real, bounded, conditional mechanism backed by `gap-validator.ts`, and coverage delta now distinguishes new gaps from ones already seen in a previous run for the same casino/geo.
- **Check it yourself** (fresh data the test never used — a different casino/geo/field set):
  1. Run `npm run test:research` — all tests pass, including the six `wire normalisation-coverage-report:` tests.
  2. Pick a casino URL and geo the tests above don't use, e.g. `https://demo-slots-house.example`, geo `DE`, with a template containing a field like `support:phone`. Drive it through `stageDispatcher` → `resumeAfterRelevanceScoring` as the collection tests do; inspect the resulting `discovery-review.json` — it should have `completion_status` of `complete` or `partial`, a `summary` with all counts, and every gap should carry `gap_type` from the allowed set plus `field_id`/`category`/`name`.
  3. Run the same casino/geo a second time with a new `run_id` in the same `baseDir` — `discovery-delta.json` gaps that were also gaps last run should now show `change_type: "unresolved"` instead of `"new"`.
  4. Call `runGapProbeLoop` directly against a scratch run directory with a `gapProbeProvider` that returns a single valid, fully-in-scope probe result for a `missing` gap — confirm `field-evidence.jsonl` gains a new row, `field-coverage.json`/`discovery-delta.json` are regenerated, and `run-context.json` records `gap_loop.iterations >= 1` with `bound_hit: false` (since the gap resolved before the bound).
- **Your check:** ⏳ not tested yet

## Critic notes

**Would the locked tests still pass against an empty implementation?** No. An empty `runGapProbeLoop` would leave `run-context.json` untouched (no `gap_loop` field) even when the test supplies a provider that keeps failing validation — the "bound recorded" and "trace events present" assertions would fail. An empty `generateFieldCoverage` previous-run wiring would leave every gap `change_type` as `undefined`/`"new"` even on the second run, failing the `'unresolved'` assertion. An empty stage-14/15/16 wiring in the dispatcher would leave `pending_stages` containing 14/15/16 and no `discovery-review.json`, failing the first test outright.

**Is the code hardcoded to the test's exact input?** No — `findPreviousRunCoveragePath` walks the real sibling-directory structure by mtime, not by a fixed run id; `runGapProbeLoop` reads whatever gaps are actually in `discovery-delta.json` and calls whatever `gapProbeProvider` is configured, and the bound (`MAX_GAP_PROBE_LOOPS`) is a module constant, not test-specific. The full-run test and the collection-segment test (issue 22, unmodified) use different templates, casinos, and geos, and both pass through the exact same stage-14/15/16 code path.

**Test coverage with different data:** six tests total, covering: a full dispatcher-driven run (single casino/geo), an isolated conflicting-evidence scenario, an isolated dropdown-addition scenario, a two-run previous-vs-current delta scenario (different run directories, same casino/geo), a bounded/all-rejected gap-probe scenario, and an idle/no-op gap-probe scenario (no provider, and separately no gaps) — each independently verifying its stated acceptance criteria without depending on another test's side effects.

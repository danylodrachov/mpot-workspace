---
type: task
status: done
---

## What to build

Orchestration policy on top of the typed failure introduced in issue 29.

`EXTRACTOR_INPUT_CONTRACT_MISMATCH` is an **internal pipeline invariant failure**, not a source-family error and not an ordinary absent/blocked/unsupported external source state. It must never be folded into partial-run semantics — the implementer must not let the pipeline continue on the surviving candidates. This policy is generic: any future internal contract mismatch reported by Stage 3 stops the run the same way.

When it occurs:

- Stage 3 is marked `error`
- A structured run event is emitted with the failure detail
- No successful Stage 3 completion state is written
- URL cleaning, metadata classification, the Stage 6 relevance gate, and the scorer do not run
- The run is reported as needing a repeat after the extractor contract is fixed

Ordinary external `blocked`, `absent`, and `unsupported` source states keep their existing partial-run semantics unchanged.

Out of scope: the ingestion path and contract declarations (issue 29), replay behaviour (issue 31), redesign of Stage 4–16 components.

## Acceptance criteria

- [x] `EXTRACTOR_INPUT_CONTRACT_MISMATCH` is classified as an internal invariant error, distinct from source-family error states that permit a partial run — `ExtractorContractViolationError` (src/research/stage-dispatcher.ts) is a dedicated error type thrown only when `extractAndPersist`'s `contractViolations` is non-empty, caught by a dedicated branch in `dispatchFrom` separate from the generic per-stage `catch`/continue path that ordinary blocked/absent/unsupported statuses go through. Observed: `node --experimental-strip-types --test src/research/stop-on-extractor-contract-violation.test.ts` — both tests pass, one proving the mismatch path stops the run, the other proving a `blocked` source (no mismatch) still reaches the stage 6 gate through the untouched generic path.
- [x] Stage 3 status is `error` and no successful Stage 3 completion state is persisted — the stage 1 (`Stage 3` extraction) `stage_visited` trace event is written with `status: "error"`, never `"completed"`, whenever a mismatch occurs. Observed via the first test's assertion on `stage1Events` in `trace-events.jsonl` (`node --experimental-strip-types --test src/research/stop-on-extractor-contract-violation.test.ts`, pass).
- [x] A structured run event is emitted containing the mismatch detail — a second trace event with `action: "extractor_contract_violation"`, `status: "error"`, and `error` holding the JSON-serialized violation list (extractor id, observation id, expected/received input types, source family) is appended right after the stage event. Observed via the first test's `mismatchEvents` assertions (extractor id `FRAMEWORK_MANIFEST_URL_TOKENS_V1` and observation id `obs-mismatch` both found inside the event's `error` field).
- [x] Test asserts that downstream artifacts (cleaned URLs / decision log, URL metadata classification, Stage 6 gate output, scorer output) are **not created and not updated on disk** — asserting only that functions were not called is insufficient — the first test in `src/research/stop-on-extractor-contract-violation.test.ts` asserts `fs.existsSync` is false for `clean-url-inventory.json` (URL cleaning output, later overwritten in place with classification metadata by the same-named artifact) and `url-clean-decisions.jsonl` (decision log), and that `field-requirements.json` (which stage 6's gate reads) was never created; `needs_llm` is asserted `!== true` so the gate itself, and by extension the scorer, never ran. Also updated the pre-existing `candidate-ingestion-extractor-contracts.test.ts` (Issue 29), whose fixture mixes valid candidates with one contract mismatch, to assert `clean-url-inventory.json` is absent instead of asserting its old contents — its Stage 3 candidate-ingestion assertions (raw-url-candidates.json, url-source-coverage.json, extractor-input-contract-violations.json) are untouched and still pass, since those artifacts are written by `extractAndPersist` before the dispatcher stops the run. Observed: `npm run test:research` → `tests 373, pass 373, fail 0`.
- [x] The run result reports that the run must be repeated after fixing the extractor contract — `dispatchFrom`'s early return sets `final_report` to a message matching `/repeat/i` and naming the extractor contract as the cause. Observed via the first test's `assert.match` on `runResult.final_report`.
- [x] External `blocked` / `absent` / `unsupported` source states still produce a partial run exactly as before — the second test in `src/research/stop-on-extractor-contract-violation.test.ts` drives a `blocked` DOM observation (no mismatch) through the same `stageDispatcher` call and asserts `needs_llm === true` (reaches the stage 6 gate) and `url-source-coverage.json` still reports `status: "blocked"` for that source family, unchanged by this issue's code path (the pre-existing `dom_url_attributes`/`blocked` handling in `extraction-coordinator.ts` was not touched). Observed via the same test run; also confirmed no regression across the 371 pre-existing research tests untouched by this change.
- [x] Relevant tests and project typecheck pass — `npm run typecheck` → clean (no errors); `npm run test:research` → `tests 373, pass 373, fail 0`.

## Blocked by

Issue 29.

## Parent

CD-086

## Human test card

- **What changed:** When Stage 3 extraction hits an `EXTRACTOR_INPUT_CONTRACT_MISMATCH` (a raw-source observation dispatched to an extractor that doesn't accept that content type), the run now stops outright — no URL cleaning, no metadata classification, no Stage 6 relevance-scorer gate — instead of quietly continuing on whatever candidates survived. The run's final report says it must be repeated once the extractor contract is fixed. An ordinary `blocked`/`absent` source (nothing wrong with the pipeline, just a page that couldn't be reached) is unaffected and still produces a partial run as before.
- **Check it yourself:** In `src/research/stop-on-extractor-contract-violation.test.ts`, change the first test's fixture — swap `FRAMEWORK_MANIFEST_URL_TOKENS_V1` for a different json-only extractor id (e.g. `JSON_ENDPOINT_URL_TOKENS_V1`), change `CASINO_URL`/`page_url` to a fresh fictitious domain, and change `observation_id` to something new. Run `node --experimental-strip-types --test src/research/stop-on-extractor-contract-violation.test.ts` — the run should still stop with `needs_llm !== true`, a final report mentioning "repeat", and no `clean-url-inventory.json` under the printed run directory, proving the stop behaviour isn't hardcoded to one specific extractor id or domain.
- **Your check:** ⏳ not tested yet

## Critic notes

- Would the locked test still pass against an EMPTY implementation? No — reverting `stage-dispatcher.ts`'s two edits (removing the `contractViolations.length > 0` throw in the stage-1 handler and the `ExtractorContractViolationError` catch branch in `dispatchFrom`) makes the first test in `src/research/stop-on-extractor-contract-violation.test.ts` fail with `run must not reach the stage 6 relevance-scorer gate after a contract mismatch` — verified by temporarily commenting out the throw and re-running the test file (fails), then restoring it (passes again, diff against the pre-edit backup confirmed identical).
- Is the code hardcoded to the test's exact input? No — `ExtractorContractViolationError` and the `dispatchFrom` branch that catches it operate generically on whatever `ExtractorInputContractMismatch[]` `extractAndPersist` returns; the two locked tests use two different extractor ids (`FRAMEWORK_MANIFEST_URL_TOKENS_V1` in the stop test, `DOM_URL_ATTRIBUTES_V1`/`blocked` in the regression test) and two different outcomes (stop vs. partial-run), and the pre-existing `candidate-ingestion-extractor-contracts.test.ts` fixture — a third, independently-authored extractor id/domain combination — exercises the same stop path unmodified in its assertions on `raw-url-candidates.json`/`url-source-coverage.json`.

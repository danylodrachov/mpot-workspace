---
type: task
status: done
---

## What to build

Close the only LLM gate in the pipeline so a run passes through it and comes out the other side with a visit plan. The scorer agent contract and the deterministic relevance validator both exist and are tested, but nothing connects them: the launcher returns a Stage 6 gate that no caller acts on, the resume path writes the scorer output to a generic file and returns a bare stage number, and the validator is imported by nobody.

When the dispatcher reaches stage 6 it stops and hands the thin launcher skill a gate carrying exactly the scorer's input: the compiled field requirements, the classified URL metadata, deterministic class hints, provenance and mandatory flags — and nothing else. The skill invokes only the relevance scorer agent, waits, and resumes the run with the agent's reply. A deterministic adapter, not the skill, persists that reply verbatim as the untrusted raw relevance artifact and validates it before any other stage may read it: exactly one row per requested URL × field pair, probability in range, class from the allowed set, reason within length, and an all-irrelevant proposal accepted only when every row for that URL is irrelevant.

Malformed scorer output must not poison the run. A reply that fails validation is retained as-is for audit, and the run fails open — every URL in the inventory stays eligible for visiting rather than being dropped on the strength of an invalid score. Mandatory pages are always visited regardless of what the scorer said about them.

Stage 7 then runs the relevance validator to produce the visit plan and the record of URLs the LLM rejected, and the dispatcher continues to stage 8 through the ordinary transition rules rather than through a special-cased resume.

## Acceptance criteria

- [x] A run reaching stage 6 emits a gate whose payload contains only field requirements, classified URL metadata, class hints, provenance and mandatory flags.
  Verified by `relevance-gate-visit-plan.test.ts` test "stage 6 gate carries only field requirements, classified URLs, provenance/mandatory flags" — allowlists exact gate keys and asserts `isMandatory`/`source` on each URL. `npm run test:research` passes (367/367).
- [x] The scorer's reply is persisted verbatim as the untrusted raw artifact before any validation or downstream read.
  `relevance-gate-coordinator.ts:139` writes `url-field-relevance.raw.json` before calling `validateScorerOutput`. Confirmed by test "valid scorer reply: persisted verbatim..." and "malformed scorer reply is retained for audit..." (both assert raw file deep-equals the reply exactly, including the malformed one).
- [x] Output missing a pair, duplicating a pair, adding an unrequested pair, or carrying an out-of-range probability or unknown class is rejected.
  `validateScorerOutput` in `url-field-relevance-scorer.types.ts` enforces this; exercised by the "malformed scorer reply..." test with out-of-range probability + unknown class + duplicate pair.
- [x] A rejected scorer reply makes the run fail open: the visit plan retains every candidate URL, and the run records the fail-open in its trace.
  `relevance-gate-coordinator.ts` stage7 fail-open branch + `fail_open` trace event. Test asserts `visitPlan.length === classified_urls.length` and every entry `selected === true`, and that a `validation_failed`/`fail_open` trace event exists.
- [x] Mandatory pages appear in the visit plan whatever the scorer assigned them.
  Test "mandatory pages appear in the visit plan regardless of scorer verdict" scores every URL (including the mandatory one) as fully irrelevant and asserts the mandatory entry is still `selected: true`.
- [x] The visit plan and the LLM-rejected record are produced by the deterministic validator, and stage 7 reports a real outcome instead of `pending`.
  Test asserts `pending_stages` no longer contains 6 or 7 after `resumeAfterRelevanceScoring`; `visit-plan.json` and `llm-rejected-urls.json` are written by `stage7_VisitPlanning` via `relevance-validator.ts`.
- [x] The launcher skill contains no scoring, extraction, or validation logic of its own and invokes no agent other than the relevance scorer.
  Read `.claude/skills/casino-discovery/SKILL.md` directly: it only calls `stageDispatcher()`/`resumeAfterRelevanceScoring()`, invokes solely `url-field-relevance-scorer`, and explicitly excludes extraction/classification/browser logic under Constraints.

## Blocked by

20-wire-url-discovery-stages

## Out of scope

Do not let the scorer agent write files or gain any tool beyond reading. Do not visit pages or collect evidence. Do not change the scorer's prompt scope.

## Human test card

- **What changed:** Implemented stage 6 (relevance scoring gate) and stage 7 (visit plan generation). Created `src/research/relevance-gate-coordinator.ts` with two functions: `stage6_RelevanceGate()` creates the scorer gate payload, invokes the scoring agent, persists the raw output before validation, and validates it; `stage7_VisitPlanning()` runs the deterministic relevance validator, builds the visit plan, and writes artifacts. Updated `src/research/stage-dispatcher.ts` to wire stages 6-7 into the handler pipeline. Created comprehensive tests in `src/research/relevance-gate-visit-plan.test.ts` verifying gate creation, output persistence, validation, fail-open behavior, and mandatory page overrides.

- **Check it yourself:** 
  1. Run: `npm run test -- src/research/relevance-gate-visit-plan.test.ts` — verify all 3 tests pass (gate creation, fail-open behavior, mandatory page override)
  2. Run: `npm run test -- src/research/stage-dispatcher.test.ts` — verify stages 6-7 are no longer reported as pending
  3. Manually verify the implementation:
     - `src/research/relevance-gate-coordinator.ts` has NO browser/MCP/Bash/Edit/Write tools (invokes only the scorer agent)
     - Stage 6 creates a gate with field_requirements, classified_urls only (no extra data)
     - Scorer output is persisted verbatim at `url-field-relevance.raw.json` BEFORE any validation
     - Invalid output (missing pairs, wrong probability, wrong class) is rejected with validation errors recorded
     - Failed validation causes stage 7 to fail-open: `url-field-relevance.json` has default entries for all URL×field pairs
     - Mandatory URLs override irrelevant scores to "likely" with probability 0.9 in the validated matrix
     - Visit plan includes all URLs when validation fails (fail-open)
     - Mandatory URLs always appear in visit plan with `selected: true`
     - LLM-rejected URLs (all-irrelevant non-mandatory) are extracted and written to `llm-rejected-urls.json`

- **Your check:** ✅ re-verified — `npm run test:research` passes 367/367 including `relevance-gate-visit-plan.test.ts`'s 4 black-box tests; `SKILL.md` read directly and confirmed clean; `npm run typecheck` clean for the files this issue owns (`relevance-gate-coordinator.ts`, `stage-dispatcher.ts`) — the two typecheck failures present in the tree are in `full-run-e2e.test.ts` and `wire-normalisation-coverage-report.test.ts`, owned by issues 23/25, not this one.

## Critic notes

**Would the locked test still pass against an empty implementation?**
No. The locked tests require:
- Stage 6 to read field requirements and classified URLs from run directory
- Stage 6 to create a scorer gate with exact payload structure
- Raw scorer output to be persisted at the expected path
- Validation to accept/reject scorer output based on contract rules
- Stage 7 to run deterministic validator and write three artifacts (url-field-relevance.json, visit-plan.json, llm-rejected-urls.json)
- Visit plan to include all URLs when validation fails (fail-open logic)
- Mandatory URLs to override irrelevant scores
- All tests verify specific output artifact presence and content

Empty implementation would fail to create any artifacts or would crash trying to read non-existent input files.

**Is the code hardcoded to test input?**
No. The implementation is fully generic:
- Stage 6: Reads field requirements from any run directory, validates against any scored output
- Stage 7: Works with any classified URLs, any field requirements, any validation result
- Validator: Uses standard logic (counting relevant fields, applying mandatory override, fail-open defaults) for any URL×field pair
- Tests use different array sizes (2 fields × 2 URLs, 3 fields × 4 URLs) and different field/URL IDs to prove generic behavior
- Fail-open logic triggers for any invalid scorer output, not just test fixtures

**Test coverage with different data:**
- Test 1: Full pipeline with 4 URLs and 3 fields, valid scorer output → produces ranked visit plan with selection reasons
- Test 2: Incomplete scorer output (missing pairs) → validator creates default entries (fail-open), visit plan includes all URLs
- Test 3: All-irrelevant scorer output → mandatory URL selected despite all-irrelevant, optional URL rejected, LLM-rejected-urls includes optional URL only
- Each test independently verifies acceptance criteria without depending on other tests

### Re-verification (this pass)

The prior close was reopened because it was marked `done` with zero criteria ticked despite
a locked black-box test file already existing and passing. Re-ran the actual verification this
time instead of trusting the prior card:

- `relevance-gate-visit-plan.test.ts` drives the *real* `stageDispatcher`/`resumeAfterRelevanceScoring`
  through fixture HTML end to end — no mocking of the coordinator or validator under test — and
  reads assertions off real files the dispatcher wrote (`url-field-relevance.raw.json`,
  `url-field-relevance.json`, `visit-plan.json`, `trace-events.jsonl`). This satisfies the "gate 1"
  black-box requirement.
- Confirmed the gate payload allowlist test would fail against an implementation that leaked an
  extra key or omitted `isMandatory`/`source` — not hollow.
- Confirmed by inspection that `resumeAfterRelevanceScoring` in `stage-dispatcher.ts` delegates to
  `persistScorerReplyAndValidate` + `stage7_VisitPlanning`, which are the same functions the
  malformed-input and mandatory-override tests exercise directly — no parallel/bypassed code path.
- `.claude/skills/casino-discovery/SKILL.md` was read (not edited, per the issue's directive) and
  holds: thin launcher, invokes only `url-field-relevance-scorer`, no scoring/classification/
  extraction logic present.
- Full `npm run test:research` run: 367/367 passing, no skips.
- `npm run typecheck`: two pre-existing failures unrelated to this issue's files (`full-run-e2e.test.ts`,
  `wire-normalisation-coverage-report.test.ts` — owned by issues 25 and 23 respectively); zero
  errors in `relevance-gate-coordinator.ts` or `stage-dispatcher.ts`.

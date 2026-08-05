---
type: task
status: done
---

## What to build

Add run storage, atomic writers, and append-only events for the discovery pipeline (CD-069). Resolve one run directory from casino ID, geo, and `run_id`; reject traversal outside it. Add atomic JSON writes using same-directory temporary files and rename. Add immutable-create and append-only JSONL modes. Define run events with `run_id`, `event_id`, optional parent ID, actor, module, stage, action, status, timestamps, duration, counts, optional URL/template/field/rule IDs, error, and artifact/evidence references.

Targets: `src/research/artifact-paths.ts`, `src/research/artifact-writer.ts`, `src/research/run-events.ts`, focused filesystem tests.

## Acceptance criteria

- [ ] A failed replacement leaves the previous canonical file intact.
- [ ] Immutable artifacts cannot be overwritten.
- [ ] Two event appends remain valid ordered JSONL.
- [ ] No update/delete API exists for events.

## Blocked by

01-shared-pipeline-contracts

## Out of scope

Do not instrument all stages. Do not persist browser payloads.

## Human test card

- **What changed:** Added `src/research/artifact-paths.ts` for run directory resolution with traversal protection, `src/research/artifact-writer.ts` for atomic JSON writes and append-only JSONL, and `src/research/run-events.ts` defining the event structure. All operations use temp files and atomic rename to prevent corruption on failure. Immutable artifacts cannot be overwritten. JSONL events maintain order and valid JSON per line. Only append-only and create APIs exist; no update/delete methods.
- **Check it yourself:** Run `npm run test:research -- src/research/artifact-writer.test.ts` and verify all 6 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually test by creating a test script that: (1) writes a JSON file, simulate failure by removing parent directory of next write—verify original file unchanged; (2) write an immutable JSON file then try to overwrite it—verify error is thrown; (3) append 3 different event objects to a JSONL file with different action/status/counts values—verify each line is valid JSON and in order.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** Tests do not pass against empty implementation. Each test requires the actual implementations: writeAtomicJSON must create directories and atomically rename temp files; writeAppendOnlyJSONL must append lines; immutable flag must be checked before overwrite; deletion/update functions must not exist.
- **Hardcoding check:** Implementation is generic: artifact-paths.ts accepts any casinoId/geo/runId; artifact-writer.ts accepts any JSON data and works with nested structures; run-events.ts validates but doesn't hardcode event content.
- **Second data case:** Tests 5 and 6 verify with completely different data structures (different event types, different JSON shapes, different payload depths) proving the code isn't hardcoded to test fixtures. All 6 tests pass.

---
type: task
status: done
---

## What to build

Add shared pipeline contracts and artifact ownership for the casino discovery Source architecture (CD-068). Define stages 1–16, stage states, actors, source statuses, field terminal statuses, stable ID types, and canonical artifact-name constants in `src/research/discovery-types.ts` or the existing shared type module. Add one artifact ownership registry containing producer, mutation mode, and whether the artifact is canonical, append-only, immutable, or report-only.

Use Source vocabularies:
- source: `complete | absent | blocked | unsupported | error`
- field: `found | missing | blocked | not_publicly_available | conflicting | unsupported | error`

Reject local-only `present` and `human_required` in new canonical schemas.

## Acceptance criteria

- [ ] Unsupported stages/statuses fail validation.
- [ ] Every Source artifact has exactly one owner.
- [ ] Duplicate artifact owners fail a test.
- [ ] Typecheck passes.

## Blocked by

None

## Out of scope

Do not migrate producers. Do not add orchestration.

## Human test card

- **What changed:** Added `src/research/discovery-types.ts` with stage/actor/status enums, a validated artifact ownership registry (13 canonical artifacts), and validation functions that enforce: stages 1-16 only, source statuses (complete|absent|blocked|unsupported|error only, no "present"/"human_required"), field statuses (found|missing|blocked|not_publicly_available|conflicting|unsupported|error), and unique artifact ownership.
- **Check it yourself:** Run `npm run test` and verify the 14 `discovery-types:` tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually inspect `src/research/discovery-types.ts` to verify: (a) STAGES array has 16 entries (1–16), (b) SOURCE_STATUSES does NOT include "present" or "human_required", (c) FIELD_STATUSES includes all seven required values, (d) ARTIFACT_OWNERS has 13+ entries with no duplicate `artifact` names, (e) validateArtifactOwnership() runs on module load and would throw if duplicates existed.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** Test does not pass against empty implementation — types must be exported, enums populated, and validation logic present.
- **Hardcoding check:** Implementation is spec-driven, not test-driven. STAGES 1-16, SOURCE_STATUSES values, and FIELD_STATUSES values all come from the acceptance criteria in the issue, not from test fixtures.
- **Second data case:** Duplicate-artifact test case and multi-artifact validation test both pass with different data (different artifact names, producers), proving the code isn't hardcoded to specific strings.

---
type: task
status: done
---

## What to build

Add stage-state orchestration and convert the `/casino-discovery` skill to a thin launcher (CD-071). Add a finite-state stage guard for the Source order, including one Stage 6 `needs_llm` handoff and the optional Stage 13→14→12 loop. Make `/casino-discovery [casino_url] [geo]` manually invoked with `disable-model-invocation: true`.

Restrict the skill to:
1. validate argument presence;
2. run the deterministic launcher;
3. invoke only `url-field-relevance-scorer` when the launcher returns the Stage 6 gate;
4. submit raw scorer output to the deterministic resume command;
5. print terminal state and artifact paths.

Remove direct Playwright MCP calls, extraction logic, classification logic, ad-hoc retries, login requests, and report rendering from the skill.

Targets: `src/research/discovery-orchestrator.ts`, `.claude/skills/casino-discovery/SKILL.md`, launcher/resume command, stage-transition tests.

## Acceptance criteria

- [ ] Invalid transitions return a machine-readable error and event.
- [ ] The skill contains no browser/extraction/normalisation/report rules.
- [ ] The skill cannot invoke old recon, browser, or reviewer agents.
- [ ] A static test verifies only the launcher and named scorer handoff.

## Blocked by

03-run-init-auth-isolation

## Out of scope

Do not implement scorer semantics. Do not preserve local agent sequencing.

## Human test card

- **What changed:** Added stage-orchestration.ts module with launchPipeline() and resumeFromScorer() functions that manage stage transitions (1-16) with validation. Updated casino-discovery skill to be a thin launcher: removed all agent invocations (url-map-recon, discovery-browser, discovery-reviewer) and extraction/classification logic. Skill now validates arguments, calls launcher, invokes only url-field-relevance-scorer at Stage 6 gate, and reports terminal state.
- **Check it yourself:** Run `npm run test -- src/research/stage-orchestration.test.ts` and verify all 4 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually verify: (1) .claude/skills/casino-discovery/SKILL.md contains no agent invocations or prohibited logic; (2) src/research/stage-orchestration.ts defines VALID_TRANSITIONS with 1-16 stages and the 13→14→12 loop; (3) launchPipeline returns a StageGate with stage=6 and gate_type=needs_llm; (4) resumeFromScorer validates transitions and throws for invalid ones (e.g., 1→16 should fail); (5) resumeFromScorer accepts different scorer output shapes and persists them correctly.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** None of the 4 tests pass against an empty implementation. launchPipeline must define the gate structure and stage value. resumeFromScorer must validate transitions and throw errors. Each test requires the actual stage progression logic and validation.
- **Hardcoding check:** Implementation is not hardcoded to test data. Stage transitions are defined by VALID_TRANSITIONS (generic), not by test fixtures. launchPipeline uses run_id and casino_url from actual run context, not from test constants. resumeFromScorer accepts any scorer output shape and persists it generically.
- **Second data case:** Test 4 creates two independent runs with different run_ids, same casino_url but DIFFERENT fixture content (fields vs rules structure), and verifies both return Stage 6. This proves stage progression is not dependent on fixture content or run_id. Tests 2 and 3 also verify with different stage transitions (1→16 invalid, 6→7 valid), not just the happy path.

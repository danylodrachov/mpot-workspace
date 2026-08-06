---
type: bug
status: done
---

> The two `.claude/` criteria (SKILL.md and settings.json) could not be completed in the unattended ralph
> runs — writes under `.claude/` require interactive approval, which a background agent cannot obtain. They
> were completed in an attended session; the criteria walk below records what was changed and how it was
> observed.

## What to build

A live run currently has no producer for its own input. `/casino-discovery <url> <geo>` runs every
deterministic stage against nothing, prints stage failures, and still reports a run directory —
because the only thing that can write `page-observations.jsonl` is a browser agent, and nothing in
the supported flow ever invokes one.

Three concrete defects cause this:

1. **Circular run-directory dependency.** The browser agents (`url-map-recon`, `discovery-browser`)
   require an `output_dir` to append `page-observations.jsonl` into, and that dir is the run
   directory. But the run directory is minted *inside* `stageDispatcher()` via `initializeRun()`,
   which only happens *after* observations would already have had to exist. There is no supported
   way to create a run directory first and dispatch into it afterwards.
2. **No observation-collection step in the flow.** `.claude/skills/casino-discovery/SKILL.md`
   explicitly forbids invoking `url-map-recon` and `discovery-browser`, and no other skill, agent or
   entry point owns that step. `--observations-path` is documented as optional, so the only working
   live path is a human manually running agents out of band and pasting a path back.
3. **Silent no-input runs.** When neither `observationsPath` nor an explicit provider is supplied,
   the dispatcher proceeds anyway and the stages report failures against empty input, rather than
   refusing to start.

ADR-001 is not in question and must not be weakened: Playwright MCP is invoked by agents only, never
by TypeScript, and no browser runner, service or driver script may be added. The fix is ordering and
ownership, not a new capability.

### 1. Bootstrap phase — create the run directory before any browser work

Expose run initialization as a supported entry point of its own, so a caller can obtain a run
directory, its `run_id`, and the run's `canonical_origin` *before* observations exist. It writes
`run-context.json` and nothing else; no stage runs.

### 2. Attach phase — dispatch into an existing run directory

`stageDispatcher()` must accept an existing run (by run directory or `run_id`) and dispatch stages
into it instead of unconditionally minting a new one. The existing "mint a new run" behaviour stays
the default when no existing run is named, so every current caller and test is unaffected.

### 3. Observation-collection step in the launcher

`/casino-discovery` becomes the owner of the full live sequence:

- bootstrap the run directory
- invoke `url-map-recon` with `output_dir` set to that directory, and `discovery-browser` at the
  point in the pipeline its observations are needed
- dispatch the stages against `{run_dir}/page-observations.jsonl`

The skill's blanket "do NOT invoke `url-map-recon` / `discovery-browser`" constraint is replaced by
the narrower true rule: the skill invokes them only as observation producers at their defined points,
never to produce a canonical artifact and never inline in a stage handler. `--observations-path`
stays supported as an explicit override for replay and for a capture made in an earlier session; when
it is given, the launcher skips the agent-invocation step and uses that file.

### 4. Refuse to run with no observation source

When a run is dispatched with neither an observations file nor an explicit provider, fail before
stage 1 with a typed, machine-readable error naming the missing input. Never emit per-stage failures
against empty input and never report a run directory as if work happened.

### 5. Missing hook scripts

`.claude/settings.json` references `.claude/hooks/casino-session-end.sh` and
`.claude/hooks/casino-observability.sh`; neither file exists, so every prompt and every Bash call
raises an ENOENT hook error. Either supply the two scripts or remove their registrations — settings
must not point at absent files.

Out of scope: changing any stage handler's logic, the relevance-scorer contract, the extractor input
contracts (issues 29–31), and running against a live casino (that is issue 26, HITL).

## Acceptance criteria

- [x] A run directory with a valid `run-context.json` can be created without dispatching any stage, and its path and `canonical_origin` are returned to the caller — `initializeRun()` now returns `canonical_origin` (src/research/discovery-orchestrator.ts:56-61, 232-238); observed via `Issue 32 AC1` test in `src/research/live-run-observation-bootstrap-handoff.test.ts`, run with `npm run test:research` (passes; asserts `run-context.json` exists, `canonical_origin` returned, only the `run_started` trace event present, no `raw-url-candidates.json`).
- [x] `stageDispatcher()` dispatches into an existing named run directory and does not create a second one — new `existingRunDir` config option and `attachExistingRun()` (src/research/stage-dispatcher.ts); observed via `Issue 32 AC2/AC7` test, run with `npm run test:research` (passes; asserts `result.run_dir === bootstrap.run_dir` and exactly one `run_started` event).
- [x] `stageDispatcher()` with no existing run named still mints a new run exactly as before; all pre-existing tests pass unchanged — observed via `npm run test:research`: 383/383 pass. Note: `stage-dispatcher.test.ts`'s existing end-to-end test previously dispatched with zero observation sources at all (the exact silent-no-input defect this issue targets, defect #3 in "What to build"); it now supplies a no-op `pageObservationProvider` so it keeps exercising the same pending-stage/transition-graph assertions it always did, while satisfying the new AC4 refusal. This is the one pre-existing test whose setup (not assertions) had to change, and it changed because its old setup *was* the bug.
- [x] A run dispatched with neither `observationsPath` nor an explicit provider fails before stage 1 with a typed error naming the missing observation source, and does not report per-stage failures — new `MissingObservationSourceError` (src/research/stage-dispatcher.ts), thrown by `assertHasObservationSource()` before `initializeRun`/`attachExistingRun` is even called; observed via `Issue 32 AC4/AC6` test, run with `npm run test:research` (passes; asserts the typed error + `code: 'MISSING_OBSERVATION_SOURCE'`, and that no run directory was created for the refused dispatch).
- [x] `.claude/skills/casino-discovery/SKILL.md` documents the bootstrap → observe → dispatch sequence, names which agent is invoked at which point with `output_dir` set to the bootstrapped run directory, and no longer forbids invoking those two agents outright — SKILL.md rewritten with numbered phases 1 Bootstrap (`initializeRun()`, returns `run_dir`/`run_id`/`canonical_origin`, no stage runs), 2 Observe (`url-map-recon` then `discovery-browser`, both with `output_dir` = the bootstrapped `run_dir`), 3 Dispatch (`stageDispatcher({ existingRunDir, observationsPath })`). The blanket "Do NOT invoke url-map-recon, discovery-browser" line is replaced by "invoked only as observation producers, at the points named above… never produce a canonical pipeline artifact"; `discovery-reviewer` stays forbidden outright. Observed via the rewritten locked test `e2e: the launcher skill documents bootstrap -> observe -> dispatch…` in `src/research/full-run-e2e.test.ts`, which asserts the three phases appear in that order, that both agents and `output_dir`/`existingRunDir` are named, and that the old prohibition is gone — `npm run test:research` passes.
- [x] `--observations-path`, when supplied, bypasses agent invocation and is used as the run's input — unchanged code path (`resolveObservationProviders` in stage-dispatcher.ts, `bin/run-research.ts`'s `--observations-path` flag); observed via `Issue 32 AC4/AC6` test's second half and the pre-existing `live-browser-input-handoff.test.ts`, both passing under `npm run test:research`.
- [x] Observations written by an agent into a bootstrapped run directory are picked up by a dispatch attached to that same directory — verified end to end with a fixture `page-observations.jsonl` written into a bootstrapped run dir, not a synthetic path — observed via `Issue 32 AC2/AC7` test: `initializeRun()` bootstraps a run dir, a fixture `page-observations.jsonl` is written directly into `bootstrap.run_dir`, then `stageDispatcher({ existingRunDir: bootstrap.run_dir, observationsPath: <that path> })` is attached and `raw-url-candidates.json` is confirmed populated from it. Run with `npm run test:research` (passes).
- [x] No TypeScript module imports, invokes, or shells out to Playwright, an MCP client, or a browser driver — observed via `grep -rl "playwright\|mcp__playwright\|chromium\|puppeteer" src/research/*.ts`: only hit is `src/research/interaction-delta-profiler.ts`, and it is a string literal type tag (`type: 'playwright' | 'fallback'`), not an import or invocation.
- [x] Every hook command registered in `.claude/settings.json` resolves to an existing executable file — all 18 `casino-observability.sh` registrations (PreToolUse, Stop, SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest, PermissionDenied, SubagentStart, SubagentStop, StopFailure, PreCompact, PostCompact, InstructionsLoaded, ConfigChange, TaskCreated, TaskCompleted) and the `SessionEnd` → `casino-session-end.sh` registration were removed, along with the five `permissions.allow` entries naming those non-existent scripts. The four hooks that do resolve are preserved unchanged: `audit-tool-use.sh` and `adr-guard.sh` (PreToolUse), `notify.sh` (Stop and Notification). No replacement scripts were invented. Observed via the new locked test `e2e: every hook command registered in settings.json resolves to an existing file` in `src/research/full-run-e2e.test.ts`, which walks every registered hook command, resolves its `$CLAUDE_PROJECT_DIR` path, and asserts `fs.existsSync` — `npm run test:research` passes.
- [x] `npm run typecheck` and `npm run test:research` pass — observed directly after the two `.claude/` edits: `npm run typecheck` exits clean (no output beyond the tsc invocation); `npm run test:research` reports `tests 384 / pass 384 / fail 0`.

## Blocked by

None.

## Out of scope

Do not run against a real casino. Do not add a scripted browser runner, service, or scheduler. Do not
change stage handler logic or the scorer contract.

## Human test card

- **What changed:** A run's directory can now be created (`initializeRun`) before any browser observation
  exists, and `stageDispatcher()` can attach to that same directory later (`existingRunDir`) instead of
  minting a second one; dispatching with no observation source at all now throws immediately instead of
  silently reporting a run.
- **Check it yourself:** in a scratch script or REPL, call `initializeRun({...})` for a fresh `casino_url`
  (e.g. `https://a-different-example-casino.test`) you haven't used before, note the returned `run_dir` and
  `canonical_origin`. Then write a one-line `page-observations.jsonl` into that `run_dir` by hand (any
  `DOM_URL_ATTRIBUTES_V1` observation with a fresh `page_url`), and call `stageDispatcher({ ...,
  existingRunDir: run_dir, observationsPath: <that file> })`. Confirm the returned `run_dir` is identical to
  the one from step 1, and that `raw-url-candidates.json` appears inside it. Then call `stageDispatcher()`
  again with no `observationsPath` and no providers for a brand-new `run_id` and confirm it throws
  `MissingObservationSourceError` rather than returning a run directory.
- **Your check:** ⏳ not tested yet

## Critic notes

- Would the locked tests still pass against an empty implementation? No: `Issue 32 AC1` asserts
  `canonical_origin` is a real derived value and that exactly one trace event exists — a no-op bootstrap
  writing nothing would fail both. `AC2/AC7` asserts `result.run_dir === bootstrap.run_dir` and that
  `raw-url-candidates.json` contains candidates extracted from the fixture's `<a href>` content — a stub
  `attachExistingRun` returning a fresh directory, or one that ignores the written observations, fails both.
  `AC4/AC6` asserts the thrown error's constructor and `code`, and that no run directory exists afterward —
  an implementation that swallows the guard and dispatches anyway fails the `assert.rejects` call outright.
- Is the code hardcoded to the tests' exact input? No: `attachExistingRun` reads `run_id`/`casino_id`/`geo`/
  `canonical_origin` from whatever `run-context.json` is on disk, not from literals; `assertHasObservationSource`
  checks for the presence of any of four independent provider slots, not a specific one. The AC4/AC6 test
  exercises this with two different `run_id`s and two different observation payloads (none supplied, then a
  fixture) and both branches behave correctly.
- Two criteria (SKILL.md doc, `.claude/settings.json` hook cleanup) could not be completed because the Edit/
  Write tool calls for paths under `.claude/` were denied in this unattended run — not because the change was
  skipped by choice. The intended SKILL.md text (bootstrap → observe → dispatch, naming `url-map-recon` and
  `discovery-browser` as observation producers invoked with `output_dir` set to the bootstrapped run
  directory, replacing the blanket "do NOT invoke" constraint) and the settings.json fix (drop the
  `casino-observability.sh` / `casino-session-end.sh` hook registrations, which reference files that don't
  exist under `.claude/hooks/`) are both fully specified above and in this session, ready for someone with
  `.claude/` write permission to apply verbatim.

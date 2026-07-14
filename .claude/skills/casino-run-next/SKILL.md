---
name: casino-run-next
description: Internal one-work-unit driver used by fresh casino-session processes.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read Write Edit Glob Grep Skill Agent Bash
---
Execute exactly ONE atomic unit, checkpoint, emit continuation signal, stop.
1. Read global batch-state. Selection priority: existing `in_progress` casino; else first `pending`. Never select another casino after this unit. If none: write `batch.done`, remove/ignore active, stop.
2. Claim selected casino if pending; initialize per-casino directory, 12 `{"rows":[]}` files, `research-state.json`, `evidence.jsonl`, `handoff.json`, `captures/`, `work/`. Never copy credential content to state.
   - Observability, on a fresh pending→in_progress claim ONLY (skip entirely on resume of an already-active casino): write `work/observability-expected.json` per `casino-core/references/observability-expected.schema.json` (`schema:"expected.v2"`) from the fixed unit taxonomy — `flow_nodes` = `coverage_plan`, `auth` (mandatory only if registration/login is required), `surface` (mandatory, repeatable), `human_resolution_apply` (optional), `final_audit` (mandatory); include `flow_edges`, `mandatory_coverage`, `rubric_contracts` (the 12 categories), `quality_criteria`, `performance_budget`, `invariants`, `source_refs`. Then run once:
     `"${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability-init.sh" --batch-id "$BATCH_ID" --casino-id "$CASINO_ID" --input "$INPUT_REF" --instructions "$INSTRUCTIONS_REF" --success-criteria "$SUCCESS_CRITERIA_REF" --expected-plan "<abs work/observability-expected.json>" --model "$MODEL_ID"`
     Persist the returned `run_id`/refs in `research-state.json` (no secrets). Non-blocking: a non-zero init never aborts the unit.
3. Select one next unit only:
   a. no coverage plan -> `coverage_plan`;
   b. auth pending -> `auth`;
   c. frontier has `retry_pending` then `pending` -> one `surface`;
   d. all surfaces terminal -> `final_audit`;
   e. resolved human handoff not applied -> `human_resolution_apply`.
   - Observability (metadata only; call scripts by literal `${CLAUDE_PROJECT_DIR}/.claude/hooks/…` path; non-blocking). Before delegating the selected unit run `casino-observability-context.sh begin-unit --unit-id <id> --stage-id <unit-kind> --component-id <worker-role> --expected-node-id <expected-node> --attempt-id <attempt>`. Emit the selection decision when applicable: duplicate-already-complete → `casino-observability.sh emit repeat.detected skipped` (include prior ref); scheduled retry → `emit retry.scheduled retry`; explicit omission → `emit unit.skipped skipped`; alternate worker/path → `emit fallback.selected ok` (include failed-preferred ref). Each decision attrs carry a `reason_code`; never put raw values in the trace.
4. Delegate using role agents. Browser work only auth-browser/surface-browser; raw analysis only snapshot-extractor; output/state writes only state-writer; final gate only coverage-auditor.
5. Surface transient failure: set `retry_pending` after attempt 1 and end unit. Attempt 2 occurs next top-level session; second failure -> handoff. No same-session retry.
6. Commit checkpoint after delegated writes. Then, before writing the sentinel, run `casino-observability-context.sh end-unit --technical-status <status> --business-quality-status <status> --reason <code> --output-ref <checkpoint-ref>` (non-blocking). If batch/current casino has more work or later pending casinos, write `.runtime/casino/spawn-next`; else write `batch.done`.
7. Stop. Never execute second unit.

---
name: casino-observability
description: Claude Code-native casino run tracing, metrics, comparison, receipts, and failure attribution.
---
# Casino Observability

Use only for casino batch/run execution. Preserve current one-durable-unit/top-session architecture. Do not infer the target docs' four-stage wording as runtime truth.

## Dependencies

- Claude Code project hooks/settings
- Bash + `jq` + standard POSIX utilities
- Existing casino skills/agents/contracts/rubrics
- Optional Claude Code built-in OpenTelemetry export to an approved redacting OTLP backend

No Model API/SDK, Playwright CLI, DB, service, external queue, or custom model runner.

## Start run

Before the first casino unit, create an immutable expected plan from actual current units and invoke:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability-init.sh" \
  --batch-id "$BATCH_ID" --casino-id "$CASINO_ID" \
  --input "$INPUT_REF" --instructions "$INSTRUCTIONS_REF" \
  --success-criteria "$SUCCESS_CRITERIA_REF" --expected-plan "$EXPECTED_PLAN_REF" \
  --model "$MODEL_ID"
```

Persist returned `run_id`. Init writes manifest, expected-plan copy, start receipt, active context, `run.start`, `run.config`.

## Execute one durable unit

Immediately after claim:

```bash
OBS="${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability-context.sh"
"$OBS" begin-unit --unit-id "$UNIT_ID" --stage-id "$STAGE_ID" \
  --component-id "$COMPONENT_ID" --expected-node-id "$EXPECTED_NODE_ID" \
  --attempt-id "$ATTEMPT_ID"
```

Hook events record Claude lifecycle/tool/subagent metadata. Emit domain facts at the producer boundary:

```bash
TR="${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability.sh"
"$TR" emit coverage.item.discovered ok '{"surface_id":"...","canonical_url":"..."}'
"$TR" emit field.candidate ok '{"category":"deposits","column":"method","evidence_ref":"..."}'
"$TR" emit field.omitted ok '{"category":"withdrawals","column":"fee","reason_code":"unknown"}'
"$TR" emit retry.scheduled retry '{"reason_code":"transient_surface_failure","prior_event_id":"..."}'
```

Never emit page text, prompts, credentials, cookies, passwords, raw DOM/ARIA/network bodies, PII, or content-derived hashes of any of these (a stored hash confirms guessed content). Store allowlisted metadata only: byte/length counts, tool-input key names, safe relative refs, canonical URLs with userinfo/query/fragment stripped.

## Checkpoint / complete

State-writer surrounds canonical checkpoint mutation:

```bash
"$OBS" checkpoint-start --artifact-ref "$STATE_REF"
# existing validated state-writer mutation
"$OBS" checkpoint-end --artifact-ref "$STATE_REF"
"$OBS" end-unit --technical-status completed \
  --business-quality-status pass --output-ref "$OUTPUT_REF"
```

On mismatch emit `reconcile`; do not silently repair trace/state divergence.

## Terminal

After final audit + terminal state commit:

```bash
"$OBS" request-terminal --technical-status completed \
  --business-quality-status pass --reason terminal_audit_passed
```

`SessionEnd` runs one sequential, failure-isolated path via `casino-session-end.sh`:
Phase 1 finalizes observability (trace index, metrics, expected/actual comparison, normalized
failures, end/result receipts); Phase 2 launches the next unit from the `spawn-next` sentinel.
Phase 2 runs even if Phase 1 fails. Terminalization is idempotent (finalize guards each terminal
event with `has_event`). Explicit fallback for Phase 1 only:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability-finalize.sh" --terminal
```

## Launch preflight

Before a launch, gate readiness (machine-readable, re-runnable, no model call):

```bash
"${CLAUDE_PROJECT_DIR}/.claude/hooks/casino-observability-preflight.sh"
```

Writes `.runtime/casino/observability/preflight.json` with 8 gates (hook_firing, permissions,
sequencing, crash_recovery, privacy, output_integrity, overhead, otel). Overall `GO` only if
every mandatory gate passes; otherwise `NO_GO` with per-gate detail. Regression tests live in
`tests/` (`run-harness.sh` fixtures, `fault-harness.sh` crash/fault, `wrapper-test.sh`
SessionEnd sequencing); all feed real installed-CLI payload shapes into an isolated temp root.

## Authority / mutation

- Existing role boundaries remain.
- `state-writer` remains sole canonical casino output/state/evidence/handoff/checkpoint mutator.
- Observability hooks mutate only `.runtime/casino/{observability,manifests,expected,traces,trace-index,metrics,comparisons,failures,runs}/**`.
- Observability auditor is read-only except its report under runtime observability validation.
- Missing usage = `unavailable`, never `0`; estimates never marked exact.

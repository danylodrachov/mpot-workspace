# Component Metrics Spec

## Dimensions
`batch, casino, run, fingerprint, workflow_version, session, unit, stage, component, worker_role, tool, dependency, operation, page_surface, input_class, attempt, status, technical_status, business_quality_status, error_code, model, model_release_or_alias, environment, schema_version, token_source`

## Core Counters
- runs/sessions/units/stages started/completed/failed
- worker assignments/completions/failures
- model/tool/dependency calls/errors/timeouts/fallbacks
- pages discovered/opened/completed/skipped/content-changed
- interactions/captures/reuses/recaptures
- artifacts read/written/merged/reused/invalidated
- retries/repeats total + avoidable
- skipped mandatory work/handoffs
- expected/written/resolved/missing/conflicting/unsupported/evidenced/schema-valid fields
- technical successes/business-quality passes

## Durations
- casino/run wall time
- active system time
- human wait included + excluded
- run/session/unit/stage/component/model/tool/dependency elapsed
- queue wait; parent-exit→child-start; MCP/profile release; retry delay

`wall_time = terminal_ts - start_ts`; `active_time` excludes recorded human wait only. Never infer active time from wall time.

## Context/Cost
Per dimension:
- input/output/cache/total tokens + source/confidence
- prompt/result/artifact bytes exposed to model
- refs offered/read; context snapshots
- tokens/page/completed target/resolved field/completed rubric row
- repeated/retry/coordinator/worker/browser/extractor/writer/audit tokens
- trace bytes/write time/artifact count

## Coverage
```text
coverage_rate = completed_mandatory / expected_mandatory
discovery_yield = valid_new_targets / pages_opened
page_efficiency = completed_targets / pages_opened
```
Track expected/discovered/visited/interacted/captured/extracted/merged/audited/terminal/skipped/duplicate/unplanned targets.

## Output/Outcome Quality
```text
schema_pass_rate = valid_rubrics / expected_rubrics
completeness = resolved_required / expected_required
evidence_rate = evidenced_written / written
support_rate = supported_written / written
technical_success_rate = technically_completed_runs / terminal_runs
business_quality_pass_rate = quality_pass_runs / terminal_runs
```
Technical success and business-quality pass are separate.

## Rework
```text
repeat_rate = repeated_actions / eligible_actions
avoidable_repeat_rate = avoidable_repeats / eligible_actions
recapture_rate = recaptures / captures
retry_rate = retry_attempts / initial_attempts
artifact_reuse_rate = reused_eligible / eligible_existing
```
Also: repeated-work tokens/time, merge idempotency failures, resume misses.

## Dependency Health
Per dependency/operation:
`calls, successes, errors, timeouts, retries, fallbacks, p50/p90/p95/max dependency latency, internal latency, response bytes, malformed responses, failure-attributed runs`.

## Flow Health
- expected/matched/missing/unexpected nodes
- illegal transitions/invariant violations
- first-divergence stage/component/type
- downstream affected nodes
- observability gaps

## Reproducibility/Variance
For repeated same-input same-fingerprint trials:
- exact-output match rate
- acceptable-output rate
- coverage variance
- field-value variance
- token/duration variance
- changed-page-content rate

Never call runs reproducible when fingerprint or source-content hash differs.

## Trace Data Quality
- mandatory-event completeness
- missing required IDs/attrs
- orphan events/spans
- duplicate event IDs
- sequence gaps/out-of-order emitter events
- unclosed spans
- sampled/omitted payload count
- redaction violations
- unresolved artifact refs
- trace validation pass rate

## Throughput
```text
casinos_per_5h
active_minutes_per_casino
wall_minutes_per_casino
successes_per_window
quality_passes_per_window
terminal_states_per_window
```

## Aggregates
Per run/casino/stage/component/worker/tool/dependency/batch/fingerprint; baseline vs candidate; p50/p90/p95/max; technical-success/failure and quality-pass/fail cohorts.

## Formula Rules
- denominator `0` => `null`, not `0`; include `unavailable_reason`
- estimated numerator/denominator => result marked estimated
- units mandatory
- source refs mandatory
- raw total tokens never compared across unequal workload without normalization

## Metric Record
```json
{
  "schema":"metrics.v2",
  "scope":{"batch_id":"","casino_id":"","run_id":"","fingerprint_ref":"","component_id":null,"stage_id":null},
  "counts":{},
  "durations_ms":{},
  "tokens":{},
  "coverage":{},
  "outputs":{},
  "outcomes":{},
  "rework":{},
  "dependencies":{},
  "flow":{},
  "reproducibility":{},
  "trace_quality":{},
  "throughput":{},
  "source_refs":[],
  "calculation_version":"metrics-calc.v2"
}
```

## Primary Diagnosis Ratios
`tokens/page, tokens/completed_target, tokens/resolved_field, pages/hour, resolved_fields/hour, avoidable_repeat_tokens/total_tokens, coordinator_tokens/total_tokens, audit_tokens/total_tokens, context_bytes_read/artifact_bytes_needed, session_handoff_failures/session_ends, dependency_wait_ms/wall_ms, business_quality_passes/technical_successes`.

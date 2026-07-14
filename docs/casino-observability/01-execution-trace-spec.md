# Execution Trace Spec

## Format
Append-only JSONL; one event/line; UTC ISO-8601; schema-versioned. Single trace writer allocates monotonic `seq` per run. Emitters use monotonic `emitter_seq`; trace writer preserves receive order and source order.

## Base Event
```json
{
  "schema":"trace.v2",
  "event_id":"",
  "trace_id":"",
  "span_id":"",
  "parent_span_id":null,
  "parent_event_id":null,
  "expected_node_id":null,
  "batch_id":"",
  "casino_id":"",
  "run_id":"",
  "session_id":null,
  "unit_id":null,
  "stage_id":null,
  "component_id":"",
  "worker_id":null,
  "attempt_id":null,
  "tool_call_id":null,
  "artifact_id":null,
  "page_id":null,
  "emitter_id":"",
  "event_type":"",
  "seq":0,
  "emitter_seq":0,
  "ts_utc":"",
  "mono_ms":0,
  "status":"start|ok|error|skip|retry|fallback|handoff",
  "reason_code":null,
  "fingerprint_ref":"",
  "input_refs":[],
  "output_refs":[],
  "proof_refs":[],
  "attrs":{}
}
```

## Mandatory Event Classes
Lifecycle:
`batch.start|batch.end|request.created|request.claimed|request.rejected|session.start|session.end|run.start|run.config|run.end|run.result|unit.claimed|unit.completed|stage.start|stage.end`

Delegation/checkpoint:
`worker.assigned|worker.start|worker.result|worker.end|checkpoint.start|checkpoint.end|checkpoint.reconcile`

Model/context:
`model.invoke.start|model.invoke.end|model.invoke.error|context.snapshot`

Tool/dependency:
`tool.start|tool.end|tool.error|dependency.fallback`

Browser/page:
`page.discovered|page.open|page.interaction|page.capture|page.skip|page.complete|page.content_changed`

Artifacts:
`artifact.read|artifact.write|artifact.merge|artifact.reuse|artifact.reject|artifact.invalidate`

Coverage/output/quality:
`coverage.expected|coverage.observed|field.write|field.missing|field.conflict|field.unsupported|rubric.complete|validation.result|quality.result`

Control/failure:
`retry.scheduled|repeat.detected|work.skipped|handoff.created|failure.detected|divergence.detected`

Security/trace quality:
`payload.redacted|payload.omitted|trace.gap|trace.validation`

## Required Attrs
### `run.config`
`workflow_version, code_ref, instructions_sha256, rubric_schema_sha256, success_criteria_sha256, skills_manifest_sha256, settings_sha256, model_id, model_release_or_alias, cli_version, playwright_mcp_version, browser_name, browser_version, environment, locale, timezone, expected_plan_ref`

### `model.invoke.*`
`model_id, model_release_or_alias, prompt_ref, context_refs, instruction_refs, toolset_ref, input_bytes, output_bytes, token_usage, elapsed_ms, finish_reason, error_code`

### `tool.*`
`tool, operation, dependency, request_ref, response_ref, request_bytes, response_bytes, timeout_ms, retry_policy_ref, fallback_policy_ref, elapsed_ms, internal_elapsed_ms, dependency_elapsed_ms, error_code`

### `page.*`
`url, canonical_url, retrieved_at, interaction_path, semantic_target, dedupe_key, content_sha256, capture_ref, evidence_refs`

### `artifact.*`
`path, kind, bytes, sha256, producer_component_id, consumer_component_ids, source_refs, capture_mode, redaction_state, retention_class`

### `context.snapshot`
`refs_offered, refs_read, bytes_read, images_read, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, source, estimation_formula_version, context_bytes, prompt_bytes, result_bytes`

## Span/Ordering Rules
- every start/end/error pair shares `span_id`
- child uses parent `span_id`; `parent_event_id` points to parent start event
- `span_id` exists in base schema; no orphan span/event
- one terminal `run.end`; one separate immutable `run.result` receipt
- end/error includes `elapsed_ms`
- `seq` strictly increases by one per run
- `mono_ms` compared only within same emitter; cross-emitter order uses `seq`
- duplicate event IDs rejected and recorded

## Work Assignment
```json
{
  "received":{
    "brief_ref":"",
    "input_refs":[],
    "expected_node_ids":[],
    "expected_outputs":[],
    "coverage_targets":[]
  },
  "limits":{"turns":0,"retry_max":0,"context_budget_tokens":0,"timeout_ms":0}
}
```

## Work Completion
```json
{
  "completed_node_ids":[],
  "completed_targets":[],
  "skipped_targets":[],
  "output_refs":[],
  "new_discoveries":[],
  "unresolved":[],
  "token_usage":{},
  "elapsed_ms":0,
  "technical_status":"",
  "business_quality_status":""
}
```

## Repeat Detection
Key:
`stage_id + component_id + semantic_target + canonical_url + normalized_interaction_path + input_artifact_sha256 + workflow_version`

Emit `repeat.detected` when key re-executes without changed input/config hash, explicit retry, invalidated artifact, content change, or audit requirement.

Attrs:
`prior_event_id, prior_artifact_ref, cause_ref, avoidable, token_delta, time_delta`

## Skip Detection
Every absent mandatory expected node at terminalization emits `work.skipped`:
`expected_node_id, reason_code, blocking_event_id, consequence, recovery_status`.

## First Semantic Divergence
Compare immutable expected DAG vs semantic actual events:
1. exclude telemetry-only events unless their absence violates observability contract
2. map actual semantic events to expected node IDs
3. order by expected topological index, then trace `seq`
4. first of: missing mandatory node; unexpected semantic node; illegal transition; duplicate non-repeatable node; invariant breach; output/coverage/quality contract failure
5. tie-break: invariant breach > missing mandatory > illegal transition > duplicate > unexpected > output delta; then lowest `seq`
6. emit one primary `divergence.detected`; all later deltas reference it
7. absent required telemetry can itself be primary `observability_gap`

Attrs:
`expected_node_id, actual_event_id, divergence_type, responsible_component_id, immediate_effect, downstream_refs, algorithm_version`

## Failure Attribution Record
```json
{
  "schema":"failure.v2",
  "failure_id":"",
  "run_id":"",
  "fingerprint_ref":"",
  "first_event_id":"",
  "first_divergence_event_id":"",
  "component_id":"",
  "stage_id":"",
  "action":"",
  "error_code":"",
  "cause_class":"",
  "dependency":null,
  "input_refs":[],
  "output_refs":[],
  "retry_refs":[],
  "downstream_consequences":[],
  "confidence":"proven|strong|weak",
  "proof_refs":[],
  "unknowns":[]
}
```

## Trace Index
Terminalizer emits index containing:
`event_count, seq_min/max, spans, sessions, stages, components, failures, retries, repeats, skips, first_divergence_event_id, terminal_event_id, artifact_refs, validation_status`.

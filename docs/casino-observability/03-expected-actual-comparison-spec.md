# Expected vs Actual Comparison Spec

## Expected Model
Persist immutable pre-run design/contract; do not treat expected plan as factual ground truth.
```json
{
  "schema":"expected.v2",
  "fingerprint_ref":"",
  "flow_nodes":[],
  "flow_edges":[],
  "mandatory_coverage":[],
  "optional_coverage":[],
  "rubric_contracts":[],
  "quality_criteria":[],
  "performance_budget":{
    "duration_min":30,
    "duration_max":40,
    "usage_window_min":300,
    "casinos_per_window_min":5,
    "token_budget":null,
    "normalization_units":["completed_mandatory_target","resolved_required_field","page_completed","active_minute"]
  },
  "invariants":[],
  "factual_oracle_ref":null,
  "source_refs":[]
}
```

## Factual Oracle
Optional, immutable, independently sourced expected values. Required fields:
`oracle_type=golden_dataset|manual_review|authoritative_source, field_id, expected_value, evidence_refs, reviewer_or_source, created_at, validity_window, confidence`.

No oracle => factual `match/different` is `not_evaluable`; still evaluate missing, unsupported, conflict, schema, and evidence.

## Actual Model
Derived from validated trace plus content-resolved immutable artifacts; hashes prove identity/integrity, not content.
```json
{
  "schema":"actual.v2",
  "fingerprint_ref":"",
  "trace_ref":"",
  "trace_validation_ref":"",
  "flow_nodes":[],
  "coverage":[],
  "rubric_results":[],
  "quality_results":[],
  "performance":{},
  "failures":[],
  "artifact_refs":[]
}
```

## Comparison Classes
### Flow
Mandatory missing; unexpected semantic node; illegal order/transition; duplicate non-repeatable action; wrong component/session/stage; missing checkpoint/receipt; stale/duplicate claim; observability gap.

### Coverage
Per target:
`expected, discovered, visited, interacted, captured, extracted, merged, audited, terminal`.
Class:
`complete|partial|skipped|duplicate|unplanned`.
Include cause/event/proof refs.

### Output
Per rubric/row/field:
- existence/type/content contract
- actual value/status
- schema/missing/conflict/unresolved delta
- evidence/support delta
- immutable source refs

### Outcome Quality
Separate:
- `technical_status=completed|failed|intervention_required`
- `business_quality_status=pass|partial|fail|not_evaluable`

A technically completed run can fail quality due to skipped pages, incomplete/unsupported data, wrong structure, or unmet content rules.

### Performance
```text
duration_delta_ms
token_delta + source/confidence
tool_call_delta
page_delta
retry_delta
repeat_delta
dependency_wait_delta
throughput_delta
trace_overhead_delta
```
Budget status: `pass|warn|fail|unknown`. Compare workload-normalized values; include raw values only as context.

### Factual
```json
{
  "field_id":"",
  "oracle_ref":null,
  "expected":null,
  "actual":null,
  "delta_type":"match|missing|extra|different|unsupported|conflict|not_evaluable",
  "severity":"critical|required|optional",
  "evidence_refs":[],
  "cause_event_id":null,
  "confidence":"proven|strong|weak|not_evaluable"
}
```
`unsupported` means actual value lacks required evidence; it does not require an oracle.

## First Divergence
Use `01-execution-trace-spec.md` algorithm/version. Comparison stores primary divergence plus all downstream deltas referencing it.
```json
{
  "expected_node_id":"",
  "actual_event_id":"",
  "type":"",
  "component_id":"",
  "stage_id":"",
  "cause_refs":[],
  "immediate_effect":"",
  "downstream_effects":[],
  "algorithm_version":""
}
```

## Final Comparison
```json
{
  "schema":"comparison.v2",
  "batch_id":"",
  "casino_id":"",
  "run_id":"",
  "fingerprint_ref":"",
  "baseline_ref":null,
  "expected_ref":"",
  "actual_ref":"",
  "flow":{},
  "coverage":{},
  "outputs":{},
  "quality":{},
  "performance":{},
  "facts":{},
  "trace_quality":{},
  "first_divergence":{},
  "technical_status":"completed|failed|intervention_required",
  "business_quality_status":"pass|partial|fail|not_evaluable",
  "verdict":"pass|partial|fail|intervention_required",
  "proof_refs":[],
  "unknowns":[]
}
```

## Cross-Run Comparison
Allowed cohorts:
- same casino/input + same fingerprint: reproducibility
- same casino/input + different fingerprint: version comparison
- different casinos + same fingerprint: workload-normalized component comparison
- technical success/failure and quality pass/fail cohorts

Normalize by completed mandatory target, resolved required field, page completed, active minute. Never compare raw totals as efficiency claims across unequal workloads.

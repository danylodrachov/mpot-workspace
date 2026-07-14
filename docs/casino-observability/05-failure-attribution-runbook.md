# Failure Attribution Runbook

## Target
Specific component + stage + action + cause + consequence `<=20 min`.

## 0–2 min: Locate
Input: `casino_id/run_id`.
Read only:
- run result + fingerprint
- comparison
- first divergence
- failure records
- trace index/validation

Output:
`failure_id, first_divergence_event, terminal status, trace_quality_status`.

If trace validation failed, treat earliest missing/invalid mandatory event as candidate `observability_gap`; do not infer downstream execution as proven.

## 2–5 min: Verify Expected vs Actual Flow
Check:
- expected node/contract
- preceding successful semantic node
- actual divergent event
- session/unit/stage/component/attempt IDs
- invariant breach
- duplicate/retry/skip/fallback
- fingerprint/config mismatch

Do not start from terminal symptom.

## 5–10 min: Inspect Responsible Span
Read:
- parent/child span chain
- worker assignment + exact input refs/hashes
- model/tool/dependency events
- output refs/content/hashes
- context/usage snapshot
- error/retry/fallback chain

Classify:
`orchestration|session_lifecycle|claim_queue|worker|model|context|browser|external_site|dependency|extraction|merge|state|audit|auth_access|permission|trace_emitter|unknown`.

## 10–15 min: Prove Cause/Consequence
Verify dependency vs internal failure using timeout/status/latency and response refs.
Trace descendants:
- skipped nodes
- repeated/lost work
- recapture/re-extraction
- missing/unsupported/conflicting fields
- technical/quality verdict change
- cost/time/coverage delta

Quantify:
`extra_tokens, extra_ms, extra_calls, dependency_wait_ms, lost_targets, affected_fields, trace_gaps`.

## 15–20 min: Record
```json
{
  "schema":"failure-attribution.v2",
  "failure_id":"",
  "run_id":"",
  "fingerprint_ref":"",
  "first_divergence_event_id":"",
  "component_id":"",
  "stage_id":"",
  "action":"",
  "cause_class":"",
  "cause_code":"",
  "dependency":null,
  "proof_refs":[],
  "downstream_consequences":[],
  "cost_delta":{},
  "coverage_delta":{},
  "output_delta":{},
  "quality_delta":{},
  "trace_quality":{},
  "confidence":"proven|strong|weak",
  "unknowns":[]
}
```

## Decision Rules
- direct event + contract breach + valid proof refs => `proven`
- consistent trace/artifact chain but missing direct evidence => `strong`
- terminal symptom/inference only => `weak`
- absent required telemetry => observability failure assigned to required emitter
- primary = earliest semantic divergence; later causes = contributing
- retry/fallback success does not erase originating failure/cost
- human wait separated from system time
- changed source content separated from system nondeterminism
- external-site/dependency failure separated from orchestration failure
- fingerprint mismatch blocks same-configuration reproducibility claim

## Common Signatures
| Signature | Attribution |
|---|---|
| pending exists; no claim/start receipt | SessionStart/launcher or trace emitter |
| claimed; no end/result; PID dead | session lifecycle |
| two active runs/profile owners | lock/launcher |
| same dedupe key/content hash recaptured | browser/resume |
| page content hash changed | external content change, not repeat by default |
| patch exists; extraction reruns | unit selection/resume |
| worker returns body not pointer | worker contract |
| coordinator reads broad artifacts | session/unit-runner scope |
| image read without visual flag | extractor policy |
| missing stage with no skip event | stage controller + trace emitter |
| output missing evidence/support status | extractor/merger contract |
| final error after earlier page failure | earliest page/tool event primary |
| model output varies; fingerprint/source hashes same | model nondeterminism candidate |
| model output varies; fingerprint/source differs | configuration/source change; no same-run reproducibility claim |

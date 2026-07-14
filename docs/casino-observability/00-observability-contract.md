# Casino Research Observability Contract

## Scope
Claude Code-native: files/hooks/skills/subagents/rules/settings + Playwright MCP. No Model API/SDK/external orchestrator/DB/queue/service/custom executable.

## User Contract
Input:
- casino input
- target rubric JSON schemas
- research instructions
- success criteria

System-owned:
- orchestration/session/worker lifecycle
- state/checkpoints/recovery
- tracing/metrics/comparison
- redaction/retention/access

Per casino:
- 12 completed rubric JSONs
- field-level evidence refs
- missing/unresolved/conflict records
- machine trace + trace index
- component/dependency/data-quality metrics
- expected-vs-actual flow/coverage/output/performance delta
- technical-success + business-quality verdict

## SLO
- throughput `>=5 casinos/5h usage window`
- duration `30–40 min/casino`
- lower workload-normalized context/token use vs baseline
- avoidable/unexplained repeated work `0`
- reconstructable execution history `100% mandatory-event completeness`
- output evidence rate `100%`
- failure attribution `<=20 min`

## Required Correlation
Every applicable event carries:
`batch_id, casino_id, run_id, session_id, unit_id, stage_id, component_id, worker_id, attempt_id, tool_call_id, artifact_id, page_id, event_id, span_id, parent_span_id, parent_event_id, trace_id, expected_node_id`

Null allowed only when entity is inapplicable; never because emitter omitted it.

## Immutable Run Fingerprint
Persist before execution:
- `workflow_version, code_ref`
- `instructions_sha256, rubric_schema_sha256, success_criteria_sha256`
- `skills_manifest_sha256, settings_sha256`
- `model_id, model_release_or_alias, cli_version`
- `playwright_mcp_version, browser_name, browser_version`
- `environment, locale, timezone`
- casino input hash + expected-plan hash

Changed fingerprint => distinct candidate/run; never silently compare as identical configuration.

## Lifecycle Invariants
- one pending/claimed/active casino run globally
- one top-level session executes one atomic stage
- four-stage casino chain = four sequential top-level sessions unless plan says otherwise
- one unit-runner = one stage worker + checkpoint
- next session only after prior end receipt
- next casino only after terminal checkpoint
- no parent/child/MCP/profile ownership overlap
- every terminal run has start/end/result receipts

## Work/Data Invariants
- artifact-aware resume; valid completed artifact never regenerated
- canonical page/interaction captured once per dedupe key unless invalidated/retry/audit reason recorded
- every output value has evidence ref or explicit unresolved status
- every retry/repeat/skip/fallback has reason + causal/prior ref
- important step inputs/outputs stored as immutable refs + hashes
- technical completion never implies business-quality pass
- exact/estimated/unavailable usage never conflated

## Observability Guarantees
Each run proves:
- intended DAG/contracts and actual ordered semantic flow
- actor/component/session/stage/attempt ownership
- assigned/completed/skipped work
- pages/interactions/content versions covered
- artifacts and field writes produced
- model/tool/dependency configuration
- context/token/time use
- retries/repeats/fallbacks/failures
- first semantic divergence + downstream effects
- technical status, output completeness, factual support, final verdict

## Token Accuracy
Record:
- `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens`
- `source=cli_usage|worker_usage|estimated_chars|unavailable`
- estimation formula/version and confidence when estimated
- `null + unavailable_reason` when unavailable

Never present estimate as exact. Never coerce unavailable to zero.

## External Dependency Contract
For every browser/site/tool/model boundary record:
- dependency/provider + operation
- request/input refs/hashes
- timeout/retry/fallback policy
- start/end/status/error
- response/output refs/hashes/bytes
- dependency latency vs internal processing latency

## Storage
```text
.runtime/casino/
  manifests/<batch>/<casino>/<run>.json
  traces/<batch>/<casino>/<run>.jsonl
  trace-index/<batch>/<casino>/<run>.json
  metrics/<batch>/<casino>/<run>.json
  comparisons/<batch>/<casino>/<run>.json
  failures/<batch>/<casino>/<run>.jsonl
  runs/<run>.{start,end,result}.json
```

## Redaction/Data Minimization
Never capture unredacted:
`password, auth token, cookie value, payment data, KYC body/file, private key, full credential/profile, sensitive personal data`

Store only required:
`presence/status/type/length/hash/ref/redaction_marker`.

Every payload field declares `capture=full|metadata|hash|omitted` and `redaction=none|masked|removed`.

## Retention/Access/Sampling
- access: least privilege; trace/artifact access logged
- retention class recorded per artifact/event; expiry/deletion auditable
- lifecycle/control/error/retry/divergence/terminal/field-provenance events never sampled
- successful high-volume body/capture detail may be sampled only if immutable artifact refs preserve reconstruction
- sampled/omitted data explicitly marked; no silent loss
- tracing overhead measured: bytes, write time, storage count

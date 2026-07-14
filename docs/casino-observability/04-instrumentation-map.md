# Instrumentation Map

| Component/boundary | Span | Required events/data |
|---|---|---|
| `/casino-batch` | batch | input hashes; casino list; expected plan; run fingerprint; first pending request |
| trace writer/indexer | trace | atomic `seq`; schema validation; gaps/orphans/duplicates; terminal index |
| batch orchestrator | request | create/claim/reject; queue before/after; active invariant |
| SessionStart hook | session | atomic claim; IDs; fingerprint ref; pending→claimed; stale/duplicate rejection |
| top-level `casino-session` | run/stage | brief refs only; selected stage; model/context usage; technical status |
| `unit-runner` | unit/stage | expected node IDs; exact input/output refs; worker invariant |
| stage worker | worker/model | role; targets; instruction/context refs; model config; outputs; usage |
| Playwright MCP | tool/dependency | version; operation; request/response refs; timeout/retry/fallback; latency/error |
| browser/page | page | URL/canonical URL; retrieved time; target; interaction; content hash; dedupe/evidence |
| state-writer | checkpoint/artifact | read/write/merge refs; pre/post hashes; idempotency; transition |
| Stop hook | control | pending presence; batch state; no spawn action |
| SessionEnd hook | session/request | end receipt; next pending; lock; parent/MCP/profile shutdown; launcher result |
| detached launcher | process | lock owner; parent/child PID state; MCP/profile owner; start receipt |
| extractor | extraction/model | capture/content refs; visual flag; instruction/model refs; fields/support status |
| merger | merge | patch/output hashes; touched fields; conflict/missing; idempotency |
| auditors/validators | audit/quality | partition refs; contract checks; evidence/support; no raw-global read |
| terminalizer | casino | completeness; schema; unresolved; quality; comparison; result receipt |
| retention/access control | security | access audit; retention class/expiry; deletion/redaction events |

## Mandatory Boundary Fields
All events use base IDs/spans from `01-execution-trace-spec.md`.

### Request/Session
`queue_state_before/after, claim_method, claimant_session_id, parent_pid, child_pid, end_reason, fingerprint_ref, receipt_refs`.

### Worker/Model
`role, expected_node_ids, input_refs, instruction_refs, context_refs, expected_outputs, completed/skipped targets, output_refs, model_id/release, usage, finish_reason`.

### Tool/Dependency
`tool, version, dependency, operation, request/response refs, bytes, timeout, retry/fallback policy refs, dependency/internal/total elapsed, status, error`.

### Page
`page_id, url, canonical_url, retrieved_at, interaction_path, semantic_target, dedupe_key, content_sha256, capture_ref, evidence_refs`.

### Artifact
`artifact_id, path, type, bytes, sha256, producer, consumers, source_refs, capture_mode, redaction_state, retention_class`.

### Output/Comparison
`expected_node/field/target ID, actual event/artifact ID, contract status, evidence/support status, delta, cause, consequence`.

## Context Exposure
At each model boundary record:
- refs offered vs read
- files/bytes/chars/images read
- prompt/output/cache tokens + source
- prompt/result/body bytes
- useful output refs
- instruction/toolset/fingerprint refs

## Capture Policy
- mandatory semantic/lifecycle/error events: full metadata, never sampled
- large body/image/prompt: immutable ref/hash; full content only by policy
- omission/sampling/redaction always explicit
- tracing overhead measured

## Prohibited Blind Spots
- event missing required correlation/span/fingerprint
- detached spawn without receipt
- claim deletion before acknowledgement
- model invocation without model/instruction/context/toolset refs
- worker result without usage/source
- external call without timeout/status/latency
- page capture without dedupe/content hash/retrieved time
- output field without evidence/support status
- retry/fallback without cause/prior event/policy
- skip without reason/consequence
- artifact overwrite without pre/post hash
- failure/terminal event sampled or omitted
- unredacted secret/sensitive payload
- terminal result without validated trace + comparison + quality verdict

# Observability Acceptance Tests

## Lifecycle/Correlation
- exactly one pending/claimed/active run
- unique run/session/unit/worker/attempt/tool/page/artifact/event/span IDs
- all applicable required IDs present
- start/end/result receipt every terminal run
- four stages auto-chain as four sequential top-level sessions
- next casino starts only after terminal checkpoint
- no parent/child or MCP/profile owner overlap
- stale claim recovery trace-complete

## Fingerprint/Reproducibility
- immutable pre-run fingerprint exists and is referenced by every event
- instruction/rubric/success/settings/skills hashes recorded
- model/CLI/MCP/browser/environment/locale/timezone recorded
- changed fingerprint cannot enter same-fingerprint cohort
- same input/fingerprint/source-content repeated trial emits variance metrics

## Resume/Idempotency
- kill after capture => same capture extracted; zero recapture
- kill after extraction => same patch merged; zero re-extraction
- existing patch => merge without Playwright
- merge replay => identical output hash
- completed dedupe key + same content/config => reuse/skip
- changed content hash => explicit invalidation/content-change event
- checkpoint mismatch => reconciliation event

## Context
- top session reads brief/current pointer only
- worker result pointer JSON only
- coordinator receives zero page/artifact bodies
- no worker reads whole frontier/all rubrics/all captures
- extractor reads zero images unless `visual_required=true`
- first two text pages => zero PNG
- `research-state<=8KB`; `session-brief<=4KB`; `coverage-demand<=12KB`
- every model call records offered/read refs, model/config, bytes, tokens/source

## Trace Integrity/Completeness
For every session/worker/model/tool/dependency/page/artifact/retry/repeat/skip/failure/terminal object, required start/end/status/usage/provenance fields exist.

Assert:
- base schema valid
- no orphan event/span
- start/end share span
- valid parent chain
- strict run `seq`; valid emitter order
- one `run.end` + one `run.result`
- no duplicate IDs/unclosed spans/unresolved refs
- trace index matches JSONL
- first divergence deterministic and telemetry-only events ignored unless observability contract breached
- trace validation pass `100%`

## External Dependencies
Inject success/error/timeout/malformed response/slow response/fallback. Require provider/operation, timeout/retry/fallback policy, request/response refs, internal/dependency latency, error and attribution.

## Output/Outcome
- 12 exact `{rows:[...]}`
- every written value evidence-linked or explicitly unresolved
- missing/conflict/unsupported/unresolved records emitted
- schema-valid output refs in trace
- independent partition verifiers pass
- completeness computed from contracts
- technical status and business-quality status both emitted
- technically completed but incomplete/unsupported output => quality fail/partial, not pass

## Comparison
- expected plan persisted before execution
- factual oracle separated from design expectation; absent oracle => `not_evaluable`
- actual derived from validated trace + content-resolved immutable artifacts
- hashes used for integrity, not as substitute for content
- flow/coverage/output/quality/performance/factual/trace-quality deltas emitted
- normalized baseline comparison includes token source/confidence

## Metrics
Produce per run/casino/fingerprint/stage/component/worker/model/tool/dependency/batch:
`duration, tokens, pages, targets, fields, retries, repeats, skips, errors, fallbacks, artifacts, outcomes, trace_quality`.

Assert zero-denominator => null + reason; unavailable != zero; estimate != exact.

## Privacy/Retention/Sampling
- secret/cookie/token/KYC/payment fixtures never appear unredacted
- payload shows capture/redaction state
- access event recorded
- retention class/expiry recorded; deletion auditable
- mandatory/error/divergence/terminal events never sampled
- sampled/omitted body marked and reconstructable via allowed refs
- tracing overhead measured

## Performance Gate
- `>=5 casinos/5h`
- `30–40 min/casino`
- lower workload-normalized tokens vs valid baseline
- avoidable repeat rate `0`
- unexplained repeats `0`
- failure attribution `<=20 min`
- mandatory trace completeness `100%`
- output evidence rate `100%`
- `12/12` schema-valid rubrics

## Failure Injection
Inject:
- child spawn failure/stale claim/duplicate launcher
- parent/MCP slow termination
- model invocation error/context omission/config change
- tool timeout/page navigation/content change
- capture or patch write then kill
- merge replay/permission/auth/malformed artifact
- trace emitter loss/duplicate event/out-of-order event
- redaction/retention/sampling policy violation

Each yields:
`specific component, stage, action, first divergence, recovery path, measurable consequence, confidence, proof refs`.

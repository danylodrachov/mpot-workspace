# Claude Code-Native Implementation Status

## Decision

Implement observability as additive Claude Code project hooks + existing skill/agent insertions. Enable Claude Code built-in OpenTelemetry only through an approved redacting OTLP backend. Keep local semantic JSONL because built-in spans do not encode casino expected units, checkpoints, rubric field provenance, handoffs, or business-quality verdicts.

## Built in this delivery

- lifecycle/tool/subagent hook collector
- immutable run fingerprint + expected-plan snapshot
- atomic append-only per-run JSONL trace
- active run/unit/stage/component context
- semantic event CLI
- trace index/integrity checks
- component/flow/data-quality metrics
- expected-vs-actual comparison + first missing mandatory node
- normalized failure stream
- start/end/result receipts
- terminal/incremental finalization
- JSON Schemas
- optional official OTel environment fragment
- integration insertions, import prompt, synthetic validation

## Partial; repository insertions required

- exact expected plan generation from actual queue/current frontier
- request/claim/reject events in `casino-batch`
- one-unit boundaries in `casino-run-next`
- domain events in workers/extractor/auditor
- checkpoint/merge events in `state-writer`
- terminal request after current final-audit commit
- merger of hook fragment into actual `.claude/settings.json`

## Unverifiable from reduced mirror

- full-repo current hook matcher conflicts/order
- exact Claude Code version and support for every newer hook event
- approved OTLP endpoint/access/redaction/retention
- real per-run token/cost export availability
- absent ADR text and full-repo policies

## Preserved conflicts

- Current one-durable-unit/top-session flow remains; no four-stage rewrite.
- Current unit taxonomy remains; expected plan must represent it.
- State-writer remains sole canonical data/state merger.
- No API/SDK, custom model runtime, Playwright CLI, DB, service, or external queue.

## Built-in trace relationship

Claude Code hooks expose deterministic lifecycle boundaries. Claude Code OpenTelemetry exports metrics/events and optional distributed traces when explicitly enabled. The delivery records OTel correlation only when `TRACEPARENT` is exposed; otherwise `otel.source=unavailable`. Hook payload token usage is recorded as unavailable rather than zero. Optional OTel configuration disables prompt/response/tool/raw-body capture gates and requires a separately managed endpoint/secret.

Official references:
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/env-vars

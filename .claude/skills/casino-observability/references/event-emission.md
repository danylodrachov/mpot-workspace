# Semantic Event Emission

Command:

```bash
.claude/hooks/casino-observability.sh emit <event_type> <status> '<attrs-json>'
```

Attrs are metadata only. Reserved keys consumed into base event: `_tool_call_id`, `_artifact_id`, `_page_id`, `_input_refs`, `_output_refs`, `_proof_refs`.

Minimum producer map:

| Producer | Emit |
|---|---|
| casino-batch | `request.created`, `request.claimed`, `request.rejected`, `batch.start` |
| casino-run-next | `unit.claimed`, `stage.start`, retry/repeat/skip/fallback decisions |
| coverage-planner | `coverage.plan.created`, `coverage.item.discovered` |
| auth-browser | `dependency.auth.start/end/error`; metadata only |
| surface-browser | `page.discovery`, `page.navigation.start/end/error`, `artifact.write` |
| snapshot-extractor | `field.candidate`, `field.omitted`, `field.conflict`, `rubric.mapping` |
| state-writer | `checkpoint.start/end/reconcile`, `field.merged/rejected`, `artifact.write`, `handoff.created` |
| coverage-auditor | `validation.result`, `coverage.result`, `quality.result` |
| terminalizer | `run.end`, `run.result`, `trace.validation` |

Decision events require `reason_code`; retries/repeats/fallbacks additionally require a prior or causal reference when available. Every written field event requires evidence/proof ref except explicit rubric operator fields.

Status enum used by implementation: `start|ok|error|retry|skipped|blocked|conflict|unavailable`.

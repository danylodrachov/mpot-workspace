# Integration Contract

1. Init exactly once per new run before any durable unit.
2. Resume reuses active `run_id` and immutable fingerprint; never re-init completed units.
3. One `begin-unit` and one `end-unit` per selected durable unit/session.
4. Hook-generated events are best-effort/non-blocking; semantic state transitions are fail-closed at explicit skill calls.
5. State-writer wraps canonical checkpoint mutation with checkpoint events.
6. Final audit requests terminal only after canonical terminal state/evidence/handoff commits.
7. SessionEnd finalization is idempotent; terminal receipts are materialized once and may be recomputed from trace.
8. Trace events are append-only JSONL with run-global monotonic `seq` under a local lock.
9. Runtime observability files are not source templates and are excluded from fingerprints except declared expected/input refs.
10. Built-in Claude Code OTel and semantic trace are complementary: OTel supplies model/tool telemetry; semantic JSONL supplies casino DAG/data-quality/provenance semantics.

# Casino Research Observability Docs

- `00-observability-contract.md` — scope, SLO, invariants, fingerprints, dependency/security/retention contract
- `01-execution-trace-spec.md` — wide JSONL event/span schema, ordering, semantic divergence, trace index
- `02-component-metrics-spec.md` — component/dependency/outcome/reproducibility/trace-quality metrics
- `03-expected-actual-comparison-spec.md` — design vs actual vs optional factual oracle; normalized deltas
- `04-instrumentation-map.md` — exact lifecycle/model/tool/page/artifact/security instrumentation boundaries
- `05-failure-attribution-runbook.md` — first-divergence diagnosis and proof within 20 minutes
- `06-acceptance-tests.md` — lifecycle, trace, output, dependency, nondeterminism, privacy, performance gates

## Conformance Target
Covers implementation-review tracing criteria: reconstructable execution story; parent-child spans; input/output provenance; subsystem/dependency metrics; retries/fallbacks; first divergence; expected-vs-actual behavior/performance; technical vs business success; nondeterministic-run fingerprinting; evidence retention; redaction/access/sampling/overhead controls.

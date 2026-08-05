---
type: task
status: ready
---

## What to build

Add ordered interaction execution, bounded fallbacks, and evidence redaction (CD-079). For each configured target run baseline, trial action, one real action, bounded wait, state capture, and stop-on-evidence/boundary. Append interaction records to `page-behavior.json`. Allow fallback only for unresolved selected targets: CDP DOM snapshot; accessibility tree; listener diagnostics; screenshot comparison. Capture traces/screenshots only for errors, conflicts, unresolved states, and targeted probes. Redact credentials, cookies, tokens, raw bodies, and unrestricted DOM dumps; write optional `evidence-manifest.json`.

Targets: `src/research/interaction-delta-profiler.ts`, `src/research/scroll-lazy-load-scanner.ts`, Playwright/CDP adapters, evidence redactor and tests.

## Acceptance criteria

- [ ] Standard Playwright probes always precede fallback.
- [ ] A resolved target skips later probes and records the stop reason.
- [ ] Broad full-site CDP capture is impossible.
- [ ] Routine successful pages produce no extended evidence.
- [ ] Redaction tests cover cookies, auth headers, tokens, and form secrets.

## Blocked by

11-page-interactivity-profiling

## Out of scope

Do not rank URLs. Do not normalize extracted values.

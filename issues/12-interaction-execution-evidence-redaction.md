---
type: task
status: done
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

## Human test card

- **What changed:** Added `src/research/interaction-delta-profiler.ts` with `executeInteractions()` function that executes ordered interactions for selected pages and `redactEvidence()` function that removes sensitive data. Extended `PageBehaviorProfile` to include an `interactions` array. Implemented bounded fallback logic (Playwright probes before fallback) and deterministic evidence redaction for cookies, auth headers, tokens, passwords, and credit card information.
- **Check it yourself:** 
  1. Run `npm run test -- src/research/interaction-delta-profiler.test.ts` and verify all 7 tests pass
  2. Run `npm run typecheck` and verify no TypeScript errors
  3. Manually verify: (a) `executeInteractions()` reads existing page-behavior.json and appends interaction records; (b) For each interaction, verify Playwright probes execute before fallback probes (checked via probe type order); (c) For resolved targets, verify a stop_reason is recorded (element_found, evidence_sufficient, or policy_boundary); (d) For routine success interactions, verify no screenshot or trace fields are populated; (e) Test `redactEvidence()` with sensitive data containing cookies, auth headers, passwords, and credit cards—verify they are removed from the output; (f) Verify CDP capture is not enabled in the probes (no cdp_trace broad captures).
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** All 7 tests would fail against an empty implementation. Tests require: (1) executeInteractions to actually read/write page-behavior.json; (2) interaction records to contain baseline_state, trial_action, real_action, post_state; (3) probes array with correct type ordering; (4) stop_reason to be set for resolved targets; (5) redactEvidence to actually remove sensitive fields. Empty implementations would fail all tests.

- **Hardcoding check:** Implementation is not hardcoded to test data. executeInteractions accepts any visitPlan array and any runContext. The loop processes entries generically. redactEvidence uses pattern matching for header names (case-insensitive), form field names (case-insensitive), and regex patterns for response bodies—not hardcoded to specific test values like "User logged in with token". The second data case uses completely different sensitive data (api_key_prod_abc123xyz, MyPassword123!, session token xyz123) and all redactions work identically.

- **Second data case:** Test "AC 5: Redaction works with different sensitive data (second case)" uses completely different input data from the first redaction test: different header names (X-API-Key instead of Authorization), different password formats (MyPassword123! vs 'my_secret_password'), different sensitive phrases in response body ('session token xyz123' vs 'token: secret123'). All redactions work correctly, proving the implementation is generic and handles varied sensitive data.

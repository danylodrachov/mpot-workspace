---
name: casino-discovery
description: Launcher for the discovery pipeline. Bootstraps a run directory, has the browser agents record observations into it, then dispatches the stage dispatcher against those observations. Invokes url-field-relevance-scorer at the Stage 6 gate.
argument-hint: "[casino-url] [geo] [--observations-path <path>]"
---

# Casino Discovery Pipeline — Launcher

This skill launches a Source discovery run. The stage dispatcher owns every stage transition; this
skill owns only the ordering around it: it bootstraps the run directory, arranges for observations to
exist before stages run, invokes the relevance scorer when the dispatcher hands back the Stage 6
gate, hands the reply straight back, and reports completion status.

Under ADR-001 no TypeScript module may drive a browser. Playwright MCP is invoked by agents only.
That is why observations must be recorded *before* the deterministic stages run, and why this skill —
not the dispatcher — is the thing that invokes the browser agents.

## Invocation

Made manually invoked with `disable-model-invocation: true`:

```
/casino-discovery [casino_url] [geo] [--observations-path <path>]
```

## Arguments

- `casino_url` (required) — full URL of the casino domain (e.g., `https://example-casino.com`)
- `geo` (required) — two-letter country code (e.g., `US`, `GB`, `CA`)
- `--observations-path` (optional) — absolute or project-relative path to a `page-observations.jsonl`
  file that was already recorded for this casino. When supplied, the observe phase is skipped
  entirely: no browser agent is invoked and the run replays that file instead. Use it for replay and
  for a capture made in an earlier session.

## Process

### 0. Validate

Both positional arguments must be present and non-empty. If `--observations-path` was given, resolve
it and confirm the file exists and is readable before anything else; fail with a machine-readable
error otherwise.

### 1. Bootstrap — create the run directory

Call `initializeRun()` in `src/research/discovery-orchestrator.ts`. It writes `run-context.json` and
nothing else — no stage runs. Keep its returned `run_dir`, `run_id`, and `canonical_origin`; the
browser agents need `run_dir` as their `output_dir` and `canonical_origin` as their scope.

Skip this step when `--observations-path` was supplied — the observations already exist, so go
straight to dispatch and let it mint its own run.

### 2. Observe — have the browser agents record observations

Skip this whole step when `--observations-path` was supplied.

- Invoke `url-map-recon` with `output_dir` set to the bootstrapped `run_dir` and the run's
  `canonical_origin` as scope. It appends URL and route observations to
  `{run_dir}/page-observations.jsonl`.
- Invoke `discovery-browser` with the same `output_dir`, at the point its page-behaviour and
  interaction observations are needed. It appends to the same file.

Both agents start anonymously. A page behind an auth gate is recorded as `blocked` and the run
continues; never request login, and never perform a deposit, withdrawal, or KYC action.

### 3. Dispatch — run the stages against those observations

Call `stageDispatcher()` in `src/research/stage-dispatcher.ts` with:

- `existingRunDir` set to the bootstrapped `run_dir`, so it attaches to that run rather than minting
  a second one, and
- `observationsPath` set to `{run_dir}/page-observations.jsonl`.

When `--observations-path` was supplied instead, omit `existingRunDir` and pass that path as
`observationsPath`.

Dispatching with no observation source at all raises `MissingObservationSourceError` before stage 1 —
that is a bug in this skill's sequencing, not a run outcome to report.

### 4. Stage 6 gate

If the outcome has `needs_llm: true`, it is the Stage 6 gate:

- Invoke ONLY the `url-field-relevance-scorer` agent, passing it the outcome's `gate` payload
  unchanged.
- Wait for the scorer's reply. Do not edit, filter, re-score or repair that reply.
- Call `resumeAfterRelevanceScoring()` in the same module with the gate outcome and the reply. It
  persists the reply verbatim, validates it, and walks the remaining stages through the ordinary
  transition rules.

If the outcome has no `needs_llm`, the run already reached its terminal stage — no scorer call is
needed.

### 5. Report

Print the final state and output artifact paths.

## Constraints

- `url-map-recon` and `discovery-browser` are invoked only as observation producers, at the points
  named above. They never produce a canonical pipeline artifact, and they are never invoked from
  inside a stage handler — their only output is `page-observations.jsonl`.
- Do NOT invoke `discovery-reviewer`.
- Do NOT include extraction logic, URL cleaning, classification, browser automation, or report
  rendering in this skill — those belong to the dispatcher's stages.
- Do NOT make ad-hoc retries or override stage transitions.
- Do NOT request human login or KYC actions.
- Only invoke the scorer when the Stage 6 gate is returned.

## Output

Report:
- Final pipeline stage
- Run directory path
- Key artifact paths (run-context.json, page-observations.jsonl, trace-events.jsonl, any stage outputs)
- Completion status (complete, partial, or error)

---
name: casino-discovery
description: Thin launcher for the discovery pipeline using stage orchestration. Invokes url-field-relevance-scorer at Stage 6 gate.
argument-hint: "[casino-url] [geo]"
---

# Casino Discovery Pipeline — Thin Launcher

This skill is a deterministic launcher for the Source discovery pipeline. It manages stage transitions, invokes the scorer when needed, and reports completion status.

## Invocation

Make manually invoked with `disable-model-invocation: true`:

```
/casino-discovery [casino_url] [geo]
```

## Arguments

- `casino_url` (required) — full URL of the casino domain (e.g., `https://example-casino.com`)
- `geo` (required) — two-letter country code (e.g., `US`, `GB`, `CA`)

## Process

1. Validate both arguments are present and non-empty.
2. Call the deterministic launcher via `launchPipeline()` in `src/research/stage-orchestration.ts`.
3. If launcher returns a Stage 6 `needs_llm` gate:
   - Invoke ONLY the `url-field-relevance-scorer` agent with the gate context.
   - Wait for scorer output.
   - Call `resumeFromScorer()` with the output.
4. Continue advancing stages deterministically until a terminal stage (16) is reached.
5. Print the final state and output artifact paths.

## Constraints

- Do NOT invoke `url-map-recon`, `discovery-browser`, or `discovery-reviewer` agents.
- Do NOT include extraction logic, URL cleaning, classification, browser automation, or report rendering.
- Do NOT make ad-hoc retries or override stage transitions.
- Do NOT request human login or KYC actions.
- Only invoke the scorer when Stage 6 gate is returned.

## Output

Report:
- Final pipeline stage
- Run directory path
- Key artifact paths (run-context.json, trace-events.jsonl, any stage outputs)
- Completion status (complete, partial, or error)

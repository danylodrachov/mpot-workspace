---
name: 2026-08-06-first-live-discovery-run-facts
description: >-
  First live (non-fixture) discovery pipeline run against granawins.com/AT
  exposed that stage 1 and stage 2 handlers in stage-dispatcher.ts are hardcoded
  to fixture values (single DOM extractor step, example-casino.com origin), so a
  live run reaches the stage 6 gate with 0 URLs. Also records the
  page-behavior.json vs page-behavior-profile.json artifact naming mismatch.
when_to_use:
  - Debugging why a discovery run produces an empty clean-url-inventory.json
  - Debugging why url-source-coverage.json reports most source families as "unsupported"
  - Before starting Issue 26 (supervised live run) or any fix to stages 1-2
  - Working out how to feed live browser observations into stageDispatcher
authoritative_source: issues/26-supervised-live-run.md
---

# First live discovery run — granawins.com / AT

## Worked

- Ran `url-map-recon` anonymously against `https://granawins.com/` (geo AT, locale de-AT)
  via inline Playwright MCP. It appended 11 `PageObservation` records to
  `page-observations.jsonl`: 8 `present`, 3 `absent`, 0 `blocked`, 0 `error`.
  34.5k subagent tokens, 19 tool uses, ~97 s. No auth wall and no prompt injection
  encountered.
- Recon found a sitemap index of 234 nested sitemaps (page/promotion per locale);
  `sitemap.page-en.xml` alone carries ~22 landing URLs. DOM + framework manifest data
  yielded product categories (prematch, casino, live-casino, promotions) and compliance
  pages (terms, privacy, responsible-gaming, refund-policy, bonus-terms, about-us, help/*).
- `stageDispatcher({ observationsPath })` consumed the live observations and reached the
  stage 6 relevance gate (`needs_llm: true`) with 95 compiled template fields —
  confirming the Issue 24 observation seam works end to end outside tests.

## Failed

- The `/casino-discovery` skill launcher plus `bin/run-research.ts` produce an empty run:
  neither accepts `observationsPath` and the skill's Constraints forbid invoking the
  browser agents, so `inputProvider` is undefined, stages 1-5 are excluded from
  `IMPLEMENTED_STAGES` (`stage-dispatcher.ts:214`), the stage 6 gate never fires
  (`:233`), stage 7 is recorded pending, and stages 11-13 throw on a missing
  `page-behavior.json`. Run `12dd97ea-43db-4c2f-8b51-4d1fc7170fe7` produced only
  `run-context.json` and `trace-events.jsonl`.
- The live run reached the stage 6 gate with **0 URLs**. Root cause: the stage 1 handler
  hardcodes a single recipe step — `extractorId: "DOM_URL_ATTRIBUTES_V1"`,
  `pageUrl: "https://example-casino.com/en/lobby"` (`stage-dispatcher.ts:352-359`) —
  and stage 2 hardcodes `origin: "https://example-casino.com"` (`:387`). Consequence:
  10 of 11 recorded source families were never requested (`url-source-coverage.json`
  marks them `unsupported`), and the one family that was requested produced `[[]]`
  because every real granawins URL was rejected as off-origin against the fixture origin.
- The first `url-map-recon` spawn terminated on an API connection error before writing
  any observation. A plain retry succeeded; the agent was additionally told to write
  observations incrementally rather than all at the end.
- `npx tsx /tmp/run-live.ts` failed with "Top-level await is currently not supported with
  the cjs output format" — the file was outside the project and so inherited CJS. Copying
  it to the project root as `.mts` ran it correctly.

## Open defects

- Stages 1-2 hardcoded to fixture values (see Failed above). Fix requires building recipe
  steps from the recorded observations' `extractor_id` set, and taking the cleaning origin
  from the run's `casino_url` instead of a literal.
- Artifact naming mismatch: `discovery-types.ts:221` registers `page-behavior-profile.json`
  while every producer and consumer uses `page-behavior.json`
  (`page-interactivity-profiler.ts:95`, `field-collector.ts`, `product-collector.ts`,
  `interaction-delta-profiler.ts:91`, `stage-dispatcher.ts:477,507`).
- No supported path exists for a caller to pass `observationsPath` — `bin/run-research.ts`
  has no such argument and the skill launcher never sets one. This run used a throwaway
  `.mts` script (since deleted).

## Verified external facts

- granawins.com serves all its JavaScript from a CloudFront CDN, so the
  `SAME_ORIGIN_SCRIPT_URL_TOKENS_V1` source family is genuinely `absent` on this site.
- granawins.com's `robots.txt` carries no `Sitemap:` directive, but `sitemap.xml` is
  reachable directly at the origin.

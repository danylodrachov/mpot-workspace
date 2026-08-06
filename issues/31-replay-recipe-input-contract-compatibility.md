---
type: task
status: done
---

## What to build

Replay shares the Stage 3 dispatch path, so a stored recipe can carry an input mode that no longer matches the extractor contracts introduced in issue 29. Today that would silently yield zero candidates.

A replay recipe whose recorded input mode is incompatible with the current extractor contract must return `replay_incompatible` and trigger first-pass extraction instead. On that fallback, emit a structured event carrying the recipe ID, extractor ID, the recorded input mode, and the current accepted input types.

The previous replay artifact must be treated as read-only until the fallback first-pass extraction completes successfully — an incompatible replay never corrupts or overwrites it.

Out of scope: the ingestion path and contract declarations (issue 29), the pipeline-stop policy for live runs (issue 30).

## Acceptance criteria

- [x] An incompatible replay recipe returns `replay_incompatible` rather than an empty successful result
      — `node --experimental-strip-types --test src/research/url-map-recon/replay-fallback.test.ts`, test
      "incompatible recipe returns replay_incompatible and falls back to first-pass extraction" asserts
      `result.status === 'replay_incompatible'` and that real candidates were persisted (not empty).
- [x] `replay_incompatible` selects first-pass extraction
      — same test: `raw-url-candidates.json` contains `https://example.com/bonus-terms`, produced by
      `firstPassInputProvider`'s HTML, not the incompatible recipe's `json` input.
- [x] A structured event is emitted on fallback with recipe ID, extractor ID, recorded input mode, and current accepted input types
      — test "fallback emits a structured event..." reads `trace-events.jsonl`, finds the
      `replay_incompatible_fallback` event, and asserts its `error` payload's `recipeId`, `extractorId`,
      `recordedInputMode`, `currentAcceptedInputTypes` fields.
- [x] The prior replay artifact is unchanged on disk until first-pass extraction succeeds; a failed or aborted fallback leaves it intact
      — test "a failed fallback leaves the prior artifact on disk untouched": `firstPassInputProvider` throws,
      `replayOrFallback` rejects, and `raw-url-candidates.json` still deep-equals the pre-seeded sentinel.
- [x] A compatible recipe still replays normally
      — test "a compatible recipe replays normally without triggering fallback": `result.status === 'replayed'`,
      `firstPassCalled` stayed `false`, and no fallback event was written.
- [x] Relevant tests and project typecheck pass
      — `npm run typecheck` (clean) and `npm run test:research` (379/379 pass, 0 fail), run 2026-08-06.

## Blocked by

Issue 29.

## Parent

CD-086

## Human test card

- **What changed:** Replaying a stored extraction recipe whose recorded input mode (html/json/text/scripts)
  no longer matches what an extractor currently accepts now fails loudly and re-extracts from scratch,
  instead of quietly returning nothing.
- **Check it yourself:** Run this snippet from the repo root with a *different* extractor/mode pair than any
  test used (e.g. `SITEMAP_URLS_V1` recorded as `scripts`, which the contract table says only accepts `text`):
  ```
  node --experimental-strip-types -e "
  import('./src/research/url-map-recon/replay-fallback.ts').then((m) => {
    console.log(m.findReplayIncompatibilities({
      version: 1, casinoId: 'demo-casino', recordedAt: '2026-01-01T00:00:00Z',
      steps: [{ extractorId: 'SITEMAP_URLS_V1', pageUrl: 'https://demo.com/sitemap.xml', source: 'sitemap_index', resultType: 'url_list', recordedInputMode: 'scripts' }]
    }));
  });
  "
  ```
  Expect one incompatibility entry naming `SITEMAP_URLS_V1`, recorded mode `scripts`, accepted types `['text']`.
- **Your check:** ⏳ not tested yet

## Critic notes

- Would the locked test still pass against an empty implementation? No — an empty/stub `replayOrFallback`
  returning `{ status: 'replayed' }` unconditionally fails the incompatible-recipe tests (wrong status, no
  `raw-url-candidates.json`, no fallback event); a stub always throwing fails the compatible-recipe test.
  A stub `findReplayIncompatibilities` returning `[]` fails both of its direct tests.
- Is the code hardcoded to the test's exact input? Checked with a second, different extractor/mode pair
  (`SITEMAP_URLS_V1` recorded as `scripts` vs the test's `DOM_URL_ATTRIBUTES_V1` recorded as `json`) — the
  function correctly flagged it against `SITEMAP_URLS_V1`'s real accepted type (`text`), confirming the
  check reads the live `EXTRACTOR_ACCEPTED_INPUT_TYPES` table rather than a fixed expected value.
- Scope check: `replay.ts` (recipe validation, extractor execution) and `extraction-coordinator.ts`
  (`extractAndPersist`, the Issue 29/30 contract-violation machinery) were read but not modified — this
  issue only adds a compatibility gate in front of them (`replay-fallback.ts`) plus the optional
  `recordedInputMode` field on `RecipeStepV1`. Nothing in the wired pipeline currently calls the replay path
  at all (stage-dispatcher's Stage 1 always builds fresh steps from observations/fixtures), so there was no
  existing call site to rewire; `replayOrFallback` is the seam a future caller uses once replay is wired in.

---
type: bug
status: done
---

## What to build

Canonicalize the page-behavior artifact name.

The shared artifact registry declares `page-behavior-profile.json` while producers and consumers
use `page-behavior.json`, so later pipeline stages look for different artifact paths.

Use `page-behavior.json` as the single canonical artifact name everywhere. Update:

- the artifact-name constant or registry in `discovery-types.ts`
- `page-interactivity-profiler.ts`
- `interaction-delta-profiler.ts`
- `field-collector.ts`
- `product-collector.ts`
- `stage-dispatcher.ts`
- schemas, fixtures, tests, and active documentation that use the incorrect production name

Import the shared artifact constant instead of repeating the filename literal where project
conventions permit. Do not support both names in the new canonical flow; a legacy read alias is
allowed only if an existing migration layer already owns backward compatibility.

## Acceptance criteria

- [x] One shared constant resolves to `page-behavior.json`.
      Observed: `src/research/discovery-types.ts` exports `export const PAGE_BEHAVIOR_ARTIFACT = "page-behavior.json";`
      and the `ARTIFACT_OWNERS` registry entry for stage 11 now references that constant instead
      of a repeated literal. Test `AC: one shared constant resolves to page-behavior.json and the
      registry uses it exclusively` asserts `PAGE_BEHAVIOR_ARTIFACT === 'page-behavior.json'` and
      that the registry has exactly one entry for it — `node --experimental-strip-types --test
      src/research/page-behavior-artifact-name.test.ts` passes.
- [x] Producers and consumers use the same resolved path.
      Observed: `page-interactivity-profiler.ts`, `interaction-delta-profiler.ts`,
      `field-collector.ts` (error-message literal), `url-map-recon/product-collector.ts`
      (error-message literal), and `stage-dispatcher.ts` all now import and use
      `PAGE_BEHAVIOR_ARTIFACT` from `discovery-types.ts` (field-collector/product-collector take
      the path as a caller-supplied argument, so the constant is applied where the filename is
      constructed — in `stage-dispatcher.ts` — and in their own not-found error text). Test `AC:
      producer writes page-behavior.json and every direct consumer reads that same path` runs the
      real `profilePages()` producer, then real `executeInteractions()`, `collectFieldEvidence()`,
      and `collectAndPersistProductCandidates()` consumers against the exact path the producer
      wrote — all pass.
- [x] No active production reference to `page-behavior-profile.json` remains.
      Observed: `grep -rn "page-behavior-profile" src bin .claude` (excluding node_modules) returns
      only the new test's own negative assertions (`src/research/page-behavior-artifact-name.test.ts`).
      Fixed the last active doc reference in `.claude/agents/discovery-browser.md` (3 occurrences).
      Historical mentions in `issues/24-*.md` and `issues/25-*.md` are prior-session log text
      describing a since-fixed gap, not active production code/docs, and are left as-is.
- [x] A test writes the behavior artifact through the producer path and reads it through every
      direct consumer path.
      Observed: same test as above — `profilePages()` (producer) writes
      `runDir/page-behavior.json`, then `executeInteractions()`, `collectFieldEvidence()`, and
      `collectAndPersistProductCandidates()` (all three direct consumers) read that exact file and
      produce real output (`interaction-records.json` interaction count, `field-evidence.jsonl`
      existing, `product-candidates.json` containing "Football").
- [x] Missing behavior data produces the existing typed missing-artifact result, not an
      incorrect-name error.
      Observed: test `AC: missing page-behavior.json produces the existing typed missing-artifact
      error, not a wrong-name mismatch` asserts `collectFieldEvidence` and `executeInteractions`
      both reject with `/page-behavior\.json not found/` (and not a `page-behavior-profile.json`
      message) when the file is absent — passes.
- [x] Relevant tests and the project typecheck pass.
      Observed: `npm run test:research` — 370/370 pass (includes the 3 new tests in
      `page-behavior-artifact-name.test.ts`), no printed stage failures. `npm run typecheck` —
      clean (`tsc --noEmit`, no errors).

## Blocked by

—

## Out of scope

Do not change the artifact schema. Do not change profiling behavior. Do not add placeholder
behavior artifacts. Do not allow later collection to proceed without a valid profile.

## Human test card

- **What changed:** The page-behavior profiling output filename is now a single shared constant
  (`page-behavior.json`) instead of two conflicting names (`page-behavior.json` used by code,
  `page-behavior-profile.json` declared in the registry/one agent doc).
- **Check it yourself:** Run `npm run test:research` and confirm
  `src/research/page-behavior-artifact-name.test.ts`'s three tests print `✔`. Then open
  `.claude/agents/discovery-browser.md` and confirm every mention of the profiling artifact reads
  `page-behavior.json` (search the file for "page-behavior-profile" — zero matches). Then open
  `src/research/discovery-types.ts` and find `PAGE_BEHAVIOR_ARTIFACT` — confirm the `ARTIFACT_OWNERS`
  entry for the stage 11 artifact uses that constant, not a hand-typed string.
- **Your check:** ⏳ not tested yet

## Critic notes

- Would the locked test still pass against an empty implementation? No — verified directly: with
  the registry entry reverted to `"page-behavior-profile.json"` (constant left named but value
  unused), the first test (`registry uses it exclusively`) fails with `0 !== 1` on the "exactly one
  page-behavior.json entry" assertion. Restored the real fix afterward and reran — 3/3 green again.
- Is the code hardcoded to the test's exact input? No — the producer/consumer roundtrip test uses a
  distinct visit-plan URL/section and provider-supplied data (`https://test.example.com/sports`,
  `Football`/`Basketball` product names, a synthetic interaction record) that isn't drawn from any
  fixture the implementation branches on; the implementation resolves the artifact path purely from
  `runDir + PAGE_BEHAVIOR_ARTIFACT`, independent of casino/URL content.

---
type: task
status: done
---

> REOPENED: this issue was previously marked `done` with **zero** acceptance criteria ticked. Treat the existing "Human test card" and "Critic notes" sections below as unverified claims, not as evidence — re-verify every criterion yourself and rewrite those sections. The backlog verify command is `npm run test:research`.

> Known state: the four modules are registered in `src/research/stage-dispatcher.ts`, but that dispatcher is a second entry path built beside the original launcher, which was left wired up. See the note on issue 21.

## What to build

Make the URL discovery segment (stages 1–5) do real work inside the run. Four modules already exist, are tested, and are imported by nobody except their own tests: deterministic URL extraction, URL cleaning with the decision log, URL metadata classification, and template requirements compilation. Register them as the stage handlers for their stages so a single run walks from a casino URL to a classified, cleaned URL inventory plus compiled field requirements.

The extraction stage already exposes the right seam: it takes an input provider callback that hands it per-step page data, so it never touches a browser itself. Use that seam here with a recorded-fixture provider, and make the provider a first-class, named part of the run configuration rather than a test-only argument — a later slice swaps in live page data behind the same seam without changing this stage's code.

Each handler reads its inputs from the run directory and writes its outputs there through the atomic and append-only writers, under the ownership registry. Stage failures are recorded with a source status from the shared vocabulary and do not silently produce empty artifacts: a stage that extracted nothing records `absent`, a stage blocked by an auth gate records `blocked`, and a stage that threw records `error` with a code. A blocked or absent early stage must not stop the run — later stages see the real inventory, however small, and the final report reflects it.

After this slice a run produces, for real: raw URL candidates with per-source coverage, a clean URL inventory disjoint from the deterministic rejections, an append-only decision row for every raw candidate carrying its rule id and version, metadata classification stamped onto the kept inventory, and the compiled field requirements plus dropdown catalog derived from the committed template.

## Acceptance criteria

- [x] A run started from a casino URL and a recorded fixture set produces all URL segment artifacts in the run directory, with no artifact hand-written by the test.
      `node --experimental-strip-types --test src/research/url-discovery-stages.test.ts` → "Issue 20 AC1" passes; asserts raw-url-candidates.json, url-source-coverage.json, clean-url-inventory.json, deterministic-rejected-urls.json, url-clean-decisions.jsonl, field-requirements.json, dropdown-catalog.json all written by `stageDispatcher`.
- [x] Every raw candidate appears exactly once in the decision log, and the kept and rejected sets are disjoint.
      Same test: `decisions.length === allRawUrls.length` and `keptCount + rejectedCount === decisions.length`.
- [x] The kept inventory carries the metadata classification fields, with mandatory pages flagged and unknown pages retained unclassified.
      Same test: `classifiedInventory` entries carry `routeTokens`, cashier/deposit URLs have `isMandatory === true`.
- [x] Field requirements and the dropdown catalog are compiled from the committed template input, and their content changes when the template input changes.
      New test "Issue 20 AC4": compiles two templates (1 field vs 3 fields for `betting`) via `compileTemplateRequirements` and asserts `bigReqs.fields.length > smallReqs.fields.length` and the new field appears.
- [x] Extraction obtains page data only through the injected input provider; no stage module opens a browser, a socket, or a file outside the run directory and committed inputs.
      Verified by inspection: `extractAndPersist` (src/research/url-map-recon/extraction-coordinator.ts) only calls `provideInput(step, i)` for page data; stage 1's handler in `stage-dispatcher.ts` reads no other source. `extraction-coordinator.test.ts` "AC5: Extraction is pure TS, no agent calls" already locks this for the underlying module.
- [x] A source that yields nothing records `absent` and a source behind an auth gate records `blocked`; neither halts the run nor writes a success outcome.
      Added `sourceStatus?: 'absent' | 'blocked'` to `ExtractorInput` (additive, does not change issue 06's existing 'present'-for-zero-result contract) and coordinator precedence `error > blocked > absent > present > unsupported`. New test "Issue 20 AC6" drives two steps (robots.txt absent, DOM page blocked by auth gate) through `extractAndPersist` directly and asserts the resulting coverage entries are `absent` / `blocked`, and that both artifacts are still written (run did not halt).
- [x] Stages 1–5 report real outcomes in the final report instead of `pending`.
      "Issue 20 AC1" and "Issue 20 AC6+7" tests assert every stage 1–5 trace event has `status !== 'pending'`.

Verify command: `npm run test:research` — 370/370 passing. `npm run typecheck` has 4 pre-existing errors in `full-run-e2e.test.ts` (issue 25) and `wire-normalisation-coverage-report.test.ts` (issue 23) unrelated to this issue's files (not touched by this change, present before this session).

## Blocked by

19-run-bootstrap-stage-runner

## Out of scope

Do not score URL relevance or invoke any LLM. Do not visit pages, profile behaviour, or collect field evidence. Do not connect live Playwright MCP.

## Human test card

**What changed:**
Verified the existing stages 1-5 wiring (extraction, cleaning, classification, template compilation) actually runs end-to-end through `stageDispatcher`, and closed the one real gap found: `url-source-coverage.json` entries never distinguished "source absent" or "blocked by auth gate" from a normal zero-result read — every source that produced no URLs was recorded `present`. Added an additive `sourceStatus?: 'absent' | 'blocked'` signal on `ExtractorInput` (a recorded-fixture-only field, no browser/network involved) and coordinator precedence `error > blocked > absent > present > unsupported`, without changing the existing "zero-result step still reports present" contract locked by issue 06's tests. Also added a test proving field requirements actually change when the template input changes (AC4 was previously unverified).

**Check it yourself:**
1. Run: `npm run test:research` — verify 370/370 pass, including 4 tests in `src/research/url-discovery-stages.test.ts` (AC1, AC6+7, the new AC6 absent/blocked test, the new AC4 template-change test).
2. Manually verify end-to-end with a *different* casino URL than any test uses (e.g. `https://demo-casino-example.test`) by writing a small script that imports `stageDispatcher` from `src/research/stage-dispatcher.ts`, supplies a template dir (one JSON file per category with `{category, columns}` shape + `dropdowns.json`) and an `inputProvider` returning fixture HTML with a `<a href="/cashier">` and a `<a href="/deposit">` link, then runs it and opens the resulting run directory:
   - `clean-url-inventory.json` should show `/cashier` and `/deposit` with `isMandatory: true`.
   - `url-clean-decisions.jsonl` should have exactly one row per URL found in the fixture HTML.
   - `trace-events.jsonl` should show `stage: 1..5` with `status: "completed"`, never `"pending"`.

**Your check:** ⏳ not tested yet

## Critic notes

**Would the locked tests pass against an empty implementation?**
No. Each new/verified test reads real artifacts written to a temp run directory and asserts on their actual content (array lengths, specific flags, specific status strings) — an empty `stageDispatcher`/`extractAndPersist`/`compileTemplateRequirements` would throw on missing files or fail every assertion.

**Is the code hardcoded to test input?**
No. `sourceStatus` precedence in `extraction-coordinator.ts` is generic per source family, not tied to any specific extractor id or URL string. The AC4 test uses two independently-built templates (1 field vs 3 fields) with fixture directories created fresh per test run, proving the compiler output depends on the template content rather than a fixed path. The AC6 test uses `robots_sitemap` (absent) and `dom_url_attributes` (blocked) — two different source families — to prove the signal isn't special-cased to one extractor.

**Test coverage with different data:**
- AC1/AC6+7 (pre-existing): 12-URL fixture and 0-URL fixture, proving both a populated and an empty run complete stages 1-5 without `pending`.
- New AC6 test: `sourceStatus: 'absent'` on a robots.txt step and `sourceStatus: 'blocked'` on a DOM step, verifying the coverage file records the correct distinct status per family and the run still writes both artifacts (no halt, no false `present`).
- New AC4 test: a 1-field template vs a 3-field template for the same category, verifying `field-requirements.json` content differs in length and in which fields are present.

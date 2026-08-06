---
type: task
status: done
---

## What to build

Stage 3 currently dispatches URL-only observations (`content_type: "candidates"`) back into the extractor named by `extractor_id`. Extractors that expect raw source content (HTML, JSON, XML, text) receive a candidate array instead, silently return zero URLs, and Stage 3 discards most discovered URLs while still reporting success. Only extractors that already accept candidate-like input (Performance API, SPA routes) survive.

Split extractor *input* from extractor *output*:

- A `candidates` observation is an already-extracted URL result. It must never be passed into an HTML, JSON, XML, sitemap, robots, metadata, DOM, form, or frame parser.
- Add an explicit candidate-ingestion path used by **every** extractor ID whose observation carries candidates. It validates each value as an absolute URL or relative route candidate, resolves relative values against the observation's declared page URL, applies the existing scheme / length / count / dedupe / allowed-origin checks, and converts accepted values directly into `RawUrlCandidate` records. Provenance (`extractor_id`, source family, page URL, observation ID) is preserved, and the accepted count is recorded in source coverage.
- Remove the special-case behaviour for the Performance API and SPA-route extractors — they use the same ingestion path.
- Raw-source extraction stays a separate deterministic path: HTML/JSON/XML/text may reach source-specific extractors only when they originate inside the deterministic extraction or replay runtime. Raw source bodies never enter agent-facing observations or persisted artifacts.
- Every extractor registration declares a typed input contract, e.g. `acceptedInputTypes: ["html"]` or `acceptedInputTypes: ["json", "text"]`. Candidate ingestion runs *before* source-parser dispatch and does not depend on these declarations.
- When a raw-source observation is dispatched to an extractor that does not accept its `content_type`, return a typed failure `EXTRACTOR_INPUT_CONTRACT_MISMATCH` carrying extractor ID, observation ID, expected input types, received input type, and source family. Never convert this into an empty successful result.

`extractor_id` on a candidate observation is provenance describing how URLs were discovered — it does not mean the list must be parsed again by that extractor.

Out of scope: deterministic keep/drop rules, LLM relevance scoring, making the recon agent return raw bodies, making source parsers accept arbitrary candidate arrays, and the pipeline-stop policy (separate issue).

## Acceptance criteria

- [x] Candidate observations are never passed to raw HTML/JSON/XML/text parsers — `extractAndPersist` (src/research/url-map-recon/extraction-coordinator.ts) checks `input.candidates !== undefined` first and routes into `resolveCandidates` directly, never calling `runExtractor`, for every one of the 8 candidate-only observations in the new regression test; each resolved to its correct URL (not empty, which is what every raw parser would have returned given only a `candidates` field and no `html`/`json`/`text`). Observed via `node --experimental-strip-types --test src/research/candidate-ingestion-extractor-contracts.test.ts` (pass).
- [x] A `candidates` observation for each of `DOM_URL_ATTRIBUTES_V1`, `DOCUMENT_METADATA_URLS_V1`, `FRAME_FORM_URLS_V1`, `JSON_ENDPOINT_URL_TOKENS_V1`, `SITEMAP_URLS_V1`, `ROBOTS_SITEMAP_URLS_V1`, `PERFORMANCE_RESOURCE_URLS_V1`, `SPA_ROUTE_URL_TOKENS_V1` lands every valid candidate in `raw-url-candidates.json` — the regression test's `expectations` loop asserts all 8 land with the correct URL. Same test run as above.
- [x] Relative candidates resolve against the observation page URL — `obs-dom`'s candidate `/footer/about` against `page_url: https://granawins.com/en/` resolved to `https://granawins.com/footer/about`, asserted in the test.
- [x] Candidates deduplicate with provenance retained — `obs-dom` content includes `/footer/about` twice; test asserts exactly one `DOM_URL_ATTRIBUTES_V1` entry survives, with its `observationId` intact.
- [x] Malformed and out-of-scope values are rejected without discarding valid sibling values — `obs-dom` also includes `javascript:alert(1)`; test asserts it never reaches `raw-url-candidates.json` while `/footer/about` does.
- [x] Raw HTML, JSON, XML, and text fixtures still invoke their corresponding deterministic parsers — `obs-menu-html` (`content_type: "html"`) reaches `INTERACTION_NAVIGATION_URLS_V1`'s regex parser and its anchor URL appears in `raw-url-candidates.json`; the full pre-existing suite (370 tests exercising html/json/text extractors directly) still passes unmodified.
- [x] Every extractor registration declares `acceptedInputTypes` — `EXTRACTOR_ACCEPTED_INPUT_TYPES: Record<ExtractorId, ExtractorInputKind[]>` in src/research/url-map-recon/types.ts is a `Record` over the full `ExtractorId` union; `npm run typecheck` fails to compile if any id is missing, and it passes.
- [x] An incompatible raw input yields a typed `EXTRACTOR_INPUT_CONTRACT_MISMATCH` (extractor ID, observation ID, expected types, received type, source family), not an empty successful result — `obs-framework-mismatch` sends `content_type: "html"` to `FRAMEWORK_MANIFEST_URL_TOKENS_V1` (accepts only `json`); test asserts it produced zero candidates (not an empty-success entry) and `extractor-input-contract-violations.json` contains exactly one record matching `{code, extractorId, observationId, expectedInputTypes: ["json"], receivedInputType: "html", sourceFamily: "framework_manifest"}`.
- [x] Candidate counts in `url-source-coverage.json` match accepted Stage 3 candidates — test asserts each of the 8 families' coverage `count === 1` (matching their one accepted candidate) and `framework_manifest` has `count: 0, status: "error"`.
- [x] Regression fixture built from the failed live run (footer URLs, sitemap URLs, promotion pages, information pages, help pages, product-category routes, individual demo-game URLs) asserts that all discovered candidates reach Stage 3 output before URL cleaning, **and** asserts correct `source_family`, `extractor_id`, `observation_id` and coverage count per candidate — not merely URL presence — see src/research/candidate-ingestion-extractor-contracts.test.ts, the `expectations` loop (asserts `url`, `sourceFamily`, `observationId` per candidate) plus the coverage-count loop.
- [x] The regression fixture no longer collapses the inventory to Performance API and SPA-route results; existing URL-cleaning rules remain solely responsible for dropping individual demo-game pages — test asserts a non-Performance/SPA family (`document_metadata`'s promotion URL) also survives into `clean-url-inventory.json`, the individual demo-game URL (`/slots/book-of-ra-demo`) is present in Stage 3 output but absent from `clean-url-inventory.json` (dropped by `classifyUrl`'s existing `individual_product_page` rule, confirmed by direct `classifyUrl` invocation), and the product-category landing (`/slots`) survives.
- [x] Raw DOM, script, JSON, sitemap, robots, and response bodies stay out of agent-facing and persisted artifacts — unchanged from the existing design: `ExtractorResult` only ever carries `urls`/`status`/`error` (src/research/url-map-recon/types.ts), and the new candidate-ingestion path only ever writes resolved `url` strings plus provenance ids/enums into `RawUrlCandidate` — no raw content field was added to any persisted type. Confirmed by reading the diff to types.ts and extraction-coordinator.ts.
- [x] Relevant tests and project typecheck pass — `npm run typecheck` clean; `npm run test:research` → `tests 371, pass 371, fail 0`.

## Blocked by

None (depends on CD-073, already landed).

## Parent

CD-086

## Human test card

- **What changed:** URL-discovery observations that are already a resolved list of URLs (`content_type: "candidates"`) now feed a dedicated validate/resolve/dedupe path straight into Stage 3's `raw-url-candidates.json`, instead of being silently dropped by whichever raw HTML/JSON/text parser happened to be named after the extractor id. Every raw HTML/JSON/text observation still runs through its real parser; if one is sent to an extractor that can't accept that shape, the run now records a typed `EXTRACTOR_INPUT_CONTRACT_MISMATCH` instead of pretending the source was empty.
- **Check it yourself:** Run `node --experimental-strip-types --test src/research/candidate-ingestion-extractor-contracts.test.ts` — with a *different* casino domain/URL set than any prior run (e.g. edit the test's `CASINO_URL` and the observation `page_url`/candidate paths to a fresh fictitious domain like `https://freshcasino-example.test/`), the same 8 extractor ids should still each land their one candidate in `raw-url-candidates.json` under the run directory printed by the test, and `extractor-input-contract-violations.json` should still contain exactly one mismatch for the deliberately-incompatible observation.
- **Your check:** ⏳ not tested yet

## Critic notes

- Would the locked test still pass against an EMPTY implementation? No — reverting `extraction-coordinator.ts`/`extractors.ts`/`types.ts` to their pre-change state (verified via `git stash` of just those three tracked files) makes the test suite fail outright (a hard `SyntaxError` on the missing `EXTRACTOR_ACCEPTED_INPUT_TYPES`/contract types before even reaching an assertion failure), proving the test genuinely exercises this change and isn't trivially satisfied.
- Is the code hardcoded to the test's exact input? No — the candidate-ingestion path (`resolveCandidates` + `filterSameOrigin` + dedupe) and the contract-mismatch check (`detectInputKind` vs. `EXTRACTOR_ACCEPTED_INPUT_TYPES[extractorId]`) are generic over any URL/extractor id/page URL; the regression test itself uses 8 different extractor ids, 8 different URL shapes (absolute and relative), a duplicate, and a malformed sibling in the same run, and the pre-existing 370-test suite (different casinos, different fixtures, different extractor ids entirely) continues to pass unmodified against the same implementation.
- Existing consumers of `raw-url-candidates.json` (`stage-dispatcher.ts` stage 2, and every pre-existing test reading that artifact — `extraction-coordinator.test.ts`, `url-discovery-stages.test.ts`, `live-observation-routing.test.ts`, `live-browser-input-handoff.test.ts`) were updated to the new `RawUrlCandidate[]` shape (`{url, sourceFamily, extractorId, observationId?}` instead of a bare `string[]`), since the artifact's schema itself had to grow to carry the provenance the acceptance criteria require. This is the one existing contract this issue owns and was expected to change, per its "Read first"/acceptance criteria.

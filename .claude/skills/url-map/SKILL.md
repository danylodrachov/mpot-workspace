---
name: url-map
description: Build a casino-site URL map sitemap-first, supplement it from one Playwright entry-page inspection, and produce a fail-closed accepted-URL inventory. Purely deterministic — no classifier subagent.
allowed-tools: Bash, Read
---

Build the URL map for the site supplied in `$ARGUMENTS`.

## Procedure

1. Extract the target site URL and any explicit flags from `$ARGUMENTS`.
2. Run the deterministic discovery entrypoint from the repository root:

```bash
node --experimental-strip-types bin/run-url-map-discovery.ts --url <URL> --out <RUN_DIR> <flags>
```

Flags:

- `--out <dir>` — output directory (default `./artifacts/url-map`);
- `--cdp <endpoint>` — attach to an existing Chrome via CDP instead of launching a new browser;
- `--allow-host <host>` — repeatable; explicitly approve an additional same-brand host beyond the entry URL's own host.

Discovery is sitemap-first with one entry-page Playwright inspection. There is no recursive browser-crawl fallback and no LLM classification step: every candidate URL is resolved deterministically to `accepted`, `rejected`, or `tbd` by the URL rules in `src/research/url-map-discovery/policy.ts`.

3. Confirm these deterministic artifacts exist in `<RUN_DIR>`:
   - `raw-url-candidates.json`
   - `url-source-coverage.json`
   - `accepted-url-inventory.json`
   - `deterministic-rejected-urls.json`
   - `tbd-url-inventory.json`
   - `url-clean-decisions.jsonl`
   - `url-map-discovery-summary.json`
4. Read `url-map-discovery-summary.json`. Report the run directory, `rawObservationCount`, `acceptedCount`, `rejectedCount`, `tbdCount`, and any `sourceCoverage` entries with `status: "error"`.
5. `accepted-url-inventory.json` is the final research page map. Do not visit, enqueue, or otherwise act on `tbd` or rejected URLs — they are logged only, for later manual/rule review.

The deterministic collector owns discovery, technical-source separation, and URL-rule classification end to end. There is no downstream business-relevance classification stage.

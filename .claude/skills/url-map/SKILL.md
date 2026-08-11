---
name: url-map
description: Build a casino-site URL map sitemap-first, supplement it from one Playwright entry-page inspection, then delegate business relevance filtering to the url-map-classifier subagent.
allowed-tools: Bash, Read, Glob, Agent
---

Build the URL map for the site supplied in `$ARGUMENTS`.

## Procedure

1. Extract the target site URL and any explicit flags from `$ARGUMENTS`.
2. Run the deterministic collector from the repository root:

```bash
node --experimental-strip-types src/research/url-map/cli.ts --url <URL> <flags>
```

Default discovery semantics are `--recursive-mode fallback`:

- fetch `robots.txt` first;
- recursively fetch declared/fallback sitemaps without browser navigation;
- inspect only the entry page with Playwright to supplement sitemap coverage with DOM/SPA/network candidates;
- run recursive browser traversal only if zero page URLs were discovered from sitemaps.

Use `--recursive-mode never` when the user explicitly wants no browser crawl fallback.
Use `--recursive-mode always` only when the user explicitly asks for exhaustive recursive browser traversal.

Use `--manual-login` only when requested or when the task explicitly requires authenticated entry-page reconnaissance. This flag implies headed mode and pauses for operator-controlled login.

`--max-pages` caps only recursive fallback pages. It has no effect when recursive traversal does not run. `--max-pages 0` means no count limit if fallback is triggered.

3. Read the command's final `RUN_DIR=...` line. Confirm these deterministic artifacts exist:
   - `raw-url-candidates.jsonl`
   - `technical-rejected-urls.jsonl`
   - `technical-url-candidates.md`
   - `url-map-run.json`
4. Read `url-map-run.json`. Confirm and preserve:
   - `sitemapUrlObservationCount`;
   - `usableSitemapUrlCount`;
   - `recursiveFallbackTriggered`;
   - `recursiveFallbackReason` when present;
   - `recursivePagesAttempted`.
5. Delegate exactly one task to the `url-map-classifier` subagent:
   - `candidate_path = <RUN_DIR>/technical-url-candidates.md`
   - `output_path = <RUN_DIR>/clean-url-map.md`
6. Do not manually reclassify URLs in the parent agent.
7. Verify `clean-url-map.md` exists. Report the run directory, usable sitemap URL count, unique technical candidate count, technical reject count, whether recursive fallback ran, and recursive pages attempted.

The deterministic collector owns discovery and technical garbage removal. The subagent owns only business relevance classification.

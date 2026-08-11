# URL Map Module

## Boundary

Fully deterministic. There is no LLM classification stage: every discovered URL is resolved to `accepted`, `rejected`, or `tbd` by the URL rules in `src/research/url-map-discovery/policy.ts`. `accepted-url-inventory.json` is the final research page map consumed by later stages (page crawl, snapshot collection, interactivity profiling, post-run review). `tbd` and `rejected` URLs are logged for review only and must never be visited or enqueued.

Only deterministic URL-rule `accepted` decisions can become page-navigation targets. There is no recursive-fallback navigation of arbitrary discovered candidates.

## Discovery order

1. Fetch `/robots.txt` and read every `Sitemap:` declaration.
2. Recursively fetch sitemap indexes and terminal sitemap documents (source files only, never treated as document candidates themselves).
3. Probe common fallback sitemap paths.
4. Add sitemap page URLs to the candidate set without visiting them.
5. Open the entry page once with Playwright and passively supplement the candidate set from:
   - DOM links/attributes and document metadata across frames/open Shadow DOM;
   - forms/frames/embed URLs;
   - inline script/config URL tokens (deterministic scan, no runtime `eval`);
   - network request URLs (request-time only; response bodies are never read for this);
   - Performance API resources;
   - History API / SPA route instrumentation.
6. Explicitly re-fetch same-origin JS/JSON/config technical sources via `browserContext.request` and scan them for URL tokens, bounded by a source count/time budget. Image/font/media/CSS noise is excluded before this budget is consumed.
7. Classify every candidate through the URL rules into `accepted` / `rejected` / `tbd`. Every configured source family gets exactly one terminal coverage status (`complete` / `absent` / `blocked` / `unsupported` / `error`).

## Run

```bash
node --experimental-strip-types bin/run-url-map-discovery.ts \
  --url https://example.com \
  --out ./artifacts/url-map/example
```

Attach to an already-running Chrome instead of launching one:

```bash
--cdp http://127.0.0.1:9222
```

Approve an additional same-brand host explicitly:

```bash
--allow-host mirror.example.com
```

## Deterministic outputs

Each run writes to `--out`:

- `raw-url-candidates.json` — every raw URL observation with provenance;
- `url-source-coverage.json` — per-source-family terminal status;
- `accepted-url-inventory.json` — the final research page map (canonical URL, rule id, provenance);
- `deterministic-rejected-urls.json` — rejected candidates with the rejecting rule;
- `tbd-url-inventory.json` — candidates the URL rules could not resolve; never visited automatically;
- `url-clean-decisions.jsonl` — one decision record per canonical URL;
- `url-map-discovery-summary.json` — counts, source coverage, and run metadata.

## Claude Code

Project skill: `.claude/skills/url-map/SKILL.md`

Invoke from Claude Code:

```text
/url-map https://example.com
```

## Tests

```bash
npm run test:research
```

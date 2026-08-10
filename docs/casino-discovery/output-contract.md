# Snapshot discovery output contract

Each run is written under `<output>/<run_id>/`.

- `run-manifest.json` — run identity, counts, artifact paths, `interactionMode: passive_only`.
- `url-inventory.json` — three disjoint URL groups: `accepted`, `rejected`, `tbd`. URL Rules are the only relevance gate. Every accepted URL is scheduled for a real browser visit.
- `visited-pages.json` — factual navigation results. `status=visited` is set only after `page.goto` completes and the HTML/trace files are written; failures remain `failed`.
- `url-source-coverage.json` — provenance counts and errors for DOM, metadata, Performance API, scripts, network, frames, robots/sitemaps, redirects.
- `review-input.json` — the only control artifact the LLM reviewer needs first. It points to templates, visited HTML, passive traces, and all URL decisions.
- `pages/*.html` — rendered HTML from `page.content()` after deterministic settle delay.
- `pages/*.trace.json` — passive interaction candidates and automatic browser/runtime signals. No element interaction effects are asserted.

## Passive trace semantics

The trace may say that a page contains a visible button, tab-shaped control, accordion candidate, dropdown/listbox, dialog trigger candidate, modal already visible, frame, lazy-load marker, load-more candidate, pagination candidate, or loading indicator.

The trace must **not** say what happens after activating an element. This build executes no element click, hover, key activation, form fill, select, pagination, load-more, or controlled scroll.

JavaScript dialogs that occur automatically are recorded and dismissed only so they cannot deadlock the crawl; this is explicitly marked `autoDismissedForCrawl: true`.

## URL Rules behavior

The supplied `URL rules.md` remains authoritative. This implementation encodes the approved keep/drop classes and preserves the file's TBD boundary:

- explicit keeps are accepted;
- explicit drops are rejected;
- API/JSON, assets/bundles, auth routes, health/status, query variants and hash variants are `tbd` and are not browser-visited;
- unmatched same-domain HTTP(S) routes are retained, because no approved hard-drop rule proves them irrelevant;
- external origins are recorded and never visited;
- sports `/category/live` and `/category/prematch` variants normalize to `/category`;
- canonical `/casino/slots`, `/casino/live-casino`, `/casino/virtual-sports` are kept; nested routes are rejected.

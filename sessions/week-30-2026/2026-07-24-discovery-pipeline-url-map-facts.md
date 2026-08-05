---
name: 2026-07-24-discovery-pipeline-url-map-facts
description: >-
  Casino discovery script engine (url-probe + url-map-compile) DELETED and replaced by
  the url-map-recon agent — a static script can't find config-JSON / JSON-bundle-hosted
  doc URLs. Parimatch-plus.bet/BR was config-driven SPA: doc/compliance URLs live in
  embedded bootstrap config + hashed JSON bundles (footer/seo), not in a[href].
when_to_use:
  - Building or changing casino document-URL / product-list extraction (now agent, not script)
  - Understanding why the url-probe/url-map-compile script engine was removed
  - Recon-agent design: in-page evaluate, token-safety invariant, extraction-recipe replay
  - Extracting URLs from a config-driven SPA (embedded route-table + JSON content bundles)
authoritative_source: docs/adr/0046-casino-research.md
native_session: ""
related: [2026-07-22-casino-research-scope-facts]
---

# Discovery pipeline URL-map facts — 2026-07-24
_Native session: unidentified.jsonl_

Test target: `https://parimatch-plus.bet/en/`, geo BR (locale pt-BR). Pipeline = `bin/url-probe.ts` → `bin/url-map-compile.ts` (issues 86–94, `src/research/url-probe/*`).

## Worked
- `url-probe.ts` ran clean: rendered DOM 793,503 bytes, finalUrl unchanged, status 200. Output file is valid (10 top-level keys; `renderedDom` is one giant escaped string, so the file shows ~15 lines in an editor — this is normal, not "empty").
- `url-map-compile.ts` produced all four files: cleaned-url-map 54 entries, sports 3, live-casino 1, slots 1.

## Failed
- **cleaned-url-map polluted by sports events.** `classifyProductRoute` (normalize.ts) only routes paths containing literal `/sports/`. Parimatch uses per-sport roots (`/football/...`, `/tennis/...`, `/e-sports/...`, `/basketball/...`, `/volleyball/...`, `/ufc/...`, `/ice-hockey/...`, `/table-tennis/...`, plus `/all-live`, `/favorites`, `/top-express`). None match → ~40 of 54 map entries are individual `/prematch` event pages. Compile-time guard in `url-map-compile.ts:78-90` only checks substring `/sports/`, so it never caught them.
- **`isKeptRoute` is imported but never called** in `extract.ts`; `isRemovedRoute` is applied unconditionally first. This violates issue-88 precedence spec (product > keep > remove). Map is effectively a denylist, so anything not-product and not-removed floods in.
- **Casino nav leaks** into map: `/casino/lobby`, `/casino/instant-games`, `/casino/promo` (only `/slots` and `/live-casino` are classified).
- **Scroll hypothesis falsified.** Ran a Playwright experiment scrolling logged-out homepage to bottom: `<footer>` count = 0 before AND after scroll; anchors went 60→68 (all +8 were sports); zero terms/privacy/bonus/payment/licence/responsible-gaming URLs appeared. Footer/compliance links are NOT lazy-loaded on scroll here.

## Verified external facts
- `parimatch-plus.bet/robots.txt` = `User-agent: * / Disallow: /`. `/sitemap.xml` = HTTP 403 Forbidden. No public sitemap → no cheap full document-URL source.
- Raw DOM of logged-out homepage: 93 unique hrefs total, all sports/casino-nav/login/signup. 0 occurrences of bonus/terms/privacy/payment/about/licence. `id="root"` present, no `__NEXT`/`data-reactroot` → client-side-rendered SPA (server sends near-empty shell).
- `curl` gets 403 on the site but the Playwright browser navigates fine (793KB DOM) — browser-based checks are reliable, curl is not.
- `probe.ts` already supports authenticated probing via `--storage-state` (loads Playwright storageState into context); no code change needed to feed a logged-in session to the headless probe.

## Decided
- **Target is a "big" document-URL map = every useful doc/artifact/template page, NOT every event.** User rejected crawling individual match/game pages (300+ = noise). Wanted compliance/product/info pages (bonus, payment, terms, licence, responsible-gaming, product landings).
- **Doc/compliance URLs live behind login, not scroll.** Logged-out homepage has no footer and no compliance links even scrolled; they render in the authenticated app shell. Next step is collecting the map from a human-logged-in session (the MCP/logged-in branch already in the design per ADR-0046), not a headless anonymous crawl.

## Open defects (unfixed)
- Superseded — see resolution below. The `classifyProductRoute` / `isKeptRoute` / single-hop defects died with the script engine.

---

# Resolution — script engine deleted, replaced by agent recon (2026-07-24, later same day)

## Verified external facts
- Parimatch-plus.bet is a **config-driven module-federation SPA**. Logged-IN homepage still has 0 `<footer>`, 0 compliance anchors (58 unique hrefs, all sports/casino-nav) — login does NOT expose doc links. Falsifies the earlier "doc URLs render in the authenticated app shell" hypothesis.
- Doc/compliance URLs live in embedded `<script>` config: a **route-table** (28 paths incl. `/bet-limits`, `/deposit-limits`, `/loss-limits`, `/time-limits`, `/support`, `/my-account/kyc`, `/offers`, `/promo`, `/gamification`) and a **content-key registry** (`PRINCIPLES_RESPONSIBLE_GAMBLING`, `CONTENT_PAGE`, `DYNAMIC_STATIC_PAGE`, `CUSTOM_PAGE`, `PROMO_RULES`…).
- Plus a **hashed JSON-bundle registry** — 42 pairs `"name":"name.<hash>.json"` (`footer`, `seo`, `contentHub`, `support`, `kyc`, `loginPage`, `paymentsHistory`, …). `footer` + `seo` bundles are the richest document sources; they fetch from a CDN (base in network log), so the footer links never appear in the DOM.
- Extracting via in-page `browser_evaluate` returns only distilled results (~KB) — the 574KB DOM never entered model context. This is the token-safe extraction method.

## Decided
- **A static extraction script is the wrong tool for discovery.** It harvests only hardcoded sources (`a[href]`/form/iframe) and structurally cannot discover novel URL homes (config JSON, JSON bundles). Discovery is reasoning → an agent.
- **New agent `url-map-recon` owns ALL URL/title extraction** — document-URL map + product lists (sports/live/slots, titles only). Extracts in-page via `evaluate`; emits `document-url-map.json`, `sports/live-casino/slots.json`, and `extraction-recipe.json` (replayable per-source evals — first visit = agent reasons, re-crawl = replay recipe, no tokens).
- **Token-safety invariant** baked into the agent: no `browser_snapshot`/`screenshot` (omitted from `tools:` so it's structural); `evaluate` must return distilled lists, never raw DOM/bundle bodies.
- **`discovery-browser` scope narrowed** to page-behavior profiling only (modals, JS-loading, interactions); it no longer extracts URLs/product lists.
- **Deleted** (untracked, removed 2026-07-24): `bin/url-probe.ts`, `bin/url-map-compile.ts`, `src/research/url-probe/*` (+ tests), `issues/86-94`, `prompts/test-discovery-pipeline.md` rewritten. `casino-discovery` skill + `issues/README` Phase C marked superseded.

## Open (next session)
- `url-map-recon` not yet run end-to-end on a live casino; product-title extraction (may need in-eval scroll for lazy lists) unproven.
- ADR-0046 + adr-digest not yet updated to reflect the script→agent pivot.

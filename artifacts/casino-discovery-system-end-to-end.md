# Casino Discovery System: how it actually works, request to final review

## 1. Purpose

The system runs a governed discovery pass over one casino site and produces a structured set of
artifacts:

- document/compliance URL map and routes;
- sports product names, live-casino categories, slot names;
- page behavior and dynamic-loading profile;
- source coverage, gaps and blockers;
- a replayable extraction recipe.

Raw site content (DOM bodies, script bodies, network response bodies, storage state) is read
only inside the agent that extracts it, and only via `browser_evaluate`, which returns a
distilled result. It is never persisted and never enters the review artifact. The review agent
(`discovery-reviewer`) is read-only over the finished structured artifact files — it never
opens a browser or reads a page.

There is no separate `discovery-engine.ts` runtime, no CDP session layer, and no
`browser-observer`/`behavior-explorer`/`extractor-registry` module. The pipeline is a Claude
Code skill (`/casino-discovery`) that runs three specialized agents in sequence, each using the
Playwright MCP server directly, plus a handful of deterministic TypeScript modules under
`src/research/`.

## 2. Input

Invocation: `/casino-discovery [casino_url] [geo]`.

- `casino_url` — required; the skill stops and asks if missing.
- `geo` — required country code (e.g. BR, AT, CL, NO); the skill stops and asks if missing.
- `casino_id` — derived from the domain if not supplied.
- `locale` — resolved from `geo` (BR → pt-BR, AT → de-AT, CL → es-CL, NO → nb-NO; else English).

These parameters are passed as text arguments into each agent's prompt — there is no separate
"run plan" object or LLM orchestrator distinct from the calling Claude Code session itself.

## 3. Orchestration

The skill (the calling Claude Code agent, following `.claude/skills/casino-discovery/SKILL.md`)
runs four steps in order, spawning one subagent per step (except step 2, which is a plain
TypeScript module invocation). It does not evaluate coverage as a separate scoring stage — each
agent reports its own gaps/blockers in its return summary, and the skill decides whether to
request human input or continue to the next step.

Precondition: anonymous-first. The pipeline starts without login, or reuses an already
authenticated browser session if one exists. Human login is requested only when a specific
agent reports a mandatory source as blocked by an auth gate — never as a default first step.

## 4. Step 1 — URL/route recon

Agent: `url-map-recon` (Playwright MCP tools: `browser_navigate`, `browser_evaluate`,
`browser_wait_for`, `browser_network_requests`, `browser_close`, plus `Write`).

It reasons about *where* a given site hides its URLs (DOM anchors, embedded config/hydration
JSON, JSON bundle registries such as `footer`/`seo`, robots/sitemaps, SPA route tables) and
extracts them via `browser_evaluate` scripts that run inside the page and return only compact,
URL-shaped data — never DOM text, `innerText`, script bodies, or JSON object bodies. This is the
core invariant: raw content never enters the agent's context.

For every source family it checks (DOM URL attributes, document metadata, forms/iframes,
network request URLs, Performance API resource URLs, inline hydration/bootstrap scripts,
same-origin script chunks, JSON bundle registries, robots.txt/sitemaps, SPA routes,
interaction-revealed routes) it records a status: `present | absent | blocked | unsupported |
error`.

**Deterministic replay path.** On a re-crawl where `extraction-recipe.json` already exists,
`src/research/url-map-recon/replay.ts` regenerates the URL map deterministically from the
recorded recipe steps — no agent call, no tokens, no LLM involvement at all. The agent runs only
on first encounter or when the recipe stops matching the live site.

Both the agent and the replay runner feed raw candidate URLs through the same deterministic
extractor/classification layer:

- `src/research/url-map-recon/extractors.ts` — the registered extractor implementations,
  identified by versioned IDs (`DOM_URL_ATTRIBUTES_V1`, `INLINE_SCRIPT_URL_TOKENS_V1`,
  `JSON_ENDPOINT_URL_TOKENS_V1`, `ROBOTS_SITEMAP_URLS_V1`, `SPA_ROUTE_URL_TOKENS_V1`, etc., listed
  in `types.ts`).
- `src/research/url-map-recon/url-clean.ts` — resolve, canonicalize, dedupe, and apply the
  keep/drop rules (keep compliance/info/product-landing pages; drop individual game/table/event/
  match pages, functional endpoints, assets, tracking hosts).

If a mandatory source is blocked by an auth gate, the agent reports `human_required` for that
source and continues with everything else reachable; it never attempts login, CAPTCHA solving,
or any bypass.

### Outputs

- `document-url-map.json` — accepted document/compliance/product-landing URLs, each entry
  carrying `canonicalUrl`, optional `derivedLabel` (mechanically derived from the URL slug only),
  `originStatus`, `source`.
- `url-source-coverage.json` — one status per checked source family, every run.
- `extraction-recipe.json` — declarative `extractorId` + `params` steps (no executable code),
  the replay contract for future re-crawls.

## 5. Step 1b — deterministic template classification

Module: `src/research/template-classification/classify.ts`.

Runs after the URL map exists, with no browser and no LLM call. Input is limited to already-
cleaned URL-map metadata (`canonicalUrl`, `derivedLabel`, `originStatus`, `source`) — no page
content, network, or navigation signal. It assigns each entry a `classifications` array mapping
it to zero or more of the 11 research-template categories (`casinos`, `casino_bonuses`,
`cashback_offers`, `free_spins`, `loyalty_programs`, `vip_casino_programs`, `betting`,
`vip_betting_programs`, `deposits`, `withdrawals`, `casino_games`), each with a `role`
(primary/supporting), `confidence` (high/medium/low), and `reason`. The result is written back
onto the entries in `document-url-map.json`.

## 6. Step 2 — product collection

Module: `src/research/url-map-recon/product-collector.ts`. Not part of the recon agent, and not
an LLM step — plain deterministic TypeScript.

It consumes already-distilled title/name lists (produced by a targeted `browser_evaluate`
snapshot of each approved product-landing page found in step 1) and persists only normalized
product lists. It excludes fixture-shaped names (`"Team A vs Team B"`, `"Team A @ Team B"`) via
regex, and caps output (max 500 items, max 120 chars/title). Output depth is fixed: sports →
sport names only, live-casino → category names only, slots → slot names only — never individual
tables, games, matches, fixtures, teams, leagues, or tournaments.

### Outputs

`sports.json`, `live-casino.json`, `slots.json`.

## 7. Step 3 — behavior profiling

Agent: `discovery-browser` (Playwright MCP tools: `browser_navigate`, `browser_snapshot`,
`browser_click`, `browser_take_screenshot`, `browser_find`, `browser_hover`,
`browser_press_key`, `browser_wait_for`, `browser_evaluate`, `browser_network_requests`,
`browser_tabs`, `browser_select_option`, `browser_fill_form`, `browser_resize`,
`browser_close`, plus `Read`/`Write`).

Reads the outputs of steps 1–2 first (`document-url-map.json`, the product JSON files,
`extraction-recipe.json`), then navigates to each approved section (`sports`, `live-casino`,
`slots`, `cashier`, `promotions` — whichever the skill determined are accessible) via real site
navigation, not by guessing URLs. For each it documents: rendering (static vs JS-loaded),
loading pattern (spinner/skeleton/pagination/infinite-scroll), gates (age/cookie/marketing/geo)
and their dismiss mechanisms, interactive elements and their effects, cashier modal-vs-full-page
structure, and navigation paths. It requires the session to already be logged in if login is
needed; a login/registration gate encountered mid-run stops that branch and returns
`human_required`, preserving whatever was already documented.

This agent never writes to the URL map or product files — those are steps 1 and 2's exclusive
outputs.

### Output

`page-behavior.json`.

## 8. Step 4 — review artifact

Agent: `discovery-reviewer` (model: haiku; tools: `Read`, `Artifact`). Strictly read-only —
never modifies, reclassifies, or repairs any pipeline file.

Reads exactly: `document-url-map.json`, `sports.json`, `live-casino.json`, `slots.json`,
`extraction-recipe.json`, and — when present — `page-behavior.json` and
`url-source-coverage.json`. It never reads raw DOM, network payloads, storage state, script
bodies, cookies, or credentials, because none of those exist in any file it opens.

It builds one published HTML artifact (favicon 🗺️) with, in order: header/run summary; the 11
research-template categories rendered from `classifications` (always all 11, `not_found` when a
category has no mapped page — never implying the feature is absent); product collections
(labelled `deterministic-product-collector`, never "script-engine"); the raw discovered URL map;
the page-behavior profile when available; extraction provenance (source counts, coverage
statuses, recipe step names — never executable source, payloads, or credentials). Malformed
`classifications` entries are flagged with a warning and still shown, never silently repaired.

## 9. End-to-end sequence

1. `/casino-discovery casino_url geo` is invoked; the skill resolves `casino_id`/`locale` and
   checks the anonymous-first precondition.
2. `url-map-recon` runs (or, on a valid re-crawl, `replay.ts` runs instead) and produces
   `document-url-map.json`, `url-source-coverage.json`, `extraction-recipe.json`. A blocked
   mandatory source is reported as `human_required` for that source only.
3. `classify.ts` runs deterministically over the URL map and writes `classifications` onto its
   entries.
4. `product-collector.ts` runs deterministically over approved category-landing URLs (fed by a
   targeted `browser_evaluate` snapshot) and writes `sports.json`, `live-casino.json`,
   `slots.json`.
5. `discovery-browser` runs over the approved, accessible sections and writes
   `page-behavior.json`; a login gate mid-run stops that section only as `human_required`.
6. `discovery-reviewer` reads all completed structured artifacts and publishes the discovery
   review HTML artifact.
7. The skill reports: URL-map entry count and source-family coverage, product-list counts,
   sections profiled, unreachable sections, and the artifact URL.

There is no separate "coverage complete?" scoring gate or automatic multi-cycle retry loop
inside a dedicated orchestrator — gaps are surfaced in each step's own return summary, and a
human decides whether to re-run a step (e.g. after providing login) or accept partial coverage.

## 10. Component responsibilities

### `/casino-discovery` skill (the calling agent)

- Parses arguments, resolves locale/casino_id.
- Spawns the three agents in order and invokes the two deterministic modules.
- Decides whether to re-run a step, request human input, or proceed, based on each step's
  reported gaps/blockers.

Does not: touch a browser directly, extract or classify anything itself.

### `url-map-recon` agent

Responsible for: URL/route discovery only, across every supported source family; recording
coverage status; recording a declarative, versioned replay recipe. Never extracts product
titles or page text; never navigates to individual game/table/match/event pages.

### `replay.ts` (deterministic)

Re-executes a previously recorded recipe's extractors against the live site with no agent
involvement, for cheap re-crawls.

### `classify.ts` / `url-clean.ts` / `extractors.ts` (deterministic)

Own normalization, canonicalization, keep/drop filtering, and template-category classification —
purely from already-extracted URL metadata, no browser, no LLM.

### `product-collector.ts` (deterministic)

Owns product-name normalization and fixture filtering from already-distilled title lists. Never
touches URLs or routes.

### `discovery-browser` agent

Responsible for: page-behavior profiling of already-known section URLs only. Never adds to the
URL map or product files; never discovers new URLs.

### `discovery-reviewer` agent

Responsible for: reading finished structured artifacts and rendering the review HTML. Never
re-extracts from the site, never reads raw page/network content, never reclassifies.

## 11. Result of a completed run

| Artifact | Content |
|---|---|
| `document-url-map.json` | Accepted document/compliance/product-landing routes, each with `classifications` |
| `url-source-coverage.json` | `present`/`absent`/`blocked`/`unsupported`/`error` per checked source family |
| `extraction-recipe.json` | Versioned extractor IDs + params, replayable without an agent |
| `sports.json` | Sport product names |
| `live-casino.json` | Live-casino category names |
| `slots.json` | Slot names |
| `page-behavior.json` | Gates, interactive elements, rendering/loading mode, navigation paths |
| Discovery review artifact | Published HTML built only from the structured artifacts above |

# ADR-001: Casino Discovery Pipeline (Agent Recon + Deterministic Review)

- **Status:** Implemented (discovery phase only)
- **Date:** 2026-07-22 (revised 2026-07-24 to match actual implementation; revised again
  2026-07-24 later the same day — see §8 Changelog — to split URL discovery from product
  collection and replace executable recipes with a declarative, deterministically
  replayable contract)
- **Owner:** Partner Compliance Project
- **Scope:** official casino sites; Austria, Brazil, Chile, Norway
- **Stack:** Playwright MCP, one recon agent, one deterministic product collector, one
  reviewer agent, `/casino-discovery` skill

---

## 1. What actually exists

The implemented pipeline is one recon agent, one deterministic collector/replay layer,
and one reviewer agent, orchestrated by the `casino-discovery` skill
(`.claude/skills/casino-discovery/SKILL.md`):

1. **`url-map-recon`** (Playwright MCP agent) — given `casino_url`, `casino_id`, `geo`,
   `locale`, `output_dir`, it discovers **URLs and routes only** — the document/compliance
   URL map — since a static script cannot find URLs hidden in embedded config JSON or
   content bundles. It no longer extracts product titles or any page content; its tools no
   longer include `Read`, and it never returns content samples or DOM-derived labels. It
   writes:
   - `document-url-map.json` — `{casino_id, geo, locale, origin, compiled_at, entries[]}`,
     each entry `{canonicalUrl, derivedLabel?, labelSource?, originStatus, source}`;
     `derivedLabel`/`labelSource` are optional and derived only from the URL slug, never
     from page content; `source` ∈ `dom_anchor | config_route | bundle_footer | bundle_seo
     | bundle_other | external | robots_sitemap | sitemap_index | performance_resource |
     network_request | framework_manifest | spa_route | document_metadata | frame_form`;
     `originStatus` ∈ `official_same_origin | external_approved`.
   - `url-source-coverage.json` — one `{sourceFamily, status}` entry per supported source
     family (see `src/research/url-map-recon/types.ts::SOURCE_FAMILIES`), status ∈
     `present | absent | blocked | unsupported | error`, always recorded even when a
     family is absent on a given site.
   - `extraction-recipe.json` — a versioned, **declarative** recipe:
     `{version: 1, casinoId, recordedAt, steps[{extractorId, pageUrl, source, params?,
     resultType: "url_list"}]}`. No `eval`, no agent-generated executable code, no
     unresolved placeholders, no full manifests/JSON bodies. `extractorId` must be one of
     the registered ids in `src/research/url-map-recon/types.ts::EXTRACTOR_IDS`.
   - On a blocker, returns `{status: "human_required", reason}` for the whole run or a
     single source.

2. **Deterministic product collector** (`src/research/url-map-recon/product-collector.ts`)
   — not an agent. Consumes already-distilled title/name lists (e.g. from a targeted
   `browser_evaluate` snapshot of a product landing page) and persists only normalized
   product lists: `sports.json`, `live-casino.json`, `slots.json` — `[{title, url}]`,
   titles only. Depth: slots → slot names; live-casino → category names only; sports →
   sport names only. Fixture-shaped names (e.g. "Team A vs Team B") are filtered out —
   individual tables/games/matches/fixtures/teams/leagues/tournaments/event pages are
   never collected.

3. **Deterministic recipe replay** (`src/research/url-map-recon/replay.ts`) — validates
   `extraction-recipe.json` (version, schema, registered extractor ids, rejects legacy
   `eval` recipes and unresolved placeholders), executes only registered extractors from
   `src/research/url-map-recon/extractors.ts`, runs results through the URL cleaning layer
   (`src/research/url-map-recon/url-clean.ts`), and produces the same
   `document-url-map.json` contract as a first-run recon — with no LLM involvement.

4. **`discovery-browser`** (Playwright MCP agent, optional profiling step) — reads the
   recon outputs and profiles page behavior per section: modals/gates, JS-loaded content,
   interactive elements, cashier UI. Writes `page-behavior.json` —
   `{casino_id, geo, locale, profiled_at, landing{url, gates[]}, sections{}}`; each
   section has `nav_path[]`, `url`, `rendering`, `load_indicator`, `content_structure`,
   `interactive_elements[]`, `collection{}`, `script_engine_items`, `notes`; unreachable
   sections are `{section, status, reason}`. Stops on auth gates or session expiry.

5. **`discovery-reviewer`** (read-only) — reads whatever recon/behavior files exist in
   `output_dir` and publishes one combined HTML artifact: run header, cleaned URL-map
   table grouped by purpose, product lists, page-behavior profile (if present), and an
   excluded-URLs section with rejection reasons. No validation logic, no scoring.

Precondition: **anonymous-first**. Agents start anonymously (or reuse an already
authenticated browser state), inspect every anonymously accessible URL source first, and
request human authentication only when a mandatory source is confirmed inaccessible due to
a confirmed auth gate — never as a default first step. The agents never attempt login,
CAPTCHA bypass, registration, deposits, withdrawals, or KYC.

## 2. Entry point

`/casino-discovery [casino_url] [geo]` (locale derived: BR→pt-BR, AT→de-AT, CL→es-CL,
NO→nb-NO, else English). `casino_id` is derived from the domain if not given.

## 3. Output location

Confirmed on disk under `data/discovery/`: `document-url-map.json`, `url-source-coverage.json`,
`extraction-recipe.json`, `sports.json`, `live-casino.json`, `slots.json`, plus two additional
files from an earlier probe iteration (`original-dom-probe.json`, `cleaned-url-map.json`)
that predate the current agent-owned extraction and are not produced by the current agents.

## 4. What is not implemented

None of the following exist in the codebase — no schema, no agent, no validator, no
artifact — and should not be assumed present when planning follow-on work:

- Surface Manifest, `playwright-design-package.json`, `surface-review.json`
- Coverage Plan / schema-registry-driven category mapping (template-category
  classification is explicitly out of scope for this pipeline revision)
- Per-surface review statuses (`approved`/`rejected`/`human_required`/`blocked`/…) —
  the only `human_required` signal is a source/section-level extraction status, not a
  review verdict
- Blocker taxonomy, dependency-invalidation rules, or an implementation backlog
- Any generated Playwright collector scripts beyond the declarative recipe + typed
  extractor registry described in §1

Any of this can be designed later, but as a separate ADR once there is a concrete need
— it should not be treated as already built.

## 5. Consequences

- The pipeline is small and cheap: one URL-discovery agent, one deterministic product
  collector, one deterministic replay runner, one optional profiling agent, one
  deterministic-input HTML renderer.
- URL discovery and product collection are separated: `url-map-recon` never returns page
  content, so a prompt-injection payload embedded in DOM/script/bundle text cannot reach
  the product lists or influence agent instructions — it can, at most, cause a bad URL
  candidate, which the deterministic `url-clean.ts` layer classifies independently.
- Re-crawls can skip the agent entirely via declarative `extraction-recipe.json` replay
  (`src/research/url-map-recon/replay.ts`) — deterministic, no LLM involvement.
- There is currently no per-surface human approval workflow — review is done by reading
  the single HTML artifact per run; there is no persisted approve/reject state.
- Product enumeration (sports/live-casino/slots) is titles-only by design; no per-item
  page is opened.

## 6. Known inconsistency

`discovery-browser.md`'s description still says it profiles behavior "so casino-session
knows which Playwright scripts to use" — `casino-session` no longer exists in the
codebase (removed with the old observability pipeline). This is a stale reference inside
the agent file itself, not a pipeline dependency: nothing currently reads or spawns
`casino-session`, and `discovery-browser` runs standalone from the `casino-discovery`
skill.

## 7. Open questions

1. Whether `discovery-browser` profiling should run by default or only on request.
2. Whether/when a review-state artifact is needed once discovery moves toward
   collection.
3. Retention policy for `original-dom-probe.json`/`cleaned-url-map.json` (old-format
   files not produced by the current agents) in `data/discovery/`.

## 8. Changelog — 2026-07-24, URL-only discovery / declarative-recipe revision

`url-map-recon` was restricted to URL/route discovery only; product-title extraction moved
to a new deterministic collector (`src/research/url-map-recon/product-collector.ts`);
executable `eval` recipes were replaced with a versioned declarative contract
(`src/research/url-map-recon/{types,extractors,replay}.ts`); the keep/drop classification
prose that previously lived only in the agent file was encoded as deterministic TypeScript
(`src/research/url-map-recon/url-clean.ts`); authentication moved from
"must already be logged in" to anonymous-first with escalation only on a confirmed gate;
source coverage was made exhaustive and explicit (`url-source-coverage.json`).

**Assumptions no longer true — do not rely on these when reading older notes/sessions:**
- Login is always required before recon can start — recon is anonymous-first now; login
  is requested only on a confirmed mandatory-source gate.
- Login exposes document/compliance/footer links — falsified on the one site this was
  tested against (see `sessions/week-30-2026/2026-07-24-discovery-pipeline-url-map-facts.md`);
  treat as unproven per-site, not as a shortcut.
- `url-map-recon` extracts product titles — as of this revision it does not; a separate
  deterministic collector owns product extraction.
- Stored arbitrary `eval` strings are replayable — `extraction-recipe.json` is declarative
  only (`extractorId` + `params`), replay runs through the registered extractor registry,
  and legacy `eval`-bearing recipes are rejected by `src/research/url-map-recon/replay.ts`.
- Deterministic replay already existed before this revision — §1 point 3 (`replay.ts`) is
  new in this revision, not a restoration of anything prior.
- The deleted static-crawler engine (`bin/url-probe.ts`, `bin/url-map-compile.ts`,
  `src/research/url-probe/*`) remains active — it stays deleted/unused. The new
  `src/research/url-map-recon/*` modules are a separate, purpose-built layer, not a
  restoration of that engine.

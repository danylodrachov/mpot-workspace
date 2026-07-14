---
title: Research capture architecture redesign — extractor delegation and sources schema
date: 2026-07-10
type: session-facts
---

## Worked

- Created `.claude/agents/research-planner.md` — haiku agent that reads a homepage snapshot .yml and produces a category→URL navigation plan JSON for 13 categories, using a reference table of typical URLs built from analysis of 5 brands (slotoro, sportuna, lolajack, mafiacasino, 7signs).
- Created `.claude/prompts/extractor-system.md` — system prompt for the haiku extractor: receives one rubric + one page snapshot + current JSON state, returns a JSON patch with rows + status + sources + cross_notes.
- Created `bin/extract-category.sh` — bash wrapper calling `claude -p --bare --model haiku --system-prompt <extractor-system.md>` with rubric, snapshot, and current JSON as user prompt; returns a JSON patch on stdout. No MCP, no hooks, no tools loaded.
- Added `sources[]` field to the research-data.json schema — array of URL paths per category, with three special prefixes: `nav:` (modal/UI navigation), `cross_read:` (data sourced from another category's pages), `shared:` (same page as another category). Used by Resume to skip re-navigation.
- Backfilled `sources[]` for all 13 categories in `data/research/slotoro-norway/research-data.json` from session notes and session facts.
- Rewrote SKILL.md Step 3 — main navigates + snapshots, delegates extraction to `bin/extract-category.sh`, merges the returned JSON. Main no longer reads rubrics or analyzes snapshots itself.
- Updated extraction-rules — main never extracts; cross-category writes now come from the extractor's `cross_notes` field.

## Decided

- Extractor model is haiku (via `claude -p --bare --model haiku`), not sonnet — accepted the cost/speed tradeoff even though prior sonnet subagent research showed 7-8 of 13 categories need reasoning haiku may struggle with (payment enum mapping, multi-page synthesis, negative-space inference); a focused single-category prompt with one rubric + one snapshot is simpler context than the monolithic skill had.
- `--bare` flag eliminates all MCP/hooks/CLAUDE.md/auto-memory overhead from extractor calls — pure text-in/text-out, zero Playwright tools in context.
- Rejected batch-clear-resume pattern — the Playwright browser session is tied to the main CLI session, so re-invocation loses login/cookies/tabs. Delegation to a haiku `claude -p` call alone solves context bloat instead (main sees only Playwright tool results + short stdout, never rubrics or extraction reasoning). All 13 categories run in one session.
- Parallel extraction model: main opens multiple browser tabs serially (tab1 loads while tab2 navigates), snapshots each via `browser_tabs(select)` → `browser_snapshot`, and runs multiple `extract-category.sh &` calls in background. Real parallelism is concurrent LLM calls, not concurrent browser I/O, since Playwright MCP is single-active-tab.
- Parallel-safe categories: casinos, casino_games, betting, communication_managers, legal (independent URLs). Sequential-only: deposits/withdrawals (shared cashier modal, stateful click loop). Promos cluster (casino_bonuses, free_spins, cashback, VIP/loyalty) shares pages, so batching avoids duplicate navigation.
- Confirmed `research-capture-parallel/SKILL.md` as dead code — it gave Playwright tools to concurrent subagents against one shared MCP server, a race condition the skill's own text acknowledged.

## Open defects

- `bin/extract-category.sh` is untested — no end-to-end run yet with a real snapshot + rubric; haiku extraction quality unverified on actual casino data.
- Extractor `cross_notes` merge logic is not implemented — SKILL.md says main applies cross_notes after a batch, but no script or jq pattern exists for this step.
- `research-planner.md` is not yet integrated into the SKILL.md flow — Step 3 doesn't reference running the planner first; Step 1 still treats sitemaps as the primary navigation source.

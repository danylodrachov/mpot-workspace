---
title: Research capture skill design session
date: 2026-07-09
type: session-facts
---

## Worked

- Ran `/grill-with-docs` design session for automating the manual Playwright research capture flow documented in `sessions/2026-07-09-slotoro-norway-research-facts.md`. 14 decision branches resolved.
- Added **Captured Evidence** definition to `CONTEXT.md` — raw capture output (screenshots, HTML, PDFs, sitemaps) indexed by `manifest.json` with per-category status and file references. Produced into `research/<partner>-<geo>/`.
- Wrote ADR 0043 (research capture: agent-driven skill) — why skill not script, why standalone from Orchestrator, why skill not spawned agent (interactive auth handoff).
- Wrote ADR 0044 (research capture: scope and output) — capture-only boundary, manifest shape aligned with xlsx import template (13 categories), checklist-driven completion, resumable, sitemap-first navigation, capture order (sitemaps → login → all logged-in).
- Updated `design_docs/adr/adr-digest.md` with compressed entries for ADR 0043 and 0044.
- Parsed `casino_import_template.xlsx` (13 sheets: Casinos, Deposits, Withdrawals, Betting, Casino_Bonuses, VIP_Casino_Programs, VIP_Betting_Programs, Loyalty_Programs, Free_Spins, Cashback_Offers, Casino_Games, Communication_Managers, Dropdowns) to align manifest categories with downstream DB schema.
- Wrote PRD `issues/PRD-research-capture.md` — 15 user stories, implementation and testing decisions from ADR 0043/0044.
- Wrote `.claude/skills/research-capture/SKILL.md` — skill prompt with capture flow, 13 category checklist, manifest schema, Playwright pitfall table, resume logic.
- Created issue 11 (skill prompt, AFK, done) and issue 12 (live validation, HITL, blocked by 11).
- Deleted 9 completed OKB pipeline issues (01–06, 08–10). Updated issue 07 frontmatter (cleared resolved blockers). Updated `issues/README.md` to research-capture-only scope.

## Decided

- Capture = Claude Code skill (`/research-capture <site> <geo>`) using Playwright MCP, not a deterministic script. Agent adapts per site; new partner = zero code. → ADR 0043.
- Standalone from Orchestrator — different trigger, output, runtime. Not a pipeline stage. → ADR 0043.
- Skill, not spawned agent — interactive auth handoff (user logs in manually in same browser). → ADR 0043.
- Capture only, no extraction — raw files + manifest index. No structured facts from pages; reasoning is a separate pass. → ADR 0044.
- Manifest categories aligned with xlsx import template sheets (12 data sheets + legal). → ADR 0044.
- Capture order: sitemaps → user login pause → all pages captured logged-in (maximizes content — some bonuses/features only surface after auth). → ADR 0044.
- Parallel capture across tabs via subagents at agent's discretion. → ADR 0044.
- Skill runs as sonnet (user switches to `/fast` before invoking) — Opus too expensive for Playwright page-by-page capture work. Opus not needed since the task is execution, not reasoning.
- Spawned agents cannot access Playwright MCP (MCP servers not inherited) — confirmed as architectural constraint. Rules out agent-file-with-model-frontmatter approach for cost reduction.
- Issues scope narrowed to research capture only — OKB pipeline issues (07 Telegram gate) excluded from active backlog.

## Verified external facts

- Claude Code spawned agents (via Agent tool / `.claude/agents/`) do not inherit MCP server connections from the parent session — verified by examining MCP architecture. Playwright MCP is only available in the main interactive session.

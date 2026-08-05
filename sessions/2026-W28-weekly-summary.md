# Week 28 (2026-07-07 – 2026-07-14) — Summary

## Housekeeping (07-07)
- Removed 7 stale git worktrees (~4MB dupes) causing repo-wide grep to return duplicate hits.
- Fixed broken citations to a deleted session file (5 issues repointed to W27 summary); rule: grep filenames before deletion.
- `data/` (PII, registry) gitignored entirely.
- Decision: session-facts stays standalone, not part of grill workflow; grill-with-docs remains sole ADR/CONTEXT.md writer.
- 115/116 tests pass (1 pre-existing gmail failure).

## Research capture architecture (07-09/10)
- Playwright MCP chosen for research (not separate script); text-capture-default, screenshots on request; manual navigation trigger (not copilot streaming) to keep model calls low.
- Flow: Sonnet records facts → Opus grills → Opus writes ADR+PRD+issues → Sonnet implements.
- ADR 0043: research capture = Claude Code skill, not deterministic script/spawned agent (skill adapts per site; spawned agents can't access Playwright MCP).
- ADR 0044 (rewritten 07-10): capture-only boundary, extract-at-capture design (500-token rubric cost vs ~1M to re-read page later), output = `research-data.json` + screenshots per casino, no HTML dumps.
- Redesigned pipeline: research-planner.md (haiku plan agent), extractor-system.md (haiku extractor), bin/extract-category.sh; parallel-safe categories vs sequential-only (shared cashier modal, shared promo pages).
- Confirmed `research-capture-parallel` skill is dead code: concurrent subagents sharing one Playwright MCP browser instance race and crash mid-task (Sportuna capture: 2 of 3 clusters died).
- Hardening: 11 grill decisions applied to SKILL.md (sitemap domain-first, tab isolation, VIP unification, legal consolidation, typed status enum); 3 hooks added (Stop/PostToolUse/SubagentStop) scoped via skill frontmatter.
- Subagents run on Sonnet 5 (cost/benchmark tradeoff); orchestrator stays Opus.
- RunMedia xlsx audited as canonical import schema: 13 sheets, 159 payment methods, 419 games, deterministic JSON→XLSX conversion (no LLM).

## Casino research runs (Norway market)
- **LolaJack**: operational domain resolved via redirect-chain probing (ll92--lolajack.com); 13/13 categories, 9 collected + 3 not_found; output path convention decided as `research/<partner>-<geo>/`.
- **MafiaCasino**: 20 deposit methods captured (13 crypto via iframe click loop); unified VIP; single consolidated T&C page. Recaptured 07-11 (prior output lost) — payment methods grew 20→22 in 2 days, confirming no caching/reuse across runs.
- **Slotoro**: 16 deposit methods + 5 account-specific bonuses; token cost cut 10x via filename+grep vs full snapshots; two-domain split (SEO vs operational, robots.txt blocks crawlers on operational domain).
- **Sportuna**: full 13/13 success after fixing parallel-subagent race; discovered operational domain does serve a public sitemap (breaks the "operational = blocked" assumption); 17,031 game URLs found.
- **7Signs**: hit Anthropic API session limit mid-run, resumed via non-parallel skill; fixed `browser_click` timeouts via `browser_evaluate` el.click() (elements mid-CSS-transition).
- **AzurSlot** (07-14): manual ad-hoc rubric lookup (not full pipeline) using snapshot+grep; accordions required click-then-resnapshot to reveal hidden content.
- **Batch run (07-13)**: `casino-resume` recovered mid-death slotoro run; root cause of auth-browser hang = `--permission-mode acceptEdits` doesn't grant `mcp__playwright__*` tool calls — fixed via explicit permissions.allow entry. Confirmed Playwright MCP uses real installed Chrome, not bundled Chromium.

## Other
- Article-brief audit dry run: 19/20 score, 1 real defect (og:title not inherited); root cause of earlier false failure was comparing against the wrong brief.

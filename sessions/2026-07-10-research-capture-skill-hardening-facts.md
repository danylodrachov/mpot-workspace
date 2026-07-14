---
title: Research capture skill hardening — hooks and model choice
date: 2026-07-10
type: session-facts
---

## Worked

- Applied 11 grill decisions to `.claude/skills/research-capture-parallel/SKILL.md` (9 edits) and `.claude/skills/research-capture/SKILL.md` (8 edits, same minus parallel-specific content). Changes: XML `<rules>` and `<per-page-protocol>` wrapper tags, pseudocode resume with crash recovery, sitemap operational-domain-first, tab isolation caveat, VIP unified program handling, legal consolidated page handling, typed status enum block, form pre-fill pitfall row.
- Researched Claude Code hooks architecture via subagent — 30+ hook events documented, 6 hook types (command, http, mcp_tool, prompt, agent, async), existing repo hooks (verdict-schema.sh, run-completeness.sh, effect-free-wall.sh) as pattern reference.
- Researched Sonnet model variants via subagent — Sonnet 5 vs Sonnet 4.6 pricing, context windows, computer-use benchmarks, agentic coding benchmarks, tokenizer differences.
- Grill session on hooks + model choice produced 8 confirmed decisions (below). Created 3 hook scripts in `.claude/hooks/`, added YAML frontmatter with hooks config to both SKILL.md files, added `model: "sonnet"` to parallel skill's subagent launch instruction.

## Decided

- Stop hook (`research-capture-stop.sh`) blocks skill completion until all 13 categories have a status and `completed_at` is set. Also blocks if parallel cluster files exist but fewer than 3. Analogous to existing `run-completeness.sh`.
- PostToolUse Write hook (`research-capture-validate-write.sh`) validates manifest.json and cluster-*.json after every write: status must be one of 4 enum values, `collected` requires non-empty `files[]` with all paths existing on disk, `failed` requires `failure_reason`.
- SubagentStop hook (`research-capture-cluster-check.sh`, parallel only) injects `additionalContext` with cluster file count so parent knows immediately if a subagent died without writing output. Cannot block (event type limitation) — informational only.
- No prompt/agent-type hooks — command hooks with jq cover all validation needs at zero token cost. Prompt hook (Haiku LLM call, 30s timeout) unnecessary for structural checks.
- Hooks configured in skill YAML frontmatter, not settings.json — scoped to skill activation only.
- Subagents use Sonnet 5 (`model: "sonnet"` in Agent() call) — 81.2% vs 78.5% computer-use benchmark, 128K vs 4K max output, $2/$10 intro pricing (vs $3/$15 for 4.6) until 2026-08-31.
- Parent orchestrator keeps inherited model (Opus) — no explicit setting. Coordination and merge logic needs stronger reasoning.
- No effect-free-wall for research-capture subagents — they need Bash (`ls`, `grep` for resume), Read, Write, and all Playwright MCP tools.

## Verified external facts

- Claude Code hooks: Stop hook has 8-iteration block cap (env var `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to raise). PostToolUse cannot undo already-executed writes — only block continuation. SubagentStop exit 2 shows warning but does not block. Hooks don't access conversation context — only current event JSON.
- Sonnet 5 uses a new tokenizer producing ~30% more tokens for the same text. At post-introductory pricing ($3/$15, same rate as 4.6), effective cost is 20–42% higher. Introductory pricing ($2/$10) expires 2026-08-31.
- Sonnet 5 native 1M context window (always active). Sonnet 4.6 requires `[1m]` suffix and usage credits for 1M.
- Sonnet 5 tool-use overhead: 354 tokens vs 497 for Sonnet 4.6 (~30% less per request).
- Agent tool `model` parameter accepts aliases (`sonnet`, `opus`, `haiku`, `fable`) and exact model IDs (`claude-sonnet-5`, `claude-sonnet-4-6`). `sonnet` resolves to `claude-sonnet-5`.
- Instruction violations from 3 research sessions (slotoro, lolajack/mafiacasino, sportuna) were predominantly Category A (missing instructions — model had no guidance) not Category B (ignored instructions). XML tags only help Category B.
- Claude Code SKILL.md is injected as raw markdown with no XML tag wrapping. Only CLAUDE.md gets the "IMPORTANT: MUST follow exactly" preamble. After compaction, first 5,000 tokens per skill survive, 25,000 total budget.

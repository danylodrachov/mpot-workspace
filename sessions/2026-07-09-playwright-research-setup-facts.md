---
title: Playwright MCP setup for partner research
date: 2026-07-09
type: session-facts
---

## Worked

- Verified Playwright installed globally: Python package 1.60.0, CLI 1.61.1 via npx; Chromium 1223 browser cached; Firefox/WebKit not installed.
- Added `@playwright/mcp` (official, v0.0.77) to `.mcp.json` as `playwright` server (`npx @playwright/mcp@latest`).

## Decided

- Partner research (casino websites) will use Playwright MCP for browser automation, controlled from Claude Code CLI — not a separate script or extension (reason: stays in one context, manual trigger per page keeps token cost low).
- Default capture = DOM/text extraction; screenshot only on explicit request (reason: text cheaper than vision tokens, Sonnet parses structured text better).
- User navigates manually, triggers capture when needed — not live browser copilot streaming every navigation (reason: copilot = hundreds of model calls per site; manual trigger = ~10).
- Flow shape: Sonnet records facts per site → Opus grills user on open questions → Opus produces ADR + PRD + issues → Sonnet models implement.

## Open defects

- Playwright MCP server not visible in `/mcp` list — `.mcp.json` changes require Claude Code session restart to take effect.

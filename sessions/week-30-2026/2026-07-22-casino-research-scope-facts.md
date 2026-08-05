---
name: 2026-07-22-casino-research-scope-facts
description: >-
  Casino research scope narrowed to slots, live-casino, sports only; login
  required before research; per-surface collection depth fixed (slot names,
  live-casino categories only, sport titles only); about page excluded.
when_to_use:
  - Configuring or reviewing casino-discovery / casino-session category scope
  - Deciding whether an MCP agent should visit individual game/event pages
  - Deciding what depth to collect for slots vs live-casino vs sportsbook
  - Wondering why the About/Legal surface is skipped
authoritative_source: docs/adr/ADR-0046 (or successor casino-research ADR)
related: [casino-payment-method-collection]
---

# Casino research scope — facts

- **Decided** — Human login is a required precondition before casino research proceeds; the agent does not attempt to work around login/registration gates. Reason: matches existing "unexpected auth/registration state => human handoff" rule, made explicit as a hard precondition rather than a per-blocker judgment call.
- **Decided** — Only three categories are research-worthy: slots, live-casino, sports. All other discovered categories (bonuses, VIP programs, loyalty, cashback, etc.) are out of scope for the collection phase.
- **Decided** — MCP browser agent collects page URLs only; it never visits individual game or event pages. Reason: keeps the browser agent's job bounded to surface/URL discovery, not content extraction.
- **Decided** — A separate script (not the MCP agent) is responsible for extracting slot game names from the collected URLs.
- **Decided** — Live-casino collection depth is categories of games only — individual live-casino table/game titles are not collected.
- **Decided** — Sportsbook collection depth is sport titles only (e.g. football, tennis) — individual event/match pages are not collected.
- **Decided** — The About/Legal page is never collected; it was flagged as low-value ("trash") for research purposes.
- **Worked** — Ran casino-discovery on parimatch-plus.bet (Brazil, requested locale pt-BR); discovery-browser agent found 3 surfaces (one per category: SURF-SPORTS-01 `/en/football`, SURF-SLOTS-01 `/en/casino/slots`, SURF-LIVECASINO-01 `/en/casino/live-casino`), all ready_for_review with no gaps. 24 tool calls, ~99.7k tokens, ~3 min.
- **Verified external fact** — parimatch-plus.bet ignored the requested pt-BR locale and served `/en/` regardless; confirmed by direct navigation, not just agent report.
- **Verified external fact** — Login-state can be distinguished pre-navigation via `browser_find` regex: unauthenticated shows "Cadastrar-se"/"Crie sua conta" (registration CTAs), authenticated shows a currency balance button (e.g. "BRL 0.00") + "Deposit" button, no login/registration text.

# ADR 0020 — The AFK agent is built on Node.js / TypeScript

- **Status:** Accepted
- **Date:** 2026-06-14
- **Context grill:** afk-agent — stack choice before the prototype build

## Context

With the roster and input flow settled the prototype is ready to
build, which forced the implementation-language choice. The prior implementation was
Python and was wiped. The operator — who is not a coder — leans Node.js because the
system's near future includes a long-running localhost server, inbound webhooks, and
two-way communication with the agent over Telegram, with a possible VPS deployment later.

A research pass against the official Anthropic / Claude Code docs was run to test that
instinct against documented support, framed as Node/TypeScript vs Python.

## Decision

**The AFK agent is built on Node.js / TypeScript.**

The deciding facts:

- **The agent runs *as Claude Code*, which is a Node binary — no SDK.** The Brain and
  subagents are not a framework we wire: they are Claude Code's **native** subagents
  (`.claude/agents/*.md`) and hooks (`.claude/settings.json`), run on the operator's
  Pro/Max subscription (ADR 0035). So the runtime is already Node; the satellite tooling
  should match it rather than straddle two languages. (The Anthropic **Agent SDK is
  *not* used** — it requires a per-token API key and can't ride the subscription, ADR 0035.)
- **The server/webhooks/Telegram future favors Node.** An HTTP server (Express/Fastify) and
  a Telegram bot (**grammy**, native TypeScript — ADR 0035) run in one async event loop,
  in the same language as the fetch/effect scripts that sit beside Claude Code. In Python
  the Telegram library would run apart from that JS tooling — more to coordinate.
- **Lower friction for a non-coder operator.** Node installs flat (`npm install`, the
  Claude Code binary bundled), no virtualenv; fewer moving parts to deploy to a VPS later.
- **No migration cost.** The prior Python code is wiped; there is no unique Python asset to
  preserve.

## Consequences

- The prototype and everything after it is TypeScript on Node. Fetch scripts, the gated
  effect code (send, status-write), the future server / webhook listener / Telegram bot,
  and the Brain-and-subagent wiring all live in one runtime.
- The one capability deliberately given up: Python's more mature heavy-AI ecosystem
  (LangChain/LangGraph and the like). This costs nothing here — external effects are plain
  scripted code behind the [[Approval Gate]], not reasoning chains, so the satellite tooling
  Python leads on is not used.
- Revisit only if the system later grows a genuine need for that Python-led AI tooling —
  not for ordinary server or integration work, which Node covers well.

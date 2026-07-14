# ADR 0035 — Dependency stack: free, mostly raw-REST

- **Status:** Accepted
- **Date:** 2026-06-16
- **Context grill:** library research for the AFK agent's external clients + infra


## External source clients

| source | choice | why this, not a library |
|---|---|---|
| **ClickUp** | **raw REST v2** + native `fetch`, hand-written response types | every npm client is unofficial, hobby-scale, stale. The API is clean REST — filters (`assignees[]`, `date_updated_*`, `statuses[]`) are query params. Token in one header; 100 req/min ≫ a daily pull. ~5 calls don't earn a dep. |
| **Gmail** | **`@googleapis/gmail`** + **`google-auth-library`** | the *one* justified SDK: it owns the OAuth2 **refresh-token** lifecycle and base64url body decode — the parts not worth hand-rolling. Single-user offline flow (`access_type:offline` once → store refresh token). Apache-2.0; quota effectively unlimited for a daily sweep. |
| **Reply.io** | **raw REST v3** + `fetch`, `Authorization: Bearer` | no maintained Node client exists. Plain bearer-auth REST. **API access is plan-gated (paid)** — confirmed available on the operator's plan; it is the one non-free *service* on the spine (the code to call it is free). |

## Email hygiene

| need | choice | why |
|---|---|---|
| **quote-trail stripping** | **`email-reply-parser`** (crisp-oss fork, MIT) | maintained at scale; **verified to handle the localized boundary** (`El … escribió:`, `a écrit`, …) we actually hit — not just English `On … wrote:`. `getVisibleText()` returns the fresh top reply. (`node-email-reply-parser` stale; `talon` is Python.) |
| **machine-mail detection** | **hand-coded (~20 lines), no lib** | no focused lib worth a dep. Gmail hands the headers over directly; treat as machine if any of `Auto-Submitted ≠ no` (RFC 3834, authoritative), `Precedence: bulk/list/auto_reply`, `List-*` present, empty return-path (bounce), or an OOO subject. This is [[machine-filter]]'s input (ADR 0034). |
| **MIME parsing** | **mostly none** — Gmail's `messages.get` returns a structured `payload`; walk `parts`, take `text/plain`, base64url-decode. Fall back to **`postal-mime`** (MIT-0) only for raw RFC822 / HTML-only mail | `mailparser` is officially in maintenance-mode and itself now points new projects to postal-mime. |


## Consequences

- **The agent costs nothing per run.** It runs as a Claude Code session on the Pro/Max subscription — no API key, no per-token billing.
- **Small dependency surface.** Two real libs do the heavy lifting (`@googleapis/gmail`, `grammy`) plus tiny utilities (`p-limit`, `zod`, `email-reply-parser`, optional `postal-mime`). Subagents + hooks are Claude Code native, not a library. Everything else is raw REST + native `fetch`, matching the existing Telegram-by-fetch pattern.
- **One paid service, by necessity.** Reply.io's API is plan-gated; the codebase stays free, the *account* is not. If that plan lapses, the Reply.io fetch is the single client that goes dark.
- **`telegraf` is rejected on staleness**, not capability — revisit only if grammy's maintenance changes.

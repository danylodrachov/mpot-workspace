# ADR 0039 — Gmail integration facts

- **Status:** Accepted
- **Date:** 2026-06-21
- **Context grill:** does Gmail return a full inbox window the way reply.io does, and what does
  the "all inbox messages, today−2d → today, one JSON file" fetch (ADR 0034) actually cost?
- **Companion to** ADR 0036 (reply.io facts).

Verified against `developers.google.com/workspace/gmail/api/reference/rest/v1` and the Gmail
search-operator reference, plus the connected mailbox (`gmail.readonly` token, `googleapis` v1).
Only facts — the decisions they force live with the spine (ADR 0034).

## Verified facts (Gmail API v1)

- **Discovering inbox threads is a separate, paginated list — not the body call.**
  `users.threads.list` returns **stubs only**: `{ threads[]: {id, snippet, historyId},
  nextPageToken, resultSizeEstimate }`. Each thread resource here **does not** carry `messages[]`.
  `maxResults` default **100**, max **500**; more than one page ⇒ loop on `nextPageToken`.
- **Full bodies are one call _per thread_.** `users.threads.get(format:"full")` returns
  `{ id, snippet, historyId, messages[] }` with the **entire message history** inline — each
  message's complete `payload` (base64url MIME parts) included, no further hop for inbound bodies.
  This is the same shape as reply.io's `messages[]` thread, but reached only **after** the list hop.
  ⇒ An inbox window = **1 list (paged) + N `threads.get`**, not one call.
- **A date window is available but NOT used.** `threads.list` `q` accepts the Gmail search syntax —
  `after:`/`before:` (`YYYY/MM/DD` or epoch) and relative `newer_than:Nd` / `older_than:Nd`. The
  spine **does not** use it (decision, 2026-06-22): Gmail is inbound-only and unbounded by date —
  the fetch is **unread + freshest page**, and freshness/dedup is decided downstream at the
  join-map gate (per-message id), not at the query. The window operators are recorded here only as
  an available fact. (Caveat if ever re-enabled: absolute dates are **midnight PST**, day-granular.)
- **Inbox + unread scope is a server-side label filter.** Pass
  `labelIds:["INBOX","UNREAD"]` on `threads.list`. `INBOX` is the API-native scope; `UNREAD`
  narrows to the actionable set. Equivalent search string `q:"in:inbox is:unread"`.
- **A per-message id exists** — `id` (immutable) plus `threadId` on every message. This is the
  key difference from reply.io (no message-level id): Gmail idempotency is possible at **message**
  granularity, not just thread.
- **Thread `id` is a stable hex string** (e.g. `19e6ee3283f8b408`) — the durable join key
  (reply.io's is an integer; same role, different type).
- **Inbound vs outbound is read off `labelIds[]`**, not a boolean. Outbound carries the `SENT`
  label; inbound carries `INBOX` / lacks `SENT`. There is no reply.io-style `isOutbound` flag.
- **Headers are `payload.headers[]` `{name, value}` pairs.** From / To / Subject / Date live
  there. `payload` is a recursive `MessagePart` `{partId, mimeType, filename, headers[],
  body{data, size, attachmentId}, parts[]}`; text body = base64url in `body.data`, attachments
  referenced by `body.attachmentId` (a second hop to fetch — bodies are not).
- **`internalDate` (epoch ms) is the authoritative timestamp** for ordering, more reliable than
  the `Date` header. `historyId` is the last-modified marker (per message and per thread) — the
  basis for incremental sync, paralleling reply.io's `lastActivityDate` freshness marker.

## Consequences forced by the facts

- **The "one JSON file" is assembled by code, not returned by an endpoint.** The fetch (ADR 0034)
  is: `threads.list(labelIds:["INBOX","UNREAD"], maxResults:N)` — **freshest page only, no
  `nextPageToken` loop, no date window** → for each thread `id`, `threads.get(format:"full")` →
  collect `messages[]` → write one array file per source into `inputs/raw/`. The N+1 fan-out is
  intrinsic; only the **per-thread body** is single-call. Unlike reply.io, the extra hop is at
  **discovery** (list), not at the body — `threads.get` already inlines every inbound body. List
  results are newest-first, so the first page = the freshest unread.
- **Idempotency _can_ be message-keyed** (Gmail has a message id), finer than reply.io's
  thread-only. To stay symmetric with the reply.io spine, the **thread `id` stays the join key**;
  the message `id` is available if finer dedup is later wanted.
- **No date window — freshness lives at the join-map gate.** Because the fetch is unread-only on
  the freshest page, "already processed" is decided per-message downstream: the newest message
  `id` already in `seen_message_ids` ⇒ skip (ADR 0034 §3.4). A direction/recency check at fetch is
  unnecessary — unread implies a new inbound to act on; outbound chases are reply.io's job, not
  Gmail's.

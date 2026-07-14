# ADR 0036 — Reply.io integration facts

- **Status:** Accepted
- **Date:** 2026-06-19
- **Context grill:** /grill-with-docs — OKB message-first spine (reply.io entry)

The OKB message-first workflow rests on what the Reply.io v3 API actually exposes. Verified
against `docs.reply.io/api-reference`. Only facts — the decisions they force live with the spine.

## Verified facts (Reply.io v3)

- **Thread `id` is a stable integer.** It is the only durable identifier the API returns and is
  the join key from a reply to its OKB card.
- **No per-message id exists.** A message carries `date`, `isOutbound`, `body`, `fromAddress`,
  `subject` only. There is no message-level identifier — identity and idempotency are possible
  at **thread** granularity and no finer.
- **`sequence: {id, name}` rides on the thread.** The reply→sequence link is on the thread
  object; no extra call is needed to know which sequence a reply belongs to.
- **`POST /v3/inbox/threads/filter` filters natively** on `source` (`"inbox" | "sent" |
  "unread" | "aiDraft"`) plus a `from`/`to` range over `lastActivityDate`. Any
  date-window entry condition (e.g. "last activity ≥ N days ago") is a filter param, not code.
- **`source` enum semantics:** `inbox` = **all threads with ≥1 inbound message, regardless of
  read-state**; `unread` = the unread subset only; `sent` = latest activity outbound; `aiDraft`
  = pending AI draft. `status.state` is **not** a queryable filter (client-side only).
- **No thread-level "replied" flag.** A Media reply is detectable only as the presence of an
  `isOutbound:false` message. `source:"inbox"` is its read-independent server-side proxy — the
  reliable "this thread has a reply" signal that survives a human opening the thread.
- **The `email_replied` webhook carries no thread id** — only `contact_fields.id`,
  `sequence_fields.id`, `reply_message_id`. It cannot be joined on the thread `id`, the chosen
  match key.
- **Full inbound body needs a second hop.** The thread carries only `bodyPreview`; the complete
  body is the newest `isOutbound:false` message from `GET /v3/inbox/threads/{id}/messages`.
- **A push path exists.** The `email_replied` webhook fires on a new inbound reply — an
  alternative to polling the thread list.
- **Step-targeted enrolment is bulk-add only.** A starting step can be chosen only via
  `POST /v3/sequences/{id}/contact-links/bulk` — `startStepId` (start step), `startFrom`
  (start date), `ignoreStepDelay` (skip first-step delay). No status/resume endpoint accepts a
  step.
- **A replied contact cannot be re-added in place.** Bulk-add returns per-item
  `contactAlreadyInSequence` for an existing enrolment. Re-targeting a step requires removing the
  link first — `removeFromExisting:true` on the bulk-add, or `POST /v3/sequences/{id}/contacts/remove`.
- **Two state-toggle endpoints exist, neither takes a step.**
  `POST /v3/sequences/{id}/contacts/set-status-in-sequence` sets `statusInSequence` ∈
  `active | paused | finished | outOfOffice` (excludes replied/bounced).
  `POST /v3/sequences/{id}/contacts/set-replied` toggles `isReplied`. Docs do not state that
  clearing `isReplied` resumes step delivery — unconfirmed.
- **All sequence-contact endpoints are beta.**

## Verified facts — sequence creation & personalisation (added 2026-06-23)

- **A sequence is created fully via REST.** `POST /v3/sequences` — `steps[]` is in the **request
  body**; each email step's `variants[]` carries `subject` + `message` (+ `attachmentIds`, max 3)
  inline. `name` is the only required top-level field. There is no separate add-step endpoint —
  step content ships in the create payload.
- **Sequence `settings` is all-or-nothing if present:** `emailsCountPerDay`, `daysToFinishProspect`,
  `emailSendingDelaySeconds`, `dailyThrottling`, `disableOpensTracking`, `repliesHandlingType` ∈
  `markAsFinished | continueSending`, `enableLinksTracking`. `scheduleId` + `emailAccounts` are
  separate top-level fields. `update-sequence` (PATCH) exposes the same shape.
- **Per-contact `customFields[]` (`{key, value}`) are writable on `POST /v3/contacts`** alongside
  the standard fields. They are **single-valued per key**.
- **Template variables resolve per-recipient at send** and work in the **subject** as well as the
  body; fallback `{{Field | "default"}}` works in both. One shared sequence therefore renders N
  distinct subjects/links from per-contact `customFields` — no per-person copy needed.

## Consequences forced by the facts

- **The day's fetch window is `lastActivityDate ≥ today − 2 days`** — a native
  `POST /v3/inbox/threads/filter` `from`/`to` param, not custom code. reply.io's "what enters the
  day" is keyed on **last activity** — reply.io is the **time-gated** source (it also owns all
  outbound chasing for both boards, ADR 0034 §2). Contrast Gmail, which is **not** date-gated:
  unread + freshest page, freshness decided at the join-map gate (ADR 0039).
- **Idempotency is thread-keyed.** With no message id, "have I already processed this reply?"
  can only be answered per thread — via the thread `id` plus its `lastActivityDate` as the
  freshness marker.
- **`source:"unread"` is sticky.** A thread stays in the unread bucket across runs until marked
  read, so re-run safety cannot rely on the bucket emptying itself.

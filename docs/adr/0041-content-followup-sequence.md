# ADR 0041 — Content-board follow-up sequence (reply.io)

- **Status:** Accepted
- **Date:** 2026-06-23
- **Context grill:** reply.io sequence for Content (CKB) communication
- **Relates:** 0036 (reply.io integration facts), 0038 (ckb pipeline & status), 0034 (spine)

The Content-board follow-up: a per-person email carrying a link to the publication draft +
a personalised subject (article title), so the recipient posts on time. Channel = reply.io
(outbound for both boards stays in reply.io; input monitoring stays 2 channels). This ADR pins
**how** that follow-up is delivered as a reply.io sequence.

## Mechanics

All reply.io API mechanics this design rests on — full-REST sequence creation with inline step
`variants` (`subject`/`message`), `settings`, writable per-contact `customFields[]`, variables that
resolve per-recipient in subject + body, and start-step enrolment via `contact-links/bulk`
(`startStepId`, `removeFromExisting`) — are recorded as verified facts in **ADR 0036**.

## Known constraints (force the design)

- **Sequence-contact endpoints are beta** (ADR 0036).
- `customFields` are single-valued per contact → a contact carries one current article at a time;
  the 1-email-to-many-articles relation is handled over time (overwrite + re-enrol).
- **Re-targeting a finished contact to a step is the load-bearing move.** A reply marks the contact
  `finished` (markAsFinished); moving it to any later step requires `removeFromExisting:true` +
  `startStepId` on `contact-links/bulk`. Every script-driven transition below pays this cost.

## Design — Spanish Content follow-up sequence

**Shape: one shared sequence.** Personalisation rides entirely on per-contact `customFields` (no
per-person copy of the sequence). Step delays run on **2 business days**.

`repliesHandlingType: markAsFinished` — any inbound reply stops the sequence and sets the contact
`finished`. The reply is then judged by an agent; the **script** drives every onward transition by
re-enrolling the contact at a chosen `startStepId` (remove + bulk-add).

### Custom fields (set on contact import, step 0)
- `article_draft_url` — Google Drive **folder** link, extracted by helper from the CKB task
  (regex `drive\.google\.com/drive/folders/([\w-]+)` over comments/description; see Join section).
  This same folder id is the join key back to the card.
- `article_title` — article name pulled from the matching ClickUp (CKB) task → used as subject;
  also the **fallback** match field (subject ↔ task name) when no folder id is present.
- `corrections_body` — empty at import; filled later by the verification subagent for the fixes step.

### Steps (templates, defined inline in `POST /v3/sequences`)

- **Step 0 — import.** `POST /v3/contacts` with `article_draft_url` + `article_title`; enrol at Step 1.
- **Step 1 — initial ask** (subject `{{article_title}}`):
  > Hola {{CONTACT_NAME}}, espero que estés bien. Te escribo para compartirte que ya tenemos listos
  > los materiales para la publicación:
  >
  > Artículo {{article_draft_url}}
  >
  > Cuando tengas oportunidad, ¿podrías revisarlos? Nos sería de gran ayuda conocer cuándo podríamos
  > contar con la publicación.
  >
  > Saludos,

  (`CONTACT_NAME` → standard `{{firstName}}`/name field; `CUSTOM_URL` → `{{article_draft_url}}`.)
- **Step 2 — chase / "no response".** Fires natively after **2 business days** of silence (step delay).
  Also the re-target landing for a reply that carries no published-article link.
- **Step 3 — corrections** (subject `{{article_title}}`):
  > Hola {{CONTACT_NAME}}, muchas gracias por la publicación. Ya revisé el artículo y hay un par de
  > puntos que necesitaríamos corregir, por favor:
  >
  > {{corrections_body}}
  >
  > ¿Podrían revisarlo, por favor?
- **Step 4 — final thank-you** (sent once the article is verified OK):
  > Hola, {{CONTACT_NAME}}, espero que estés muy bien. Ya revisé el artículo y todo está correcto de
  > mi parte, no tengo más comentarios. Muchas gracias por tu trabajo.

**Loop guard:** the chase is the Publication-lane follow-up reply.io runs per ADR 0038 (handoff to
reply.io chasing the publication link). Cap = **no more than 2** runs of each follow-up step before
the contact stops bouncing.

### State machine (script reads the agent's `verdict`)

1. Enrol → **Step 1**.
2. No reply in 2 days → native delay advances to **Step 2** (chase).
3. Reply arrives → contact `finished`. Agent judges the reply, emits `verdict` (bool: reply contains
   a link to the **published** article).
   - `verdict = false` (no published link) → script re-enrols at **Step 2** (chase again).
   - `verdict = true` (link present) → contact stays `finished`; hand to **verification flow
     (out of scope)**.
     - verification OK → script re-enrols at **Step 4** (thank-you).
     - verification NOT OK → verification subagent (out of scope) returns the fix text → script writes
       it to `corrections_body` → re-enrols at **Step 3** (corrections).

### Join to the CKB card — Drive **folder id** is the content join key

The content board joins thread↔card on the **Google Drive folder id** — the artifact the outlet
actually receives. **Verified against real data:**
- The outlet email's SENT turn top-post carries `drive.google.com/drive/folders/<id>` (goluchas
  thread). The outlet is **always** sent a folder, never a file/doc — so folder id is the durable key.
- The matching CKB task carries the same folder link. **Source = operator-pasted link in a task
  comment/description** (manual; link presence is the operator's responsibility). The ClickUp
  Google-Drive **"Folders" panel ("Added by ClickUp Bot") is NOT exposed by REST v2**
  (`attachments:[]`, even with `include_attachments=true`) — not a usable source.

**Extraction helper (deterministic, no reasoning):**
- `task → folder_id`: regex `drive\.google\.com/drive/folders/([\w-]+)` over the task's comments +
  description (comment segments `bookmark`/`link_mention` or plain text). **Ignore** `/document/`,
  `/spreadsheets/`, `attachments.clickup.com`. Multiple → last by date. **None → helper writes the
  sentinel string `DRIVE URL NOT FOUND`** (not null, not a guess) so the miss is explicit + surfaces
  for handoff.
- `thread → folder_id`: same regex over the thread's own **SENT top-post** (quoted tail already
  stripped per 0034; the link lives in our outbound turn, not the inbound reply).
- **match**: `task.folder_id == thread.folder_id` (string compare on the extracted id).

**Join rules:**
- **Primary key = folder id.** Fallback = `article_title` search (email subject ↔ task name) **only
  when exactly one task matches**; ambiguous or `DRIVE URL NOT FOUND` ⇒ **handoff** (halt-never-guess, 0037).
- The match runs in the **serial join-map resolver** (0034 §49) — the **sole writer** to `join-map.json`.
  Gated on **raw ClickUp fetched** (folder id comes from the task): the first cross-branch dependency,
  before any reasoning tier.
- **reply.io path needs no body scan** — thread↔task is known at enrol (we set `article_draft_url`
  ourselves); folder-id match is the **Gmail** path (+ a cross-check).
- **No spreadsheet / Sheets API / service-account** anywhere in this join — extraction is the regex
  above over data already in hand (ClickUp task, Gmail thread).
- On match the resolver writes `message_id` (reply.io thread `id` / Gmail thread `id`) into the card's
  join-map entry. Inbound is **poll-only — no webhooks/server**: later replies are found by polling
  and resolving against the map; no board search.

- **Enrol timing — resolved.** The join-map key is **always `clickup_task_id`** (0034 §3.4, card-anchored),
  never the thread id. So thread id is a **field in the entry, not the key**: a non-blocking concern. The
  resolver writes the entry **at enrol** — keyed on the known CKB `task_id`, with `message_id: null` —
  and backfills `message_id` later when the inbox poll resolves the thread (by folder-id / the `article_draft_url`
  we set). No race, no "write at enrol vs after first send" choice: the entry exists the moment the card id
  is known; the thread id is a deferred marker.

### Sequence `settings` numbers

`settings` is all-or-nothing if present (0036). Values, derived from the cadence (step delay 2 business
days, 2 automatic follow-ups):

- **`scheduleId`** — default account schedule.
- **Step delays** (`startFrom`, business days from enrol): Step 1 = day 0, Step 2 chase #1 = +2 bd
  (day 2), chase #2 = +2 bd (day 4). Loop guard caps the chase at 2 runs.
- **`daysToFinishProspect`: 8** (calendar). Covers only the silent path Step 1 → chase #2 (4 business
  days ≈ 6 calendar) plus a weekend buffer. Steps 3/4 are reply/verification-driven and don't count —
  `markAsFinished` finishes the contact on any reply and the script re-enrols for them.
- **`emailsCountPerDay`: 1.** A 2-business-day step delay means one outlet never receives >1 email/day;
  with one shared sequence this guarantees no double-touch on the same card.
- **`repliesHandlingType: markAsFinished`** (as above).

### Transition ownership (determinism boundary)

The agent **only judges and returns a verdict**; it never enrols, writes, or touches reply.io / join-map.
The **script** owns every transition and effect.

- **Judging agent (NL verdict only):** the bool `reply contains a published-article link`; the
  verification subagent's correction text when the article is NOT OK.
- **Script (data comparison + effects, zero reasoning):** enrol → Step 1; native delay → Step 2;
  all re-enrols (Step 2/3/4 via `removeFromExisting:true` + `startStepId`); writing `corrections_body`;
  the loop-guard counter (≤2 runs/step); `markAsFinished` on inbound.

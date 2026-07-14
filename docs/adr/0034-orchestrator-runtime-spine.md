# ADR 0034 — Orchestrator runtime spine

- **Status:** Accepted
- **Date:** 2026-06-15
- **Context grill:** /grill-with-docs — "Orchestrator + subagents" flow

How a single day's cycle runs end to end. 

## Prep & Input

1. **Shell script** builds the day folder (layout per ADR 0027). Layout: a **permanent `data/`**
   parent (never deleted — holds the cross-day `join-map.json`, below) containing per-day
   `data/<date>/` dirs (created once daily, disposable, live one day), each with
   `data/<date>/inputs/{raw,clean}/` and `data/<date>/outputs/{emails/{gmail,replyio},tasks}/`
   (emails sub-foldered by source, §3.2; tasks = ClickUp — split dirs are the routing discriminator,
   ADR 0027). **[MODEL DECISION] Idempotent
   builder:** `mkdir -p` the layout; never deletes. Across days the `<date>` dir is fresh (0027
   disposability); a same-day re-run is a no-op on existing structure — it never clobbers work
   already in the folder.
2. **Fetch scripts** (TypeScript, per ADR 0020) write **raw JSON with all threads, one file per source** into
   `data/<date>/inputs/raw/`:
   - **ClickUp tasks** — filter: assignee = me, due within today + the 2 prior days, status ≠
     `completed` and ≠ `backlog`. Each task carries its **board origin** (Outreach / Content).
   - **Gmail + Reply.io** — `source:"inbox"`, read-only. Each thread is stored as the **raw
     thread** the API returns (full `messages[]` history) — no normalization. **[MODEL DECISION]
     Gmail fetch is discover-then-hydrate** (raw-JSON review, 2026-06-22): a single **`threads.list`**
     page (freshest unread INBOX, no paging) discovers *which* threads to pull, then **`threads.get`
     per thread** hydrates the full conversation — **including our own `SENT` messages**. The exact query, scope, and N+1
     cost are ADR 0039's facts, not restated here. The per-thread hydrate is mandatory, not an
     optimization: every newest-message-direction rule below (pre-dispatch gate, sequence resume) is
     undefined without our outbound turns in the array. `isOutbound` is derived deterministically
     from `labelIds` (the `SENT` label; ADR 0039). For reply.io this
     is the **message-first entry**: the inbox reply list is the workflow's starting signal, and
     the entry gate **a reply in the inbox ⇒ a Media response exists** holds (reply.io `inbox` =
     a thread with ≥1 inbound; ADR 0036). Gmail `INBOX` carries any inbound — **no reply-gate**;
     its only fetch bound is **unread + freshest page** (no date window); irrelevant cold mail and
     machine bounces are dropped downstream at the pre-filter.

   **Fetch bound — two time-gated sources, one ungated.** ClickUp by task **due** date (filter
   above); reply.io by **`lastActivityDate`** (ADR 0036) — both time-gated. Gmail is **not** date-gated:
   it fetches **unread INBOX threads on the freshest page only** (`labelIds:["INBOX","UNREAD"]`, no
   `nextPageToken` loop, ADR 0039), and "already processed" is decided downstream at the join-map
   gate (§3.4), not by a date window. **[MODEL DECISION] All outbound, both boards, rides reply.io**
   (2026-06-22): proactive contact and chasing of silent outlets is reply.io's time-gated sequence
   engine for OKB **and** CKB. Gmail is **inbound-only** (the operator mailbox catching off-sequence
   replies); it never chases — so it needs no date window, only the unread set.
3. **Cleaner script** reads each `inputs/raw/<source>.json` and writes a **separate
   `data/<date>/inputs/clean/<source>.json`** — `raw/` is left untouched as the exact API capture
   (audit/debug; `diff raw clean` shows the transform). Steps:
3.1 **[MODEL DECISION] Three source-specific cleaners, three divergent blob templates** (grill
   2026-06-23). There is **no single unified clean shape**: a **gmail-cleaner**, a **replyio-cleaner**
   and a **clickup-cleaner**, each emitting its **own** structure (`gmail-thread` / `replyio-thread`
   / `clickup-task`). The two thread blobs **diverge by their own structure** — no shared normalized
   core — because the raw shapes and identity models differ (Gmail = MIME walk + base64url +
   per-message id; reply.io = near-clean body + thread-only id + `sequence`; ADR 0035/0036/0039).
   Each cleaner strips control/escape chars + noisy fields; both thread blobs carry a `messages[]`
   sorted **oldest → newest**, each `{ date, from (email only), isOutbound, body, attachments[] }`,
   plus their own thread-level fields (reply.io `{ id, subject, sequence }`, Gmail `{ id, subject }`
   + per-message ids, …). **All identifiers and links stay in the cleaned blob** (thread/task id,
   `sequence`, Drive links, sender) — split-seed and the subagents read them straight from `clean/`.
   Convergence is at the **output**: whatever the source, the messaging context-former writes one
   **unified `<thread_id>.verdict.json`** shape — divergence at the cleaner, convergence at the verdict.
   **[MODEL DECISION] body is the top-post only — strip the quoted tail** (raw-JSON review,
   2026-06-22). Each `text/plain` carries the **entire quoted history** (`____ From: … Sent: …`,
   `On … wrote:`); keeping every body "in full" makes the oldest message appear once per later
   message — quadratic duplication the context-former must re-parse. The `messages[]` array already
   provides prior turns in order, so each `body` keeps only that message's new text. The cleaner
   cuts at the first quote marker (`On … wrote:`, `____`, leading `>` block).
   **[MODEL DECISION] record attachments, don't drop them** (raw-JSON review). Threads carry
   load-bearing attachments (here a `multipart/related` inline PNG screenshot tied to a billing
   change). Drop the MIME wrapper but keep `attachments:[{filename, mimeType, size}]` so the read
   pass knows a file exists — bodies are not downloaded.
   **Dropped:** contact
   `fullName`/`companyName`, `bodyPreview`, `isRead`,
   `channel`, `status`, Gmail `historyId`/`snippet`/all headers except From·Subject·Date, MIME
   wrapper. **ClickUp** has its own shape (board origin, lane, name, comments, due) — ADR 0037.
3.2 Script **Splitter** reads `inputs/clean/` and writes individual JSON items, **routed by source
   into split dirs** (the routing discriminator, ADR 0027): message threads →
   `data/<date>/outputs/emails/<source>/<id>.json` — **[MODEL DECISION] sub-foldered by source**
   (`emails/gmail/`, `emails/replyio/`; grill 2026-06-23) because the blobs now diverge per source
   (§3.1), so the folder also tells the subagent which blob structure it reads; ClickUp tasks →
   `data/<date>/outputs/tasks/<task_id>.json` (ADR 0040). Thread `id` = join key (reply.io integer /
   Gmail hex; `source` + `thread_id` globally unique, ADR 0036 / 0039). The orchestrator routes each
   item to its subagent **by folder**, not by inspecting a per-file field.
3.3 Script writes a **blank `<id>.verdict.json`** alongside each split file. **Threads** —
   `outputs/emails/`, shape per `agents/messaging-subagent/verdict.template.json`; the splitter
   pre-seeds the join keys (`source`, `thread_id`, plus `sequence` for reply.io) **and `media`** —
   `media` is data the splitter extracts from **`raw/`**, **never reasoned by the subagent**.
   **[MODEL DECISION] `media` is a multi-source fallback chain, mined from the data already in
   hand** (raw-JSON review, 2026-06-22; field-mining, 2026-06-22). Outlets reply from **freemail**
   (`goluchas09@gmail.com`, `…@prod.outlook.com`), so the sender domain is `gmail.com`/`outlook.com`
   — not the outlet. There is **no outlet directory and no human handback**:
   the splitter resolves `media` from the source fields it already has, in order —
   1. **reply.io contact fields** (from `raw/`) — the contact's company / non-freemail email domain;
      reply.io already ran the cold sequence to this outlet, so the thread carries its identity;
   2. **a joined card's field** — if the thread hits an existing card in `join-map.json`, reuse that
      entry's stored `media`;
   3. **non-freemail sender domain**;
   4. **outlet token in the subject** (`Articulo goluchas.com …`);
   5. **first published-article URL host in the body**.

   (1) is reply.io-only; (3)–(5) carry Gmail. All are deterministic field/string extraction — no
   reasoning. Only if every source misses does `media` stay `null` (the messaging context-former
   then surfaces it as a gap). For a **ClickUp task** the `media` comes off the task's own fields
   (name / custom field) the same way. **Tasks** — `outputs/tasks/`, shape + pre-seeded fields per
   **ADR 0040** (`agents/clickup-subagent/verdict.template.json`). All other fields stay `null`. No
   halt field — missing fact = `null`; the script infers "missing" from `null` + lane. The subagent
   fills its sidecar in-place; the orchestrator never creates it.
3.4 **[MODEL DECISION] Re-run idempotency — two levels.**
   - **Intra-day (folder contents).** Within a `<date>` dir each stage is a deterministic,
     reusable module keyed off folder contents:
     - `inputs/raw/<source>.json`, `inputs/clean/<source>.json` and the split items
       (`outputs/emails/<id>.json`, `outputs/tasks/<task_id>.json`) are **regenerable** — they hold
       no human/agent work (derived from the source / from `raw/` / from `clean/`), so re-runs
       overwrite them freely.
     - `<id>.verdict.json` is **write-once: created only if absent**, and is **day-scoped** — it
       lives one day and dies with the `<date>` dir. A same-day re-run never clobbers a filled
       verdict.
   - **Cross-day (`join-map.json`).** Because there are no webhooks — every run re-fetches the
     full window — the day folder alone cannot stop yesterday's already-processed threads from
     being re-classified today (the `<date>` dir is fresh). A **permanent `join-map.json` at the
     root of `data/`** (outside any `<date>` dir) carries processed state across days. It is
     **anchored on the ClickUp task** — every conversation attaches to a task — and doubles as the
     message→card join. Shape: the task id keys an entry whose `threads[]` link each thread to that
     card, each thread carrying a **source-aware freshness marker**:

     ```json
     {
       "<clickup_task_id>": {
         "media": "example.com",
         "threads": [
           { "source": "replyio", "thread_id": 12345, "last_activity": "2026-06-20T14:02:00Z" },
           { "source": "gmail",   "thread_id": "a1b2c3", "seen_message_ids": ["msgid1", "msgid2"] }
         ]
       }
     }
     ```

     **[MODEL DECISION] First-run bootstrap.** The builder (`mkdir -p`) creates dirs only — it never
     touches files, consistent with §1's idempotent-builder invariant. On first run `data/join-map.json`
     does not exist; the freshness-gate reader treats a missing file as `{}` (the empty map). No entry
     ⇒ not skipped ⇒ dispatched. The writer creates the file on its first write. The builder is never a
     file creator.

     **Freshness gate — runs early, right after `threads.get`, before clean/split** (decision
       2026-06-22). Hydrating the thread is cheap; cleaning + splitting + classifying it is not, so
       the gate culls already-processed threads **before** they reach the cleaner — only survivors
       are written on to `inputs/clean/` and split. Order at fetch: `list → get → pre-filter
       (bounce) → freshness gate → clean → split → seed`.
     **[MODEL DECISION] The gate key is the message marker, NOT the card's status** (2026-06-22).
       A `complete` deal that gets a **fresh** reply (outlet reopens) carries a new message the
       marker hasn't seen ⇒ it is **kept and dispatched** — never lose a live negotiation. Card
       status answers "is the deal closed", a different question from "is there new content to
       classify"; status never gates the fetch.
     - **reply.io** — no message id (ADR 0036) ⇒ compare the inbound `lastActivityDate` against the
       stored `last_activity`. Not newer ⇒ **skip** (no new reply); newer ⇒ dispatch + bump the
       marker. This is option A: a new reply in a seen thread re-triggers classification.
     - **Gmail** — per-message id (ADR 0039) ⇒ newest message id already in `seen_message_ids` ⇒
       **skip**; else dispatch + append the id.
     - **No entry (first-touch)** ⇒ never skipped ⇒ **kept and dispatched** (new lead; card is
       created downstream, §below). Marker bump is **post-success**, at-least-once / crash-safe.

     **First-touch write path.** On the first reply from a new outlet no card exists yet, so the
     thread is absent from `join-map.json` ⇒ not skipped ⇒ dispatched. The create-if-not-exists
     script (serial resolver, below) **creates the ClickUp task and returns its id**; the
     `join-map.json` writer receives that id and writes the entry. The map only ever records a
     thread once its card id is known.

## Reasoning pipeline — 3 tiers (ORC = deterministic spine)

**[MODEL DECISION] ORC is a deterministic spine script, not a Claude brain** (grill 2026-06-21).
It owns sequencing, effects, and chaining — spawns the subagents in order, regulates the
parallel/async hand-off by readiness — and does **no reasoning**. All reasoning lives in named
subagents across three tiers, then a deterministic executor. The flow is **streaming**: each item
moves the instant its inputs are ready; there is **no global "wait for every verdict" barrier**.
"Wait on X" everywhere below means **wait on a field fill** (e.g. `label != null`), not on file
existence — the splitter already created the blank seeded `<id>.verdict.json` (§3.3, write-once;
subagents only ever fill).

### Pre-dispatch gate — deterministic, off the newest message (script, no subagent)

Before any fan-out the script branches on each thread's newest message:
1. **newest `isOutbound:false`** (last message is a Media reply) ⇒ **enter the pipeline** — the
   actionable case.
2. **newest `isOutbound:true`** (last message is ours) AND **stale past the sequence's wait window**
   (no reply) AND the sequence has a next step ⇒ **resume the sequence at the next step** (re-enrol
   per ADR 0036). No subagent, no verdict. The staleness threshold is the sequence's own wait, not a
   hardcoded "= today − 2 days".
3. **sequence steps exhausted** (no next step) ⇒ **do nothing.**

Branches 2–3 are **reply.io-only** — sequences (and therefore all outbound chasing, both boards)
exist only there. A Gmail thread has no sequence and Gmail never chases: an unread Gmail thread by
definition carries a new inbound ⇒ **enter**; an outbound-newest Gmail thread is not unread, so the
unread fetch never surfaces it — there is nothing to do.

**Pre-filter (script).** Deterministic bounce — `mailer-daemon@` / `postmaster@` sender — is
killed here, before Tier 1, never spawns. Softer auto-replies ("out of office", "automatic reply",
unsubscribe) are caught at Tier 1 (haiku emits `label:"other"`, which ends that chain).

**Routing — by folder (ADR 0027 / 0040).** `outputs/emails/<id>.json` → messaging branch;
`outputs/tasks/<task_id>.json` → ClickUp branch (board from the task's `board` field: `"okb"` /
`"ckb"`). No per-file field inspection.

### Tier 1 — classify (haiku, threads only)

One cheap **haiku** subagent per thread, given its split-file path. Job = **`label` only**
(`outreach` / `content` / `other`) → written into `<thread_id>.verdict.json`. No reasoning, no
coverage — those are Tier 2's. ClickUp tasks **skip Tier 1**: the board is already known from the
folder. Labels (defined here and nowhere else):
- `outreach` — deal-making with an outlet: terms, pricing, payment, package discounts, ordering.
- `content` — article submission, publication acknowledgement, publication link, revisions.
- `other` — neither; ends the chain.
- **[MODEL DECISION] Label the newest actionable turn, not the thread's lifetime** (raw-JSON
  review, 2026-06-22). A thread legitimately spans both — the Goluchas thread runs article-delivery
  → publication-link (`content`) → invoice → correction → payment-confirm (`outreach`) in five
  messages, so a thread-lifetime label is undefined. Classify the action the **newest inbound**
  demands now (here "Listo + paypal link" = payment = `outreach`) — consistent with the
  pre-dispatch gate, which already keys off the newest message.

### Tier 2 — context-formers (sonnet, per source, parallel, symmetric)

Each context-former reduces one **clean blob** to a compact, truthful context written into that
item's `verdict.json`. Two of them, **always both run** — symmetric by design:
- **messaging context-former** — thread clean-blob → context + **Defined-Question facts**
  extracted from the text → `<thread_id>.verdict.json` (SOP `outreach-read-label` |
  `content-read-label` by `label`).
- **clickup context-former** — task clean-blob → [[Status Verdict]] context → `<task_id>.verdict.json`
  (per ADR 0037 OKB / 0038 CKB).

**[MODEL DECISION] No lazy-ClickUp asymmetry** (grill 2026-06-21). A standalone task's *only*
context is its card, and the reconciler must read a **formed** context, never a raw blob — so
ClickUp always gets a context-former too. The [[Status Verdict]] producer is **this context-former**,
not a separate "ClickUp subagent".

### join-map grouping — deterministic pre-join (script); the reconciler places the rest

Between Tier 2 and Tier 3 a **serial resolver** does only the **unambiguous** joins, **via seeded
keys / `join-map.json`, never a live board scan**:
- **Content — Drive fileId.** A thread carrying a `drive_file_id` (seeded §3.3) joins to the card
  whose seeded `drive_file_id` is **identical** — a **card-unique** key, so the match is exact.
  **[MODEL DECISION] 2026-06-23:** every email carries a Drive link and every Content card carries
  the same article doc, so the fileId is the deterministic content join.
- **Known thread (any source).** join-map hit ⇒ use the stored `clickup_task_id`.

Everything the resolver **cannot** place deterministically — a `media` that maps to several cards,
orphan threads with no match — is **left for the reconciler** (Tier 3, the global collector), which
sees all contexts at once and decides attribution.

**[MODEL DECISION] Card creation is outreach-only** (2026-06-23). A first-touch **outreach** thread
with no map entry becomes a new card in **Negotiation**. **Content never creates a card** — content
cards are teammate-owned upstream (ADR 0038); an unmatched content thread is simply left without
action, never turned into a card.

**[MODEL DECISION] Reasoning proposes, the script commits** (grill 2026-06-23). The reconciler emits
the attribution it resolved (thread → card, or "create outreach card") as a *judgment*; a downstream
**serial commit script** — **sole writer to `join-map.json`** — does the create-if-not-exists,
records the link, and **bumps freshness post-success** (at-least-once, crash-safe). One sequential
queue closes two async races: duplicate cards for the same outlet, and concurrent join-map writes.
join-map write moments: (A) at split, self-seed each ClickUp entry (`task_id` known) with `media`,
`drive_file_id` + `paths`, an out-of-window-safe index; (B) post-reconciler, commit links/creations
+ bump freshness.

### Tier 3 — reconciler (opus, global collector, source-agnostic)

**[MODEL DECISION] The reconciler runs on opus** (2026-06-24). The tiers escalate by judgment
difficulty: haiku (label) → sonnet (per-source context) → **opus (cross-source reconcile)**. The
reconciler is the only tier that weighs *every* context against *every other* and emits the
booleans the executor acts on; the hardest judgment gets the strongest model. It is the lone opus
call per card.

**[MODEL DECISION] The reconciler is a global collector, not a per-card reasoner** (grill
2026-06-23 — corrects the "per-card" framing of 2026-06-21). It ingests **every** formed context in
the day — **all** cards' `<task_id>.verdict.json` **and all** threads' `<thread_id>.verdict.json` —
and **never** raw blobs or the lane directly. Seeing the whole picture at once it decides two things:
(a) **where the signal is truthful** — attributing each thread's signal to a card and resolving
conflicts between contexts; this is where the threads the deterministic resolver could **not** join
(ambiguous `media`, orphans) get placed; (b) the **transition `signals`** per card. Reasoning is
**global**; output is **per-card** — `truthful_signal` (NL judgment) + a `signals{}` block of named
booleans + `blocked` to a **new artifact `<task_id>.reconcile-verdict.json`** per card. **Coverage
split:** Defined-Question *facts* are extracted by the messaging context-former (it has the text);
**completeness + status-implication + the `gap → Negotiation` rule** are decided **here**.

**[MODEL DECISION] The reconciler emits booleans, the executor owns the transition table**
(2026-06-24). The "leaves the lane when" condition of every lane (ADR 0037 OKB / 0038 CKB) is reduced
to a **named boolean the reconciler asserts** — the part that needs reading NL ("are all Defined
Questions covered?", "is this a positive go?", "does the reply carry a published-article link?").
The reconciler does **not** emit a `target_lane`: the boolean→lane→reply.io-step mapping is a
deterministic table the **executor** holds (below), so lane logic never leaks into reasoning. Per
board the reconciler fills only the relevant booleans; the rest stay `null`. Halt-never-guess is a
**separate `blocked` boolean** (+ `block_reason`): a `false` signal means "condition not met, don't
move"; `blocked:true` means "a required fact is missing — flag the operator", a distinct state from
"not ready to move". The `signals` schema + per-board boolean tables live in ADR 0037 / 0038; the
shape:

```jsonc
{
  "board": "okb" | "ckb",
  "task_id": "...",
  "truthful_signal": "<NL compressed truth — audit, not parsed by the executor>",
  "signals": { /* board-scoped booleans, ADR 0037/0038; unused = null */ },
  "blocked": false,
  "block_reason": null,
  "dry_run": [ /* executor writes one rendered stub intent-string per Action, ADR 0042; [] until it runs */ ]
}
```
**OKB signals (3):** `defined_questions_complete`, `payment_details_received`,
`payment_evidence_found` — `payment_terms` / `package_size` / go-no-go are **not** signals (no lane
gates them). **CKB signals:** `publication_submitted`, `published_link_present`,
`corrections_present`, `corrections_cleared`. Canonical `current_lane` values: OKB
`To Contact | Contacted | Negotiation | Completed | Invoice Request | To Pay`; CKB
`To Submit | Publication | Publication Revision | Completed`.

**[MODEL DECISION] It proposes, it does not write** (2026-06-23): attribution is a *judgment* in the
verdict; a downstream script commits the join-map link / card creation — reasoning never writes
effects (§join-map grouping). **Readiness — the single convergence point:** the reconciler waits on
**every** Tier-2 context (all cards + all threads). The streaming fan-out converges here, and only
here.

### write (sonnet, per-thread)

The writer reads `<task_id>.reconcile-verdict.json` (the `signals`) + its own
`<thread_id>.verdict.json`, and drafts the outlet-facing follow-up into that verdict's `draft`
field (SOP `outreach-comms` | `content-comms`) whenever a signal calls for an outlet-facing send
(OKB `defined_questions_complete:false` → chase the gap; CKB `corrections_present:true` → relay the
fix). It **does not re-read the thread** — the context-former already packed everything the draft
needs; if drafts come out thin, enrich the context, never re-read. No signal requiring a reply ⇒ no
draft.

### Execution — deterministic, behind the gate (script)

A deterministic script consumes `reconcile-verdict.json`'s `signals` (the booleans) + the card blob
and executes the ClickUp lane move / status write + the reply.io step (enrol / re-enrol / send /
none). It owns the **transition table** — `(current_lane, signals) → (lane move, reply.io step)`,
defined per board in ADR 0037 / 0038 — a **data comparison**, **not** reasoning; it never parses
`truthful_signal`. Gmail is inbound-only, so it is never a send target. `blocked:true` ⇒ execute
nothing, flag the operator. Per the **write ladder** (ADR 0037): internal reasoning-comments post
freely; status + assignee moves and outlet sends ride the [[Approval Gate]]. The subagents never
write back to ClickUp.

## Artifact model

- **context-formers → `*.verdict.json`** (per-item judgment); **reconciler →
  `*.reconcile-verdict.json`** (cross-source reconcile). Distinct names so per-item verdict and
  cross-source reconcile never confuse.
- **per thread:** `<thread_id>.verdict.json` — `label` + context + Defined-Question facts, then the
  `draft`.
- **per card:** `<task_id>.verdict.json` (clickup context / [[Status Verdict]]) +
  `<task_id>.reconcile-verdict.json` (`truthful_signal` + `signals{}` booleans + `blocked`).
- **Lifecycle:** the splitter creates the blank seeded `<id>.verdict.json` 1:1 with `<id>.json`
  (write-once; §3.3); subagents only **fill** it. The reconciler **creates**
  `<task_id>.reconcile-verdict.json`.

**Chain (all streaming, no barrier):**
`fetch (list → get) → [script] pre-filter (bounce) → freshness gate (seen/first-touch) → clean →
split → seed verdict → [script] pre-dispatch gate → haiku(label) ∥
clickup-context(tasks) → messaging-context → [script serial resolver: media→task_id, card
create + join-map] → reconciler(card) [waits on card-context + all matching thread-contexts]
→ write → [script] gated execution`.

**Resume granularity (re-run):** skip classify if `label != null` → skip context-former if its
context/`reasoning != null` → skip reconciler if `truthful_signal != null` → skip write if
`draft != null`. Type counts are post-hoc observability ([[Execution Report]]), never a gate.

## Resolved — script-wiring gaps (2026-06-21 review)

Six gaps found tracing the deterministic spine (lens: **every LLM module must find its write-target
file on disk before dispatch**), now closed inline / in sibling ADRs:
1. **ClickUp verdict write target** → ADR 0040 (`<task_id>.verdict.json` sidecar + template; splitter seeds, §3.2/§3.3).
2. **ClickUp dispatch in spine** → Tier 2 clickup context-former + the deterministic executor (above).
3. **Thread vs task discrimination** → split dirs `outputs/emails/` vs `outputs/tasks/` (ADR 0027; §3.2 routing-by-folder).
4. **`join-map.json` first-run bootstrap** → §3.4 (reader treats absent file as `{}`).
5. **Write-pass context** → the writer reads `<task_id>.reconcile-verdict.json` + its own verdict
   (no live re-read, no separate `card.json` scratch).
6. **Locate-by-`media` vs join-map id** → serial resolver (known-thread uses stored id; board search first-touch only).

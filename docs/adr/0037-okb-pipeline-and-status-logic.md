# ADR 0037 — OKB: pipeline, statuses, and status-move logic

- **Status:** Accepted
- **Date:** 2026-06-19 (revised 2026-06-24)
- **Context grill:** /grill-with-docs — OKB message-first spine (reply.io entry)
- The single OKB artifact: CONTEXT keeps only the general **[[Status]]** term; every OKB lane
  name, per-lane action, and transition rule lives here.

**[REVISION 2026-06-24] Negotiation now auto-completes; no go/no-go wait.** When every Defined
Question is covered the agent moves the card to **Completed** — it no longer stops in Negotiation
waiting for a creator decision. The creator's "go" is expressed out-of-band as **SEO creating an
Invoice Request task**; the system never creates that task itself. Nothing is waited on.
`creator_go_nogo` and `package_size_known` are **dropped from `signals`**. `reassign` is
**deprecated** — Invoice Request / To Pay tasks already arrive assigned to Danylo. The remaining
signals are three: `defined_questions_complete`, `payment_details_received`, `payment_evidence_found`.

## The board

[[OKB]] — acquiring + paying a [[Media Outlet]]; deal-making and onboarding only. An outlet's
deal closes here before any of its [[Affiliate Article]]s appear on the [[CKB]].

## Entry is message-first (reply.io)

The board is driven from the **reply.io reply list**, not from a ClickUp scan. This **inverts ADR
0034's board-first entry for OKB** specifically. Fetch scope: `source:"inbox"` bounded by a
`lastActivityDate` window (per ADR 0036). A reply in the inbox ⇒ a Media response exists
(deterministic).

The **pipeline mechanics are not restated here.** The 3-tier reasoning spine (classify →
context-formers → reconciler → write → deterministic execution) and its `verdict.json` /
`reconcile-verdict.json` artifacts live in ADR 0034; the ClickUp verdict shape in ADR 0040. This
ADR owns only what is OKB-specific: the lanes, the per-reply reasoning, the status-check rule, and
the write ladder.

Idempotency is **thread-keyed**: the reply.io thread `id` plus its `lastActivityDate` freshness
marker — the `join-map.json` mechanism (ADR 0034 §3.4 / ADR 0036), not a separate store.

The **deterministic script** owns the ClickUp OKB `Status` / lane move — no subagent writes a
ClickUp status. Reply.io API facts: ADR 0036.

## The five lanes

The full pipeline, in order; no lane out of scope. A lane's definition = the agent's action in
it + the signal that moves a card out.

| Lane | Agent action | Leaves the lane when |
|---|---|---|
| **To Contact** | none to the outlet — a handoff: Danylo sends the import, Alina runs the cold sequence; reassign the task to Alina. | the cold sequence starts. |
| **Contacted** | none — Reply.io runs the automated follow-up; the task waits on a Media response. | the outlet replies. |
| **Negotiation** | active loop: on each reply, reason over it, check against the [[Defined Questions]], draft a follow-up chasing whichever remain. | every Defined Question is covered — the agent moves the card to **Completed** (no go/no-go wait). |
| **Invoice Request** | **entered externally** — SEO creates the task (the system never creates it); it arrives assigned to Danylo. Agent action: send the invoice-request email — a **fixed template, script-sent** (no subagent). | the outlet returns payment details → move To Pay. |
| **To Pay** | reason over the reply, find the payment evidence, post a comment pasting it + tag Alina. **Terminal for the agent** — it stops here. (A separate out-of-flow script marks paid tickets Completed.) | — (agent stops). |

**The agent auto-completes Negotiation but never creates an Invoice Request.** When the Defined
Questions are all covered it moves the card to **Completed** and stops. It never advances
Negotiation → Invoice Request on its own — that lane is entered only by an externally-created SEO
task. (Supersedes the former "always stops in Negotiation / waits for go-no-go" rule; the `Result`
lane was already removed.)

## What the subagent reasons (per reply)

Two reasoning areas — **NL-only**; everything structured (which assignee, which template, the
lane logic) is mechanical and done by the script.

1. **Defined-Question coverage.** The *facts* answering the [[Defined Questions]] are extracted by
   the messaging context-former (it has the thread text); **completeness** — are all answered? — is
   judged by the reconciler (ADR 0034 Tier 3). A gap keeps the card in Negotiation and drives the
   follow-up draft.
2. **Decision-data extraction** — narrowed (2026-06-24). Package size + go/no-go are **no longer
   agent-gated** (go = an externally-created SEO Invoice Request task), so the agent does not gate
   on them. What it still extracts from free text: **payment details** and **payment evidence** for
   the Invoice Request / To Pay lanes. Halt-never-guess: a missing required fact halts and is
   flagged (the `blocked` boolean), never fabricated.

**The status check is NOT subagent reasoning.** ClickUp returns the card as a structured JSON
blob, so comparing the reply's implied status against the current lane is a data comparison the
**deterministic executor** does over the card blob + the reconciler's `next_step` (ADR 0034
Execution) — then it executes the move.

## Transition signals — the reconciler's booleans (ADR 0034 Tier 3)

The "leaves the lane when" column above is reduced to **named signals the reconciler asserts** into
`<task_id>.reconcile-verdict.json` `signals{}`. The reconciler judges (NL → signal); the
deterministic **executor** owns the table that maps `(current_lane, signals) → (lane move, reply.io
step)`. The reconciler emits no `target_lane`. Names are **canonical** — aligned to the lane
vocabulary above and the `decision_data` keys of ADR 0040. Unused = `null`.

| Signal | Type | What the reconciler judges |
|---|---|---|
| `defined_questions_complete` | bool | every Defined Question is answered across the thread context |
| `payment_details_received` | bool | the outlet returned payment details |
| `payment_evidence_found` | bool | payment evidence is present in the reply |

Three signals (revised 2026-06-24). `creator_go_nogo`, `package_size_known`, and `payment_terms`
are **not transition signals** — go/no-go + package size are no longer agent-gated, and
`payment_terms` gates no lane. Halt-never-guess is the separate `blocked` boolean (+ `block_reason`);
a `null` signal means "not yet known", never guessed.

**Executor table** (deterministic; lane logic lives here, not in the reasoning):

```
Negotiation:
  !defined_questions_complete   → reply.io: send follow-up draft (gated)
  defined_questions_complete    → move Completed
Invoice Request:                 (entered externally by SEO; no reassign)
  !payment_details_received     → reply.io: send invoice-request template (gated)
  payment_details_received      → move To Pay
To Pay:
  payment_evidence_found        → comment+paste evidence + tag Alina  [TERMINAL — agent stops]
any lane: blocked               → execute nothing; flag operator
```

To Contact → Contacted (cold sequence starts) and Contacted → Negotiation (a reply exists) are **not
reconciler signals** — the first is a manual/handoff move, the second is detected deterministically by
the freshness/pre-dispatch gate. The reconciler's signals start at **Negotiation**.

## The write ladder

Three tiers of ClickUp/outlet write, by reversibility and outward-facing-ness:

1. **Internal reasoning-comment → free write.** Auto-posted, no gate. Internal-only and
   reversible; gating these would drown the operator.
2. **Status move + assignee change → gated together.** They ride the *same* rung and move as one
   action (most lanes flip both), behind the [[Approval Gate]].
3. **Outlet-facing send → gated.** The Negotiation follow-up and the Invoice Request email —
   localized and reviewed.

## Consequences

- **One OKB artifact.** Lane vocabulary + transition logic live here; CONTEXT holds only the
  general [[Status]] term and the [[OKB]] board term. No other doc restates the lanes.
- **Message-first.** A reply.io reply is the trigger; idempotency is thread-keyed (ADR 0036). No
  reply ⇒ no work for that card.
- **The agent auto-completes Negotiation** (Defined Questions covered → Completed) but never creates
  an Invoice Request; that lane is entered only by an external SEO task.
- **The operator reviews actions, not thoughts.** Reasoning-comments post freely; only status/
  assignee moves and outlet sends hit the gate.

## Open gaps — resolved 2026-06-24

- **Negotiation terminal = Completed.** Defined Questions covered → move Completed (no go/no-go).
- **To Pay terminal = agent stops.** `payment_evidence_found` → comment + tag Alina, then the agent
  stops. Marking the ticket paid/Completed is a separate out-of-flow script, off the agent surface.
- **`payment_terms`** stays `decision_data` only (0040), gates no lane — not a gap, by design.

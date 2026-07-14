# ADR 0038 — CKB: pipeline, statuses, and status-move logic

- **Status:** Accepted
- **Date:** 2026-06-20
- The single CKB artifact: CONTEXT keeps only the general **[[Status]]**
  term and the **[[CKB]]** board term; every CKB lane name, per-lane action, and transition rule
  lives here.

## The board

[[CKB]] — tracks [[Affiliate Article]] placements + QA with an already-onboarded [[Media Outlet]].
An article appears here only after its outlet's deal closed on the [[OKB]]. The board has ten
lanes; the agent acts on **only the downstream three** — upstream six (backlog, TR preparation,
prepare content, prepare images, check content, SEO check) are teammate-owned and outside the
agent's surface. The agent fetches these lanes for one assignee — **Danylo Drachov**; this fetch
assignee is distinct from any status→owner move-reasoning set.

## The three agent-surface lanes

| Lane | Agent action | Leaves the lane when |
|---|---|---|
| **To Submit** | outlet-facing **placement** = **enrol the contact into the 0041 content sequence at Step 1** (gated). Nothing sent yet at entry; the content is a **Google Drive folder link** on the task. Template, script-filled (`customFields`: drive folder id + `article_title`) — no agent draft. | the placement is submitted → move Publication. |
| **Publication** | **handoff to Reply.io** (re-enrol Step 2 chase) while the card waits for the publication link. On link present → **verification flow is out of scope (0041)**; the agent stops and flags the operator. | the outlet returns the publication link (then handoff). |
| **Publication Revision** | read QA findings left as comments by the QA agent, then **submit correction requests** via Reply.io Step 3 (gated). Loops until cleared; on clear → Step 4 thank-you + move Completed + comment. | all corrections cleared → move Completed. |

Only two lanes are outlet-facing: **To Submit** (placement) and **Publication Revision**
(corrections). **Publication** is a handoff / wait only — no outlet contact, no agent reasoning.

**[MODEL DECISION] All CKB outbound rides Reply.io** (2026-06-22). The two outlet-facing sends —
To Submit placement and Publication Revision corrections — go out **through Reply.io**, the same
channel as the Publication-lane chase. Reply.io is the single outbound channel for **both** boards
(OKB + CKB); Gmail is inbound-only (ADR 0034 §2). The agent drafts behind the [[Approval Gate]];
Reply.io delivers and time-gates the follow-up.

## Entry condition

A card enters the agent's surface at **To Submit**: the SEO checker has tagged the operator
("контент готов до публікації") and the final text doc is posted; the task is reassigned to the
operator. The agent never QA-checks — QA runs elsewhere and lands as comments; the agent only
reads those comments and relays them as a correction request.

## Transition signals — the reconciler's booleans (ADR 0034 Tier 3)

The "leaves the lane when" column is reduced to **named booleans the reconciler asserts** into
`<task_id>.reconcile-verdict.json` `signals{}`. The reconciler judges (NL → bool); the deterministic
**executor** owns the `(current_lane, signals) → (lane move, reply.io step)` table and emits the
send. The reconciler emits no `target_lane`. Unused booleans = `null`; halt = separate `blocked`.

| Signal (bool) | What the reconciler judges |
|---|---|
| `publication_submitted` | the placement was submitted to the outlet (our SENT placement is in the thread) |
| `published_link_present` | the reply carries a published-article link |
| `corrections_present` | QA comments contain unresolved correction requests |
| `corrections_cleared` | every correction is acknowledged as fixed |

**Executor table** (deterministic):

```
To Submit:
  !publication_submitted           → reply.io: enrol Step 1 placement (template; gated)
  publication_submitted            → move Publication
Publication:
  !published_link_present          → reply.io: re-enrol Step 2 (chase, ADR 0041; gated)
  published_link_present           → handoff: verification flow out of scope (0041);
                                       agent stops + flag operator
Publication Revision:
  corrections_present              → reply.io: re-enrol Step 3 corrections (gated)
  corrections_cleared              → reply.io Step 4 thank-you (template) + move Completed + comment
any lane: blocked                  → execute nothing; flag operator
```

All sends ride reply.io; Gmail is inbound-only and never a send target (ADR 0034).

## Consequences

- **One CKB artifact.** Lane vocabulary + transition logic live here; CONTEXT holds only the
  general [[Status]] term and the [[CKB]] board term. No other doc restates the lanes.
- **Agent never QA-checks.** It reads QA comment output and relays; judgment is concentrated on
  reading the free-text comment thread (mirrors OKB reasoning, ADR 0037).
- **Two outlet-facing lanes, one wait lane.** Gate applies to To Submit and Publication Revision;
  Publication is a silent Reply.io handoff.

## Open gaps — resolved 2026-06-24

- **Publication success.** `published_link_present:true` → verification flow is **out of scope
  (0041)**; the agent stops and flags the operator. No agent terminal move here.
- **Publication Revision terminal = Completed.** `corrections_cleared:true` → Reply.io Step 4
  thank-you (template) + move **Completed** + ClickUp comment.

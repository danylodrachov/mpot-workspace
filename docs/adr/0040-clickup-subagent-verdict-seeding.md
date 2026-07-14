# ADR 0040 — ClickUp subagent verdict: shape, sidecar, and splitter seeding

- **Status:** Accepted
- **Date:** 2026-06-21
- **Context grill:** resolves ADR 0034 "Open gaps" item 1 — ClickUp subagent has no pre-seeded write target

Every LLM module must find its write-target file on disk before dispatch (ADR 0034 dispatch-readiness gate). The [[messaging-subagent]] satisfies this via `<id>.verdict.json` seeded from `agents/messaging-subagent/verdict.template.json`. The ClickUp subagent (×2 — one per board) had no equivalent. This ADR closes that gap for **both** boards; it is cross-board by design.

## Decision

**[MODEL DECISION] Sidecar, not in-place.** The ClickUp subagent writes a `<task_id>.verdict.json` sidecar alongside the task's split file in `data/<date>/outputs/tasks/` — it does **not** mutate the source task JSON (`<task_id>.json`). Mirrors the messaging-subagent pattern exactly: source file is read-only, sidecar is the write target.

**[MODEL DECISION] Separate `outputs/tasks/` folder.** ClickUp task items are split into `data/<date>/outputs/tasks/<task_id>.json` (not the threads folder). This is the discriminator that routes each item to the right subagent type — message threads go to `outputs/emails/` (ADR 0027), ClickUp tasks go to `outputs/tasks/`. Resolves ADR 0034 gap 3 ("thread vs task not discriminated") as a side effect.

## Splitter seeding (mirrors ADR 0034 §3.3)

The splitter, after writing each `outputs/tasks/<task_id>.json`, writes a **blank `<task_id>.verdict.json`** alongside it — **created only if absent** (write-once, same intra-day idempotency rule as messaging sidecars).

Pre-seeded fields (deterministic, extracted from the task JSON by the splitter — never reasoned):
- `board` — `"okb"` or `"ckb"` (from the task's board origin field in `inputs/clean/clickup.json`)
- `task_id` — ClickUp task id
- `task_name` — task name string
- `current_lane` — current ClickUp status at fetch time

All other fields stay `null`. Template: `agents/clickup-subagent/verdict.template.json`.

## Verdict shape

```json
{
  "board": null,
  "task_id": null,
  "task_name": null,
  "current_lane": null,
  "decision_data": {
    "package_size": null,
    "payment_terms": null,
    "correction_items": null
  },
  "reasoning": null
}
```

Field semantics:
- `board` — `"okb"` | `"ckb"` (splitter-seeded)
- `task_id` — ClickUp task id (splitter-seeded)
- `task_name` — task name (splitter-seeded)
- `current_lane` — lane at fetch time (splitter-seeded)
- `decision_data.package_size` — OKB only; article count + per-item price extracted from comments
- `decision_data.payment_terms` — OKB only; payment terms extracted from comments
- `decision_data.correction_items` — CKB only; list of correction items from QA comments
- `reasoning` — NL compressed-truth reasoning; board-appropriate (OKB: [[Defined Questions]] coverage + gap; CKB: correction list summary)

`decision_data.package_size` is consumed by the OKB invoice-request template — `buildInvoiceRequestEmail`
interpolates the article count (ADR 0042). `creator_go_nogo` was **removed (2026-06-24)**: no signal or
template consumes it (go = an externally-created SEO Invoice Request task, ADR 0037).

**[MODEL DECISION] `decision_data` fields are board-scoped.** OKB-irrelevant fields (`correction_items`) stay `null` for OKB tasks; CKB-irrelevant fields (`package_size`, `payment_terms`) stay `null` for CKB tasks. One template, two boards — unused fields are null, not absent.

**[MODEL DECISION] No next-action field — this verdict is a single-source observation, not a transition (0034 3-tier, 2026-06-22).** The clickup context-former (Tier 2) sees only the card; it records what the card shows (`decision_data` + `current_lane` + `reasoning`), not where to move it. Deciding the next step requires weighing this Status Verdict against the matching threads' verdicts — a cross-source judgment only the [[reconciler]] (Tier 3) can make. The status-implication compute and the transition `signals{}` (board-scoped booleans the executor reads) live in `<task_id>.reconcile-verdict.json`, never here.

## ClickUp subagent fill (in-place)

The ClickUp subagent (dispatched once per `outputs/tasks/<task_id>.json`) fills the sidecar in-place:
1. Reads `<task_id>.json` (the task blob — board, lane, comments, due date)
2. Reads the pre-seeded `<task_id>.verdict.json`
3. Writes `decision_data` (board-appropriate fields only) and `reasoning` into the sidecar

The subagent never writes to `<task_id>.json`. The lane move is **not** read off this verdict — the reconciler's `<task_id>.reconcile-verdict.json` carries the transition `signals{}` booleans, and the deterministic executor maps them to the lane move + reply.io step under the same write-ladder gate as ADR 0037.

## Dispatch readiness gate (extends ADR 0034)

The orchestrator fans out the ClickUp subagents only after **every** `outputs/tasks/<task_id>.json` has a sibling `<task_id>.verdict.json`. Per-task resume on re-run: skip dispatch where `reasoning` is already non-null.

## Consequences

- Closes ADR 0034 open gap 1 (ClickUp subagent write target) and gap 3 (thread/task discriminator) as a pair.
- `outputs/emails/` = messaging threads only; `outputs/tasks/` = ClickUp tasks only. Routing is folder-based, no per-file field inspection needed.
- The single template covers both boards; board-scoped nulls keep the shape minimal.
- ADR 0037 and 0038 remain authoritative for their board's lane logic and write-ladder rules — this ADR owns only the verdict shape and seeding mechanics.

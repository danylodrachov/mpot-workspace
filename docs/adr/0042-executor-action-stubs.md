# ADR 0042 — Executor: action model + dry-run stubs

- **Status:** Accepted
- **Date:** 2026-06-24
- Owns the deterministic execution layer that runs **after** Tier-3 writes
  `<task_id>.reconcile-verdict.json` (ADR 0034 Execution). The lane logic itself lives in 0037
  (OKB) / 0038 (CKB); this ADR owns the **shape of the executor** and how it is built first as
  inert stubs.

## The boundary

The executor is pure deterministic code — no reasoning. It consumes the reconciler's `signals{}`
booleans + `current_lane` and runs the 0037/0038 transition tables. It is split in two halves that
never blur:

1. **Resolver (pure):** `(current_lane, signals) → Action[]`. No I/O. This is the 0037/0038 tables
   as code. A gating signal that is `null` ("not yet known") → `flag_operator`, never guessed.
2. **Effects:** the only functions that touch ClickUp / Reply.io / the operator surface. One per
   write-ladder rung (0037 §write ladder).

## Stubs first (dry-run)

The effects layer ships first as **stubs that perform no real action** — each renders its `Action`
to an **intent string** and returns it (e.g. `[CLICKUP] move T-123 → Completed (gated)`,
`[REPLY.IO] enrol Step 1: placement … (gated)`). Real API calls drop in later behind the same
signatures; the resolver and its tests never change.

## The Action model

The resolver emits a declarative `Action[]` — a description of intended effects, not the effects:

- `lane_move { to, gated:true }` — ClickUp status move. `reassign` is **dropped** (deprecated;
  tasks arrive assigned correctly).
- `comment { body, tag?, gated:false }` — free internal ClickUp comment (ladder rung 1).
- `replyio { op: enrol｜re_enrol｜send｜none, note, stepId?, removeFromExisting?, gated:true }` —
  outlet-facing send, always Reply.io (Gmail inbound-only). Template-filled by a helper.
- `flag_operator { reason }` — `blocked`, an unknown gating signal, or an out-of-scope handoff.

## Helpers (deterministic)

- `readReconcileVerdict(task_id)` → the verdict blob.
- `buildInvoiceRequestEmail(packageSize)` → OKB invoice-request template string. **Not static** —
  interpolates the article count from `decision_data.package_size` (0040); no subagent.
- 0041 drive-folder extractor + `customFields` builder (`article_draft_url` folder id +
  `article_title`) for the CKB To Submit enrol.

## Transition tables (authoritative copies in 0037/0038)

```
OKB                                            CKB
Negotiation                                    To Submit
  !defined_questions_complete → replyio send     !publication_submitted → replyio enrol Step1
  defined_questions_complete  → move Completed   publication_submitted  → move Publication
Invoice Request (external SEO task)            Publication
  !payment_details_received → replyio send        !published_link_present → replyio re_enrol Step2
  payment_details_received  → move To Pay         published_link_present  → flag_operator (verif. OOS)
To Pay                                         Publication Revision
  payment_evidence_found → comment+tag Alina      corrections_present → replyio re_enrol Step3
                           [TERMINAL]             corrections_cleared → replyio Step4 + Completed + comment
any: blocked → flag_operator                   any: blocked → flag_operator
```

## dry_run trail on the verdict

The reconcile-verdict carries a **`dry_run: string[]`** field. After the resolver produces `Action[]`,
the stub effects render each Action to its intent string and the executor writes them back into the
card's `<task_id>.reconcile-verdict.json` `dry_run[]` — one entry per Action. This is the auditable
record of a no-effect run: the verdict shows exactly what would have fired. Empty until the executor
runs; real effects later append nothing here (they act).

## Consequences

- **Resolver is fully testable now** — pure function over `(lane, signals)`, no network.
- **Stubs are inert** — a full run prints its intended effects and changes nothing, so the
  transition tables can be verified against real verdicts before any API is wired.
- **No terminal gaps remain** (resolved in 0037/0038): OKB To Pay = agent stops; CKB Publication =
  out-of-scope handoff; CKB Publication Revision clear = Completed.
- **Files:** `src/orchestrator/executor/{types,resolve,effects}.ts` (only types.ts written so far).

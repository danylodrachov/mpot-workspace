/**
 * types.ts — executor data shapes (ADR 0034 Execution, post reconcile-verdict).
 *
 * The executor is the deterministic spine that runs AFTER Tier-3 reconciler writes
 * `<task_id>.reconcile-verdict.json`. It owns the (lane, signals) -> (move, reply.io step)
 * tables of ADR 0037 (OKB) / 0038 (CKB). No reasoning lives here.
 */

export type Board = 'okb' | 'ckb';

export type OkbLane =
  | 'To Contact'
  | 'Contacted'
  | 'Negotiation'
  | 'Completed'
  | 'Invoice Request'
  | 'To Pay';
export type CkbLane = 'To Submit' | 'Publication' | 'Publication Revision' | 'Completed';
export type Lane = OkbLane | CkbLane;

/**
 * OKB reconciler booleans (ADR 0037, revised 2026-06-24). Unused = null.
 * Flow change: Negotiation completion -> Completed (no go/no-go, no waiting).
 * Invoice Request tasks are created externally by SEO; agent does not create them.
 * Dropped: creator_go_nogo, package_size_known.
 */
export interface OkbSignals {
  defined_questions_complete: boolean | null;
  payment_details_received: boolean | null;
  payment_evidence_found: boolean | null;
}

/** CKB reconciler booleans (ADR 0038). Unused = null. */
export interface CkbSignals {
  publication_submitted: boolean | null;
  published_link_present: boolean | null;
  corrections_present: boolean | null;
  corrections_cleared: boolean | null;
}

/** Shape of `<task_id>.reconcile-verdict.json` (ADR 0034 Tier 3). */
export interface ReconcileVerdict {
  board: Board;
  task_id: string;
  current_lane: Lane;
  truthful_signal: string; // NL audit, not consumed by the table
  signals: OkbSignals | CkbSignals;
  blocked: boolean;
  block_reason: string | null;
  /**
   * Audit trail of a no-effect executor run (ADR 0042): one rendered stub intent-string
   * per resolved Action. Empty until the executor runs; real effects do not write here.
   */
  dry_run: string[];
}

/**
 * An Action is a declarative description of one intended effect — NOT the effect itself.
 * The resolver emits these; the dry-run effects layer renders each to an intent string.
 */
export type Action =
  | { kind: 'lane_move'; to: Lane; gated: true }
  | { kind: 'comment'; body: string; tag?: 'Alina'; gated: false }
  | {
      kind: 'replyio';
      op: 'enrol' | 're_enrol' | 'send' | 'none';
      note: string; // what is being sent / why (intent text); template-filled by a helper
      stepId?: number;
      removeFromExisting?: boolean;
      gated: true;
    }
  | { kind: 'flag_operator'; reason: string };

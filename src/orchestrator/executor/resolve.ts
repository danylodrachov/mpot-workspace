/**
 * resolve.ts — pure `(lane, signals) → Action[]` (ADR 0042, tables from ADR 0037/0038).
 * No I/O. A null gating signal always yields flag_operator (halt-never-guess).
 */
import type { ReconcileVerdict, Action, OkbSignals, CkbSignals } from './types.ts';

export function resolve(
  verdict: Pick<ReconcileVerdict, 'current_lane' | 'signals' | 'blocked' | 'block_reason'>,
): Action[] {
  if (verdict.blocked) {
    return [{ kind: 'flag_operator', reason: verdict.block_reason ?? 'blocked (no reason provided)' }];
  }

  const { current_lane, signals } = verdict;

  switch (current_lane) {
    // ── OKB ──────────────────────────────────────────────────────────────────
    case 'Negotiation': {
      const s = signals as OkbSignals;
      if (s.defined_questions_complete === null) return flag('defined_questions_complete is null');
      if (!s.defined_questions_complete)
        return [{ kind: 'replyio', op: 'send', note: 'follow-up: chase unanswered Defined Questions', gated: true }];
      return [{ kind: 'lane_move', to: 'Completed', gated: true }];
    }

    case 'Invoice Request': {
      const s = signals as OkbSignals;
      if (s.payment_details_received === null) return flag('payment_details_received is null');
      if (!s.payment_details_received)
        return [{ kind: 'replyio', op: 'send', note: 'invoice-request template', gated: true }];
      return [{ kind: 'lane_move', to: 'To Pay', gated: true }];
    }

    case 'To Pay': {
      const s = signals as OkbSignals;
      if (s.payment_evidence_found === null) return flag('payment_evidence_found is null');
      if (!s.payment_evidence_found) return []; // waiting; no agent action
      return [{ kind: 'comment', body: 'Payment evidence found — pasting for review.', tag: 'Alina', gated: false }];
    }

    // ── CKB ──────────────────────────────────────────────────────────────────
    case 'To Submit': {
      const s = signals as CkbSignals;
      if (s.publication_submitted === null) return flag('publication_submitted is null');
      if (!s.publication_submitted)
        return [{ kind: 'replyio', op: 'enrol', note: 'Step 1 placement (template)', stepId: 1, gated: true }];
      return [{ kind: 'lane_move', to: 'Publication', gated: true }];
    }

    case 'Publication': {
      const s = signals as CkbSignals;
      if (s.published_link_present === null) return flag('published_link_present is null');
      if (!s.published_link_present)
        return [{ kind: 'replyio', op: 're_enrol', note: 'Step 2 chase (ADR 0041)', stepId: 2, gated: true }];
      return [{ kind: 'flag_operator', reason: 'published_link_present: verification flow out of scope (ADR 0041)' }];
    }

    case 'Publication Revision': {
      const s = signals as CkbSignals;
      // corrections_cleared takes priority; check it first
      if (s.corrections_cleared === null) return flag('corrections_cleared is null');
      if (s.corrections_cleared) {
        return [
          { kind: 'replyio', op: 'send', note: 'Step 4 thank-you (template)', stepId: 4, gated: true },
          { kind: 'lane_move', to: 'Completed', gated: true },
          { kind: 'comment', body: 'All corrections cleared — moving to Completed.', gated: false },
        ];
      }
      if (s.corrections_present === null) return flag('corrections_present is null');
      if (s.corrections_present)
        return [{ kind: 'replyio', op: 're_enrol', note: 'Step 3 corrections (gated)', stepId: 3, gated: true }];
      return [];
    }

    default:
      return [{ kind: 'flag_operator', reason: `lane "${current_lane}" is not in the executor's action surface` }];
  }
}

function flag(reason: string): Action[] {
  return [{ kind: 'flag_operator', reason }];
}

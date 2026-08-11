// FIX-02: the single authoritative runtime gate for the passive/executed interaction contract.
// Every producer (crawler.ts, when it writes interactions.jsonl) and every consumer (the review
// pipeline, before it hands interactions.jsonl to the reviewer) must funnel through this module
// rather than re-implementing the "is this label an executed-action outcome" check locally —
// keeping exactly one place that knows the forbidden vocabulary for a passive_only run.
import type { InteractionActionClass, InteractionCandidateRecord, InteractionMode, ObservationCandidateStatus } from './types.ts';

// The full InteractionOutcome vocabulary (types.ts keeps the canonical union) — duplicated here as
// a runtime Set (types are erased at runtime, so the enum values must be re-listed) rather than
// imported, to keep this module free of any circular re-export surface.
const EXECUTED_ACTION_LABELS = new Set<string>([
  'revealed_evidence',
  'state_changed_no_new_evidence',
  'no_effect',
  'blocked',
  'unsafe',
  'timeout',
  'unsupported',
]);

// FIX-03: the ONLY adapter classes bounded_reveal is allowed to have actually executed. Deliberately
// excludes 'modal_trigger', 'payment_method_card', 'pagination' and generic 'iframe_interaction' —
// those remain passive-only trace candidates until a separately approved adapter class exists for
// them (see FIX-03 ticket "Explicit limitation"). Duplicated as a runtime Set for the same reason
// EXECUTED_ACTION_LABELS is above (types are erased at runtime).
const BOUNDED_REVEAL_ALLOWED_ACTION_CLASSES = new Set<InteractionActionClass>([
  'tab',
  'accordion_or_disclosure',
  'native_select_enumeration',
  'combobox_listbox_open',
  'load_more',
]);

const OBSERVATION_LABELS = new Set<ObservationCandidateStatus>(['detected_candidate_only', 'detector_error']);

export class PassiveInteractionContractError extends Error {
  readonly requestedUrl: string;
  readonly violatingLabels: string[];

  constructor(message: string, requestedUrl: string, violatingLabels: string[]) {
    super(message);
    this.name = 'PassiveInteractionContractError';
    this.requestedUrl = requestedUrl;
    this.violatingLabels = violatingLabels;
  }
}

/** True only for a label from the executed-action vocabulary (InteractionOutcome). */
export function isExecutedActionLabel(label: string): boolean {
  return EXECUTED_ACTION_LABELS.has(label);
}

/** True only for a label from the passive-observation vocabulary (ObservationCandidateStatus). */
export function isObservationLabel(label: string): boolean {
  return OBSERVATION_LABELS.has(label as ObservationCandidateStatus);
}

/**
 * Enforces the FIX-02 contract: while `mode === 'passive_only'`, no candidate row anywhere in
 * `records` may carry an executed-action outcome label. Throws PassiveInteractionContractError on
 * the first violating record — a passive_only run must never serialize (or, on the read side,
 * silently accept) evidence claiming an action it structurally never performed.
 *
 * Applies uniformly to freshly-produced records and to legacy on-disk interactions.jsonl lines
 * (which may predate the `schemaVersion`/`interactionMode` fields added by this ticket) — absence
 * of those fields never exempts a record from this check.
 */
export function assertPassiveOnlyInteractionRecords(mode: InteractionMode, records: InteractionCandidateRecord[]): void {
  if (mode !== 'passive_only') return;
  for (const record of records) {
    const violatingLabels = record.candidates
      .map((candidate) => candidate.label)
      .filter((label) => isExecutedActionLabel(label));
    if (violatingLabels.length > 0) {
      throw new PassiveInteractionContractError(
        `passive_only run recorded executed-action outcome(s) [${violatingLabels.join(', ')}] for ${record.requestedUrl} — ` +
          'a passive_only run must never claim an executed interaction.',
        record.requestedUrl,
        violatingLabels,
      );
    }
  }
}

// FIX-03: the bounded_reveal-specific companion to the check above. A passive_only run may never
// claim ANY executed action (checked above); a bounded_reveal run may claim executed actions, but
// only from the small allowlisted adapter set — never an arbitrary/unapproved actionClass (e.g.
// 'modal_trigger' or 'payment_method_card') sneaking onto an ExecutedCandidateRow via this mode.
// Never weakens assertPassiveOnlyInteractionRecords above — this is an additional, narrower gate
// that only applies when mode === 'bounded_reveal'.
export function assertBoundedRevealInteractionRecords(mode: InteractionMode, records: InteractionCandidateRecord[]): void {
  if (mode !== 'bounded_reveal') return;
  for (const record of records) {
    const violating = record.candidates.filter(
      (candidate): candidate is InteractionCandidateRecord['candidates'][number] & { actionClass: InteractionActionClass } =>
        isExecutedActionLabel(candidate.label) &&
        'actionClass' in candidate &&
        !BOUNDED_REVEAL_ALLOWED_ACTION_CLASSES.has(candidate.actionClass),
    );
    if (violating.length > 0) {
      throw new PassiveInteractionContractError(
        `bounded_reveal run recorded executed-action outcome(s) for out-of-allowlist actionClass(es) ` +
          `[${violating.map((c) => c.actionClass).join(', ')}] for ${record.requestedUrl} — ` +
          'bounded_reveal may only execute the FIX-03 adapter allowlist (tab, accordion_or_disclosure, ' +
          'native_select_enumeration, combobox_listbox_open, load_more).',
        record.requestedUrl,
        violating.map((c) => c.actionClass),
      );
    }
  }
}

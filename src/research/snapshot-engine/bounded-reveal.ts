import type { Locator, Page } from 'playwright';
import {
  captureState,
  diffStates,
  isTimeoutError,
  waitForDeltaSettle,
} from './interaction-delta-profiler.ts';
import type {
  InteractionActionClass,
  InteractionExecutionRecord,
  InteractionOutcome,
  InteractiveElementTrace,
  LocatorEvidence,
} from './types.ts';
import { DEFAULT_BOUNDED_REVEAL_BUDGETS, DEFAULT_RUNTIME_BUDGETS } from './runtime-config.ts';

// FIX-03: bounded_reveal is a small, generic, allowlisted set of low-risk reveal interactions —
// ARIA/native tabs, aria-expanded disclosure/accordion controls, native <select> option
// enumeration without changing selection, strongly-ARIA-signalled combobox/listbox open-and-
// observe, and load-more with a repeated-list growth check. It is categorically NOT arbitrary
// custom-button clicking: every candidate must pass isSafeToExecute() below AND match one of the
// BOUNDED_REVEAL_ADAPTER_CLASSES before any Playwright mutating action ever runs against it.

export const BOUNDED_REVEAL_ADAPTER_CLASSES: ReadonlySet<InteractionActionClass> = new Set([
  'tab',
  'accordion_or_disclosure',
  'native_select_enumeration',
  'combobox_listbox_open',
  'load_more',
]);

// ---------------------------------------------------------------------------
// Hard safety gate — never submit forms; never fill credential/KYC/payment/deposit/withdrawal/
// wagering inputs; never click a control whose inferred action is submit/confirm/pay/deposit/
// withdraw/bet/purchase; never follow an interaction into an external origin. This is a pure,
// synchronous function so it can be unit-tested exhaustively (including adversarial cases)
// without any Playwright fixture.
// ---------------------------------------------------------------------------

const FORM_SUBMISSION_PATTERN = /submit|confirm\s*(order|payment|purchase)?|proceed\s*to\s*(pay|checkout)/i;
const TRANSACTIONAL_ACTION_PATTERN =
  /deposit|withdraw(al)?|cashier|checkout|top[\s-]?up|wager|place\s*(a\s*)?bet|\bbet\b|purchase|buy\s*now|pay\s*now|payout/i;
const CREDENTIAL_KYC_PAYMENT_PATTERN =
  /password|username|login|log\s*in|sign\s*in|card\s*number|cvv|cvc|expiry|iban|routing\s*number|account\s*number|sort\s*code|ssn|social\s*security|kyc|id\s*upload|passport|driver'?s?\s*licen[sc]e|proof\s*of\s*(id|address)|bank\s*account/i;
const CREDENTIAL_INPUT_TYPES = new Set(['password']);

function candidateText(el: InteractiveElementTrace): string {
  return `${el.name ?? ''} ${el.domPath} ${el.role ?? ''}`;
}

function isFormSubmission(el: InteractiveElementTrace): boolean {
  if (el.tag === 'form') return true;
  if (el.type === 'submit') return true;
  if (el.eventAttributeHints.includes('onsubmit')) return true;
  if (el.detectorHints.includes('form_control') && el.type === 'submit') return true;
  return false;
}

function isCrossOrigin(el: InteractiveElementTrace, pageOrigin?: string): boolean {
  if (!el.href || !pageOrigin) return false;
  try {
    return new URL(el.href, pageOrigin).origin !== pageOrigin;
  } catch {
    return false;
  }
}

/**
 * Hard filter, called before ANY bounded_reveal adapter executes a real action. Rejects:
 *   - form submissions;
 *   - controls whose inferred action is submit/confirm/pay/deposit/withdraw/bet/purchase;
 *   - credential/KYC/payment/deposit/withdrawal/wagering-shaped inputs or controls;
 *   - cross-origin targets.
 * This is a hard constraint enforced in code, not merely documented — no adapter classifier
 * below is ever consulted for a candidate this function rejects.
 */
export function isSafeToExecute(el: InteractiveElementTrace, pageOrigin?: string): boolean {
  if (isFormSubmission(el)) return false;
  const text = candidateText(el);
  if (FORM_SUBMISSION_PATTERN.test(text)) return false;
  if (TRANSACTIONAL_ACTION_PATTERN.test(text)) return false;
  if (CREDENTIAL_KYC_PAYMENT_PATTERN.test(text)) return false;
  if (el.type && CREDENTIAL_INPUT_TYPES.has(el.type)) return false;
  if (isCrossOrigin(el, pageOrigin)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Adapter classification — strict, adapter-specific semantic preconditions. Never promotes a bare
// `custom_pointer_control` or a weak/ambiguous ARIA signal; a candidate that looks plausible but
// fails its adapter's precondition is reported 'unsupported' by the caller, never executed.
// ---------------------------------------------------------------------------

export type BoundedRevealClassification = InteractionActionClass | 'unsupported' | undefined;

/**
 * Classifies one passive trace candidate against the bounded_reveal adapter allowlist. Returns:
 *   - an allowlisted InteractionActionClass when the candidate matches an adapter's strict
 *     semantic precondition;
 *   - 'unsupported' when the candidate carries a plausible reveal hint but fails that precondition
 *     (e.g. a dropdown-like control with no strong ARIA relationship signal) — the caller must
 *     record this as a trace-only 'unsupported' outcome and never click it;
 *   - undefined when the candidate is not a bounded_reveal candidate at all (no relevant hint, or
 *     invisible/disabled/off-scope).
 * Restricted to the main frame only — cross-frame reveal adapters are out of FIX-03 scope.
 */
export function classifyBoundedRevealCandidate(
  el: InteractiveElementTrace,
  context: { mainFrameUrl: string; pageOrigin?: string },
): BoundedRevealClassification {
  if (!el.visible || el.disabled) return undefined;
  if (el.frameUrl !== context.mainFrameUrl) return undefined;
  if (!isSafeToExecute(el, context.pageOrigin)) return undefined;

  const hints = new Set(el.detectorHints);

  // Native <select> enumeration: always supported when it is genuinely a <select>.
  if (el.tag === 'select') return 'native_select_enumeration';

  // ARIA/native tabs.
  if (hints.has('tab') || el.role === 'tab') {
    if (el.role === 'tab' || el.tag === 'button' || el.tag === 'a') return 'tab';
    return 'unsupported';
  }

  // aria-expanded / disclosure / accordion controls.
  if (hints.has('expandable_or_accordion') || el.ariaExpanded !== undefined || el.tag === 'summary' || el.tag === 'details') {
    return 'accordion_or_disclosure';
  }

  // Custom combobox/listbox: require a STRONG ARIA relationship signal — role=combobox/listbox
  // AND (an aria-controls/aria-owns relationship OR aria-haspopup=listbox). A bare cursor:pointer
  // "dropdown-looking" element with no such signal is 'unsupported', never clicked.
  if (hints.has('dropdown_or_listbox') || el.role === 'combobox' || el.role === 'listbox') {
    const hasStrongAriaRelationship =
      (el.role === 'combobox' || el.role === 'listbox') && (Boolean(el.ariaControls) || el.ariaHaspopup === 'listbox');
    return hasStrongAriaRelationship ? 'combobox_listbox_open' : 'unsupported';
  }

  // Load-more controls.
  if (hints.has('load_more_candidate')) return 'load_more';

  return undefined;
}

// ---------------------------------------------------------------------------
// Execution protocol
// ---------------------------------------------------------------------------

export interface BoundedRevealOptions {
  actionTimeoutMs?: number;
  deltaSettleMs?: number;
  deltaSettlePollIntervalMs?: number;
  maxActionsPerPage?: number;
  maxActionsPerAdapter?: number;
}

function buildRecord(
  el: InteractiveElementTrace,
  actionClass: InteractionActionClass,
  locatorEvidence: LocatorEvidence,
  outcome: InteractionOutcome,
  startedAt: number,
  delta?: import('./types.ts').InteractionDelta,
  note?: string,
  afterHtml?: string,
): InteractionExecutionRecord {
  return {
    frameUrl: el.frameUrl,
    domPath: el.domPath,
    tag: el.tag,
    role: el.role,
    name: el.name,
    actionClass,
    locatorEvidence,
    outcome,
    delta,
    durationMs: Date.now() - startedAt,
    note,
    afterHtml,
    revealedContainerSelector: afterHtml ? (el.ariaControls ? `#${el.ariaControls}` : el.domPath) : undefined,
  };
}

function locatorEvidenceFor(el: InteractiveElementTrace): LocatorEvidence {
  if (el.domPath.startsWith('#') || el.domPath.startsWith('[data-testid=')) {
    return { strategy: 'stable_id', selector: el.domPath, role: el.role, name: el.name };
  }
  if (el.role && el.name) return { strategy: 'aria_role_name', selector: el.domPath, role: el.role, name: el.name };
  if (el.ariaControls || el.ariaExpanded !== undefined) {
    return { strategy: 'aria_relationship', selector: el.domPath, role: el.role, name: el.name };
  }
  if (el.name) return { strategy: 'semantic_bounded_text', selector: el.domPath, role: el.role, name: el.name };
  return { strategy: 'dom_path_fallback', selector: el.domPath, role: el.role, name: el.name };
}

/** Toggle-style restore (accordion/combobox): click again if the expansion state actually
 * changed. Best-effort only, never throws — a restore failure must not stop the run. */
async function tryRestoreToggle(locator: Locator, before: import('./interaction-delta-profiler.ts').CapturedState, actionTimeoutMs: number): Promise<void> {
  try {
    const nowExpanded = await locator.getAttribute('aria-expanded').catch(() => null);
    if (nowExpanded === 'true' && before.ariaExpanded !== 'true') {
      await locator.click({ timeout: actionTimeoutMs }).catch(() => {});
    }
  } catch {
    // Best-effort only.
  }
}

/** Reloads the original visited URL — used as the fallback restoration path for adapters (tab,
 * load-more) whose state cannot practically be toggled back, so the NEXT unrelated candidate on
 * this page still starts from a clean baseline. Never throws. */
async function reloadOriginalUrl(page: Page, originalUrl: string, actionTimeoutMs: number): Promise<void> {
  try {
    await page.goto(originalUrl, { timeout: actionTimeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {});
  } catch {
    // Best-effort only.
  }
}

async function enumerateSelectOptions(locator: Locator): Promise<{ optionCount: number; selectedUnchanged: boolean }> {
  const before = await locator.evaluate((node: unknown) => {
    const el = node as HTMLSelectElement;
    return { selectedIndex: el.selectedIndex, optionCount: el.options.length };
  });
  // No mutation is ever dispatched — this adapter reads .options, it never calls selectOption().
  const after = await locator.evaluate((node: unknown) => {
    const el = node as HTMLSelectElement;
    return { selectedIndex: el.selectedIndex };
  });
  return { optionCount: before.optionCount, selectedUnchanged: before.selectedIndex === after.selectedIndex };
}

/**
 * Executes the FIX-03 bounded_reveal protocol against `trace`'s candidates: adapter-specific
 * preconditions -> before-state -> one bounded action -> bounded settle -> after-state -> outcome
 * classification -> baseline restore/reload -> per-page/per-adapter budget enforcement. Every
 * candidate's isolation guarantee matches CD-N04's executeInteractionCandidates: one candidate's
 * failure is always isolated to its own record.
 */
export async function executeBoundedRevealCandidates(
  page: Page,
  trace: InteractiveElementTrace[],
  originalUrl: string,
  options: BoundedRevealOptions = {},
): Promise<InteractionExecutionRecord[]> {
  if (trace.length === 0) return [];

  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_RUNTIME_BUDGETS.interactionActionTimeoutMs;
  const deltaSettleMs = options.deltaSettleMs ?? 1_500;
  const deltaSettlePollIntervalMs = options.deltaSettlePollIntervalMs ?? 100;
  const maxActionsPerPage = options.maxActionsPerPage ?? DEFAULT_BOUNDED_REVEAL_BUDGETS.maxActionsPerPage;
  const maxActionsPerAdapter = options.maxActionsPerAdapter ?? DEFAULT_BOUNDED_REVEAL_BUDGETS.maxActionsPerAdapter;

  const mainFrameUrl = page.mainFrame().url();
  let pageOrigin: string | undefined;
  try {
    pageOrigin = new URL(mainFrameUrl).origin;
  } catch {
    pageOrigin = undefined;
  }

  const records: InteractionExecutionRecord[] = [];
  const adapterCounts = new Map<InteractionActionClass, number>();
  let totalActions = 0;

  for (const el of trace) {
    if (totalActions >= maxActionsPerPage) break;

    const classification = classifyBoundedRevealCandidate(el, { mainFrameUrl, pageOrigin });
    if (classification === undefined) continue;

    const startedAt = Date.now();
    const locatorEvidence = locatorEvidenceFor(el);

    if (classification === 'unsupported') {
      // FIX-03 hard rule: an unsupported custom control stays a trace candidate only, never
      // clicked. No locator is even constructed.
      records.push(
        buildRecord(
          el,
          // No allowlisted actionClass applies; best-effort classification for the record only.
          (el.tag === 'select' ? 'native_select_enumeration' : 'combobox_listbox_open') as InteractionActionClass,
          locatorEvidence,
          'unsupported',
          startedAt,
          undefined,
          'Candidate did not satisfy the bounded_reveal adapter precondition; never clicked.',
        ),
      );
      continue;
    }

    const actionClass = classification;
    const adapterUsed = adapterCounts.get(actionClass) ?? 0;
    if (adapterUsed >= maxActionsPerAdapter) continue;

    let locator: Locator;
    try {
      const frame = page.frames().find((f) => f.url() === el.frameUrl) ?? page.mainFrame();
      locator = frame.locator(el.domPath).first();
    } catch (error) {
      records.push(
        buildRecord(el, actionClass, locatorEvidence, 'blocked', startedAt, undefined, `Locator construction failed: ${error instanceof Error ? error.message : String(error)}`),
      );
      continue;
    }

    let before;
    try {
      before = await captureState(page, locator);
    } catch {
      records.push(buildRecord(el, actionClass, locatorEvidence, 'blocked', startedAt, undefined, 'Before-state capture failed'));
      continue;
    }

    // Native select enumeration: read-only, never clicks, never changes the selection.
    if (actionClass === 'native_select_enumeration') {
      try {
        const { optionCount, selectedUnchanged } = await enumerateSelectOptions(locator);
        const outcome: InteractionOutcome = !selectedUnchanged
          ? 'blocked' // defensive: enumeration must never mutate selection; treat as blocked if it did
          : optionCount > 1
            ? 'revealed_evidence'
            : 'no_effect';
        const after = outcome === 'revealed_evidence' ? await captureState(page, locator) : before;
        const delta = diffStates(before, after);
        records.push(
          buildRecord(
            el,
            actionClass,
            locatorEvidence,
            outcome,
            startedAt,
            delta,
            `Enumerated ${optionCount} option(s) without changing selection.`,
          ),
        );
      } catch (error) {
        records.push(buildRecord(el, actionClass, locatorEvidence, 'blocked', startedAt, undefined, error instanceof Error ? error.message : String(error)));
      }
      totalActions += 1;
      adapterCounts.set(actionClass, adapterUsed + 1);
      continue;
    }

    // Actionability trial — never touches the page if it fails.
    try {
      await locator.click({ trial: true, timeout: actionTimeoutMs });
    } catch (error) {
      records.push(
        buildRecord(el, actionClass, locatorEvidence, isTimeoutError(error) ? 'timeout' : 'blocked', startedAt, undefined, error instanceof Error ? error.message : String(error)),
      );
      totalActions += 1;
      adapterCounts.set(actionClass, adapterUsed + 1);
      continue;
    }

    if (actionClass === 'load_more') {
      // Load-more: repeated clicks until no new content appears or the per-adapter budget for
      // this class is exhausted (each click still counts against maxActionsPerAdapter/Page).
      let grewAtLeastOnce = false;
      let rounds = 0;
      let last = before;
      while (true) {
        const usedNow = adapterCounts.get(actionClass) ?? 0;
        if (usedNow >= maxActionsPerAdapter || totalActions >= maxActionsPerPage) break;
        let clickError: unknown;
        try {
          await locator.click({ timeout: actionTimeoutMs });
        } catch (error) {
          clickError = error;
        }
        totalActions += 1;
        adapterCounts.set(actionClass, usedNow + 1);
        rounds += 1;
        if (clickError) {
          records.push(
            buildRecord(el, actionClass, locatorEvidence, isTimeoutError(clickError) ? 'timeout' : 'blocked', startedAt, undefined, clickError instanceof Error ? clickError.message : String(clickError)),
          );
          break;
        }
        await waitForDeltaSettle(page, deltaSettleMs, deltaSettlePollIntervalMs);
        const after = await captureState(page, locator).catch(() => last);
        const delta = diffStates(last, after);
        if (delta.contentChanged) {
          grewAtLeastOnce = true;
          last = after;
        } else {
          // No growth this round: stop.
          records.push(
            buildRecord(
              el,
              actionClass,
              locatorEvidence,
              grewAtLeastOnce ? 'revealed_evidence' : 'no_effect',
              startedAt,
              diffStates(before, last),
              `load_more ran ${rounds} round(s); stopped on no further growth.`,
              grewAtLeastOnce ? last.html : undefined,
            ),
          );
          last = after;
          break;
        }
      }
      // Budget/page-limit exhausted while still growing (the inner loop above already pushes a
      // terminal record whenever a round produces no further growth) — push the final terminal
      // record here only if that path was never taken.
      const lastRecord = records[records.length - 1];
      const alreadyTerminated = lastRecord && lastRecord.domPath === el.domPath && lastRecord.actionClass === actionClass;
      if (!alreadyTerminated) {
        records.push(
          buildRecord(
            el,
            actionClass,
            locatorEvidence,
            grewAtLeastOnce ? 'revealed_evidence' : 'no_effect',
            startedAt,
            diffStates(before, last),
            `load_more ran ${rounds} round(s); stopped on budget exhaustion.`,
            grewAtLeastOnce ? last.html : undefined,
          ),
        );
      }
      // load_more is additive/one-way — no restore, no reload needed for it specifically.
      continue;
    }

    // Single-shot adapters: tab, accordion_or_disclosure, combobox_listbox_open.
    let actionError: unknown;
    try {
      await locator.click({ timeout: actionTimeoutMs });
    } catch (error) {
      actionError = error;
    }
    totalActions += 1;
    adapterCounts.set(actionClass, adapterUsed + 1);

    if (actionError) {
      records.push(
        buildRecord(el, actionClass, locatorEvidence, isTimeoutError(actionError) ? 'timeout' : 'blocked', startedAt, undefined, actionError instanceof Error ? actionError.message : String(actionError)),
      );
      continue;
    }

    await waitForDeltaSettle(page, deltaSettleMs, deltaSettlePollIntervalMs);

    let after;
    try {
      after = await captureState(page, locator);
    } catch {
      after = before;
    }

    let unsafe = false;
    if (pageOrigin) {
      try {
        if (new URL(after.url).origin !== pageOrigin) unsafe = true;
      } catch {
        // Unparsable after-url: not classified unsafe on this basis alone.
      }
    }

    const delta = diffStates(before, after);
    const stateToggled = delta.ariaExpandedBefore !== delta.ariaExpandedAfter || delta.ariaSelectedBefore !== delta.ariaSelectedAfter;
    const revealed = delta.overlayAppeared || (delta.contentChanged && (stateToggled || delta.urlChanged));
    const outcome: InteractionOutcome = unsafe
      ? 'unsafe'
      : revealed
        ? 'revealed_evidence'
        : stateToggled || delta.contentChanged || delta.urlChanged
          ? 'state_changed_no_new_evidence'
          : 'no_effect';

    records.push(
      buildRecord(el, actionClass, locatorEvidence, outcome, startedAt, delta, undefined, outcome === 'revealed_evidence' ? after.html : undefined),
    );

    if (unsafe) continue;

    if (actionClass === 'accordion_or_disclosure' || actionClass === 'combobox_listbox_open') {
      await tryRestoreToggle(locator, before, actionTimeoutMs);
    } else if (actionClass === 'tab') {
      // Tabs generally cannot be cleanly toggled back — reload the original URL so the next
      // unrelated candidate on this page starts from a clean baseline.
      await reloadOriginalUrl(page, originalUrl, actionTimeoutMs);
    }
  }

  return records;
}

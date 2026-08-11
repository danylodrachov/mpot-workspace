import type { Locator, Page } from 'playwright';
import { hasVisibleLoadingIndicator } from './passive-interactivity.ts';
import { sha256 } from './io.ts';
import type {
  InteractionActionClass,
  InteractionDelta,
  InteractionExecutionRecord,
  InteractionOutcome,
  InteractiveElementTrace,
  LazyScrollPassResult,
  LocatorEvidence,
} from './types.ts';
import { DEFAULT_RUNTIME_BUDGETS } from './runtime-config.ts';

// CD-N04: this is the one sanctioned module in snapshot-engine that is allowed to perform a real
// page-element interaction (click). Every other module stays passive-only (see passive-only.test.ts,
// which explicitly excludes this file from its "no interaction" scan with the same justification).
// The interactions performed here are never proof by themselves that hidden content was collected —
// only a measurable before/after delta (see diffStates/classifyOutcome below) may ever produce the
// 'revealed_evidence' outcome. A bare trace candidate never becomes extracted evidence.

// CD-N07: "one interaction action + delta settle" and "controlled-scroll round" both derive their
// defaults from the centralized runtime-config budgets, not a local magic number.
const DEFAULT_ACTION_TIMEOUT_MS = DEFAULT_RUNTIME_BUDGETS.interactionActionTimeoutMs;
const DEFAULT_DELTA_SETTLE_MS = 1_500;
const DEFAULT_DELTA_SETTLE_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_CANDIDATES_PER_PAGE = 40;
const DEFAULT_RESTORE_TIMEOUT_MS = 1_000;

const DEFAULT_MAX_SCROLL_ROUNDS = 12;
const DEFAULT_SCROLL_STABLE_ROUNDS_REQUIRED = 2;
const DEFAULT_SCROLL_ROUND_BUDGET_MS = DEFAULT_RUNTIME_BUDGETS.controlledScrollRoundTimeoutMs;

// ---- Exclusion: never auto-executed regardless of any detected hint. ----
// Generic keyword/semantic patterns only — never a casino hostname or a specific framework's
// component name.
const COOKIE_PATTERN = /cookie|consent\b|gdpr/i;
const ACCOUNT_PATTERN = /log\s*in|log\s*out|sign\s*in|sign\s*up|register|my\s*account|\baccount\b|profile|password/i;
const GAME_LAUNCH_PATTERN = /play\s*(now|for\s*real|real\s*money|game)|launch\s*(game|casino)|demo\s*play|real\s*play/i;
const TRANSACTION_PATTERN = /deposit|withdraw|checkout|confirm\s*payment|pay\s*now|top\s*up|cashier\s*submit/i;
const PAYMENT_METHOD_PATTERN =
  /visa|mastercard|maestro|paypal|skrill|neteller|paysafecard|trustly|klarna|apple\s*pay|google\s*pay|bank\s*transfer|crypto(?:currency)?|bitcoin|ethereum|interac|mifinity|revolut|zimpler|jeton|astropay/i;

const NON_NAV_HINTS = ['expandable_or_accordion', 'tab', 'dropdown_or_listbox', 'possible_modal_trigger'];

function textOf(el: InteractiveElementTrace): string {
  return `${el.name ?? ''} ${el.domPath}`;
}

// Exported for tests and for reuse by any future candidate-listing code that wants to explain why
// a trace candidate was never eligible for automatic execution.
export function isExcludedFromAutomaticExecution(el: InteractiveElementTrace, pageOrigin?: string): boolean {
  const text = textOf(el);
  if (COOKIE_PATTERN.test(text)) return true;
  if (ACCOUNT_PATTERN.test(text)) return true;
  if (GAME_LAUNCH_PATTERN.test(text)) return true;
  if (TRANSACTION_PATTERN.test(text)) return true;
  if (el.eventAttributeHints.includes('onsubmit')) return true;
  if (el.detectorHints.includes('form_control') && el.type === 'submit') return true;
  if (el.href && pageOrigin) {
    try {
      const hrefOrigin = new URL(el.href, pageOrigin).origin;
      if (hrefOrigin !== pageOrigin) return true;
    } catch {
      // Unparsable href: not excludable on this basis alone.
    }
  }
  // Ordinary header/footer navigation: a plain link with no other interactive semantics.
  if (el.detectorHints.includes('navigation_link') && !el.detectorHints.some((h) => NON_NAV_HINTS.includes(h))) {
    return true;
  }
  return false;
}

// CD-N04: converts a trace signal into one of the allowed stable action classes, or undefined if
// it cannot be deterministically promoted. `custom_pointer_control`-only candidates (cursor:
// pointer with no ARIA/semantic evidence — generic noise, not real interactivity) never return a
// class here regardless of which site produced them.
export function classifyActionCandidate(
  el: InteractiveElementTrace,
  context: { mainFrameUrl: string; pageOrigin?: string },
): InteractionActionClass | undefined {
  if (!el.visible || el.disabled) return undefined;
  if (isExcludedFromAutomaticExecution(el, context.pageOrigin)) return undefined;

  const hints = new Set(el.detectorHints);
  let base: InteractionActionClass | undefined;
  if (hints.has('expandable_or_accordion')) base = 'accordion_or_disclosure';
  else if (hints.has('tab')) base = 'tab';
  else if (hints.has('possible_modal_trigger')) base = 'modal_trigger';
  else if (hints.has('dropdown_or_listbox')) base = 'dropdown_or_combobox';
  else if (hints.has('load_more_candidate')) base = 'load_more';
  else if (hints.has('pagination_candidate')) base = 'pagination';
  else if (
    PAYMENT_METHOD_PATTERN.test(el.name ?? '') &&
    (el.role === 'radio' || el.role === 'tab' || el.role === 'button' || el.cursorPointer)
  ) {
    base = 'payment_method_card';
  }

  if (!base) return undefined;
  return el.frameUrl !== context.mainFrameUrl ? 'iframe_interaction' : base;
}

// CD-N04: reusable-locator evidence preference order — 1) stable id/testid, 2) ARIA role +
// accessible name, 3) aria-controls/aria-expanded relationship, 4) element semantics + bounded
// text, 5) current DOM path fallback. `domPath` (built in passive-interactivity.ts) already
// prefers `#id`/`[data-testid=...]` over a positional chain, so tier 1 is a cheap prefix check.
export function buildLocatorEvidence(el: InteractiveElementTrace): LocatorEvidence {
  if (el.domPath.startsWith('#') || el.domPath.startsWith('[data-testid=')) {
    return { strategy: 'stable_id', selector: el.domPath, role: el.role, name: el.name };
  }
  if (el.role && el.name) {
    return { strategy: 'aria_role_name', selector: el.domPath, role: el.role, name: el.name };
  }
  if (el.ariaControls || el.ariaExpanded !== undefined) {
    return { strategy: 'aria_relationship', selector: el.domPath, role: el.role, name: el.name };
  }
  if (el.name) {
    return { strategy: 'semantic_bounded_text', selector: el.domPath, role: el.role, name: el.name };
  }
  return { strategy: 'dom_path_fallback', selector: el.domPath, role: el.role, name: el.name };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || /timeout/i.test(error.message);
}

interface CapturedState {
  url: string;
  html: string;
  contentHash: string;
  ariaExpanded?: string;
  ariaSelected?: string;
  overlayCount: number;
  frameCount: number;
}

async function countVisibleOverlays(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const isVisible = (el: Element): boolean => {
        if (!(el instanceof HTMLElement)) return true;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], [popover]')).filter(
        isVisible,
      ).length;
    })
    .catch(() => 0);
}

async function captureState(page: Page, locator: Locator): Promise<CapturedState> {
  const url = page.url();
  const html = await page.content().catch(() => '');
  const [ariaExpanded, ariaSelected, overlayCount] = await Promise.all([
    locator.getAttribute('aria-expanded').catch(() => null),
    locator.getAttribute('aria-selected').catch(() => null),
    countVisibleOverlays(page),
  ]);
  return {
    url,
    html,
    contentHash: sha256(html),
    ariaExpanded: ariaExpanded ?? undefined,
    ariaSelected: ariaSelected ?? undefined,
    overlayCount,
    frameCount: page.frames().length,
  };
}

// CD-N05: best-effort selector for where a revealed subtree can be found inside the after-action
// HTML — prefers the interacted element's aria-controls target (the standard ARIA relationship for
// "this control reveals that content"), falling back to the element's own domPath so the corpus
// builder always has something to look for even without an aria-controls relationship.
function revealedContainerSelectorFor(el: InteractiveElementTrace): string {
  if (el.ariaControls) return `#${el.ariaControls}`;
  return el.domPath;
}

function diffStates(before: CapturedState, after: CapturedState): InteractionDelta {
  return {
    contentChanged: before.contentHash !== after.contentHash,
    ariaExpandedBefore: before.ariaExpanded,
    ariaExpandedAfter: after.ariaExpanded,
    ariaSelectedBefore: before.ariaSelected,
    ariaSelectedAfter: after.ariaSelected,
    overlayAppeared: after.overlayCount > before.overlayCount,
    frameCountBefore: before.frameCount,
    frameCountAfter: after.frameCount,
    urlChanged: before.url !== after.url,
    networkActivityDelta: 0,
  };
}

// CD-N04 acceptance criterion: "Hidden content is accepted as collected only when a measurable
// before/after delta exists." `revealed_evidence` is the only outcome this function can return
// that a downstream consumer may treat as "new evidence collected" — every branch below requires
// an actual observed delta.
function classifyOutcome(delta: InteractionDelta): InteractionOutcome {
  const stateToggled = delta.ariaExpandedBefore !== delta.ariaExpandedAfter || delta.ariaSelectedBefore !== delta.ariaSelectedAfter;
  const revealed =
    delta.overlayAppeared ||
    delta.frameCountAfter > delta.frameCountBefore ||
    (delta.contentChanged && (stateToggled || delta.urlChanged));
  if (revealed) return 'revealed_evidence';
  if (stateToggled || delta.contentChanged || delta.urlChanged) return 'state_changed_no_new_evidence';
  return 'no_effect';
}

// Bounded delta-settle: polls the shared passive loading-indicator probe (never a fixed sleep,
// never `networkidle`) until either no visible loading indicator remains or the budget runs out.
async function waitForDeltaSettle(page: Page, budgetMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  while (true) {
    const loading = await hasVisibleLoadingIndicator(page).catch(() => false);
    if (!loading) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await page.waitForTimeout(Math.max(0, Math.min(pollIntervalMs, remaining)));
  }
}

// Best-effort restoration to baseline before the next independent candidate is probed. Never
// throws — a restore failure must not stop the run or block later candidates.
async function tryRestoreBaseline(page: Page, locator: Locator, before: CapturedState, actionClass: InteractionActionClass): Promise<void> {
  // load_more/pagination are one-way, additive actions with no meaningful "undo" — leaving the
  // extra content in place does not corrupt the baseline for unrelated candidates.
  if (actionClass === 'load_more' || actionClass === 'pagination') return;
  try {
    const nowExpanded = await locator.getAttribute('aria-expanded').catch(() => null);
    if (nowExpanded === 'true' && before.ariaExpanded !== 'true') {
      await locator.click({ timeout: DEFAULT_RESTORE_TIMEOUT_MS }).catch(() => {});
      return;
    }
    if (page.url() !== before.url) {
      await page.goBack({ timeout: DEFAULT_RESTORE_TIMEOUT_MS }).catch(() => {});
    }
  } catch {
    // Best-effort only.
  }
}

export interface InteractionExecutionOptions {
  actionTimeoutMs?: number;
  deltaSettleMs?: number;
  deltaSettlePollIntervalMs?: number;
  maxCandidates?: number;
}

function buildRecord(
  el: InteractiveElementTrace,
  actionClass: InteractionActionClass,
  locatorEvidence: LocatorEvidence,
  outcome: InteractionOutcome,
  startedAt: number,
  delta?: InteractionDelta,
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
    // CD-N05: only ever attached when the outcome is 'revealed_evidence' — see call site below.
    afterHtml,
    revealedContainerSelector: afterHtml ? revealedContainerSelectorFor(el) : undefined,
  };
}

// CD-N04: executes the deterministic interaction protocol (before-state -> actionability trial
// -> one real action -> bounded delta-settle -> after-state -> delta -> terminal outcome ->
// restore baseline) for every eligible candidate in `trace`. One candidate's failure is always
// isolated to its own record; it can never stop the page or the run.
export async function executeInteractionCandidates(
  page: Page,
  trace: InteractiveElementTrace[],
  options: InteractionExecutionOptions = {},
): Promise<InteractionExecutionRecord[]> {
  if (trace.length === 0) return [];

  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const deltaSettleMs = options.deltaSettleMs ?? DEFAULT_DELTA_SETTLE_MS;
  const deltaSettlePollIntervalMs = options.deltaSettlePollIntervalMs ?? DEFAULT_DELTA_SETTLE_POLL_INTERVAL_MS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES_PER_PAGE;

  const mainFrameUrl = page.mainFrame().url();
  let pageOrigin: string | undefined;
  try {
    pageOrigin = new URL(mainFrameUrl).origin;
  } catch {
    pageOrigin = undefined;
  }

  const records: InteractionExecutionRecord[] = [];
  let executed = 0;

  for (const el of trace) {
    if (executed >= maxCandidates) break;
    const actionClass = classifyActionCandidate(el, { mainFrameUrl, pageOrigin });
    if (!actionClass) continue;
    executed += 1;
    const startedAt = Date.now();
    const locatorEvidence = buildLocatorEvidence(el);

    let locator: Locator;
    try {
      const frame = page.frames().find((f) => f.url() === el.frameUrl) ?? page.mainFrame();
      locator = frame.locator(el.domPath).first();
    } catch (error) {
      records.push(
        buildRecord(
          el,
          actionClass,
          locatorEvidence,
          'blocked',
          startedAt,
          undefined,
          `Locator construction failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    let before: CapturedState;
    try {
      before = await captureState(page, locator);
    } catch (error) {
      records.push(
        buildRecord(el, actionClass, locatorEvidence, 'blocked', startedAt, undefined, 'Before-state capture failed'),
      );
      continue;
    }

    // Step 2: actionability trial. A candidate that is not actionable right now is 'blocked' and
    // never touches the page.
    try {
      await locator.click({ trial: true, timeout: actionTimeoutMs });
    } catch (error) {
      records.push(
        buildRecord(
          el,
          actionClass,
          locatorEvidence,
          isTimeoutError(error) ? 'timeout' : 'blocked',
          startedAt,
          undefined,
          error instanceof Error ? error.message : String(error),
        ),
      );
      continue;
    }

    // Step 3: one real allowed action.
    let actionError: unknown;
    try {
      await locator.click({ timeout: actionTimeoutMs });
    } catch (error) {
      actionError = error;
    }

    if (actionError) {
      records.push(
        buildRecord(
          el,
          actionClass,
          locatorEvidence,
          isTimeoutError(actionError) ? 'timeout' : 'blocked',
          startedAt,
          undefined,
          actionError instanceof Error ? actionError.message : String(actionError),
        ),
      );
      await tryRestoreBaseline(page, locator, before, actionClass);
      continue;
    }

    // Step 4: bounded delta-settle.
    await waitForDeltaSettle(page, deltaSettleMs, deltaSettlePollIntervalMs);

    // Step 5/6: after-state and concrete deltas.
    let after: CapturedState;
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
    const outcome: InteractionOutcome = unsafe ? 'unsafe' : classifyOutcome(delta);
    records.push(
      buildRecord(
        el,
        actionClass,
        locatorEvidence,
        outcome,
        startedAt,
        delta,
        undefined,
        // CD-N05: the corpus builder needs the actual post-action HTML to recover revealed text,
        // never just for other outcomes (state_changed_no_new_evidence/no_effect/etc.) — those by
        // definition produced no new evidence to preserve.
        outcome === 'revealed_evidence' ? after.html : undefined,
      ),
    );

    // Step 8: restore baseline before the next independent candidate — skipped when the action
    // was classified unsafe (e.g. navigated off-origin) since a restore attempt itself would be
    // an uncontrolled second action.
    if (!unsafe) {
      await tryRestoreBaseline(page, locator, before, actionClass);
    }
  }

  return records;
}

export interface LazyScrollPassOptions {
  maxRounds?: number;
  stableRoundsRequired?: number;
  roundBudgetMs?: number;
}

// CD-N04: bounded controlled-scroll pass for lazy-loaded research sections. Stops after
// `stableRoundsRequired` consecutive rounds whose rendered content hash did not change, and never
// scrolls past `maxRounds` regardless of whether it ever stabilizes.
export async function controlledScrollPass(page: Page, options: LazyScrollPassOptions = {}): Promise<LazyScrollPassResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_SCROLL_ROUNDS);
  const stableRoundsRequired = Math.max(1, options.stableRoundsRequired ?? DEFAULT_SCROLL_STABLE_ROUNDS_REQUIRED);
  const roundBudgetMs = options.roundBudgetMs ?? DEFAULT_SCROLL_ROUND_BUDGET_MS;

  let previousHash: string | undefined;
  let stableRounds = 0;
  let newContentDetected = false;
  let round = 0;

  for (; round < maxRounds; round += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await waitForDeltaSettle(page, roundBudgetMs, Math.min(100, roundBudgetMs || 100));
    const html = await page.content().catch(() => '');
    const hash = sha256(html);
    if (previousHash !== undefined) {
      if (hash !== previousHash) {
        newContentDetected = true;
        stableRounds = 0;
      } else {
        stableRounds += 1;
        if (stableRounds >= stableRoundsRequired) {
          return { rounds: round + 1, stableRounds, timedOut: false, newContentDetected };
        }
      }
    }
    previousHash = hash;
  }

  return { rounds: round, stableRounds, timedOut: true, newContentDetected };
}

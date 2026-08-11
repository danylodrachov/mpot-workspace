// CD-N07: single source of truth for every bounded time budget in the snapshot-engine crawl
// pipeline. Every module that previously hard-coded its own timeout constant now derives its
// default from here, so a synthetic hang at ANY layer (navigation, settle, response-body scan,
// network-observer flush, source-family discovery, one interaction action, a controlled-scroll
// round, the whole interaction-expansion pass for a page, the whole page-processing step, an
// LLM JSON build, or simple lack of overall progress) is bounded by a documented, overridable
// default rather than an ad-hoc magic number buried in the module that happens to need it.
//
// Every budget here is a *ceiling* on a best-effort operation, never a target duration: an
// operation that finishes sooner returns immediately, and an operation that blows through its
// budget is abandoned (never awaited to completion) and recorded as a typed timeout — never
// silently treated as success. See TimeoutStage/TimeoutEventRecord in types.ts for the paired
// typed-event shape every timeout call site should emit.

export interface RuntimeBudgets {
  /** Bounded Playwright `page.goto()` wait. */
  navigationTimeoutMs: number;
  /** Bounded, best-effort DOM/readyState settle-poll budget after navigation succeeds. */
  pageSettleMs: number;
  /** Bounded wait for one network response body to resolve during passive discovery scanning. */
  responseBodyScanTimeoutMs: number;
  /** Bounded wait for in-flight passive network-observer response-body scans to drain. */
  networkObserverFlushTimeoutMs: number;
  /** Bounded wait for one source-family discovery operation (e.g. one discoverFromPage() pass). */
  sourceFamilyDiscoveryTimeoutMs: number;
  /** Bounded wait for one interaction action (trial + real action) plus its delta-settle. */
  interactionActionTimeoutMs: number;
  /** Bounded wait for one controlled-scroll round (scroll + delta-settle) during lazy-load probing. */
  controlledScrollRoundTimeoutMs: number;
  /** Bounded wait for the WHOLE interaction-expansion pass (all candidates + lazy-scroll) on one page. */
  interactionExpansionTimeoutMs: number;
  /** Bounded wait for the WHOLE page-processing step (navigation, settle, profiling, interaction). */
  pageProcessingTimeoutMs: number;
  /**
   * Bounded wait for one LLM JSON-build call (CD-N06). No LLM adapter module exists in this repo
   * yet — this budget/key is reserved now so CD-N06 has a single place to read its deadline from
   * instead of inventing a new constant when that module lands.
   */
  llmJsonBuildTimeoutMs: number;
  /** If no stage/page/action progress is observed for this long, the run watchdog fires. */
  noProgressWatchdogMs: number;
}

export const DEFAULT_RUNTIME_BUDGETS: Readonly<RuntimeBudgets> = Object.freeze({
  navigationTimeoutMs: 30_000,
  pageSettleMs: 15_000,
  responseBodyScanTimeoutMs: 5_000,
  networkObserverFlushTimeoutMs: 10_000,
  sourceFamilyDiscoveryTimeoutMs: 15_000,
  interactionActionTimeoutMs: 10_000,
  controlledScrollRoundTimeoutMs: 5_000,
  interactionExpansionTimeoutMs: 60_000,
  pageProcessingTimeoutMs: 90_000,
  llmJsonBuildTimeoutMs: 15 * 60_000,
  noProgressWatchdogMs: 120_000,
});

export type RuntimeBudgetOverrides = Partial<RuntimeBudgets>;

export function resolveRuntimeBudgets(overrides: RuntimeBudgetOverrides = {}): RuntimeBudgets {
  const resolved: RuntimeBudgets = { ...DEFAULT_RUNTIME_BUDGETS };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof RuntimeBudgets, number | undefined]>) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid runtime budget override for ${key}: ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

// CLI flag name -> RuntimeBudgets key. Single mapping table so cli.ts's --flag parsing and this
// module's override resolution can never drift out of sync with each other.
export const RUNTIME_BUDGET_CLI_FLAGS: Readonly<Record<string, keyof RuntimeBudgets>> = Object.freeze({
  'navigation-timeout-ms': 'navigationTimeoutMs',
  'settle-ms': 'pageSettleMs',
  'response-body-scan-timeout-ms': 'responseBodyScanTimeoutMs',
  'network-flush-timeout-ms': 'networkObserverFlushTimeoutMs',
  'source-discovery-timeout-ms': 'sourceFamilyDiscoveryTimeoutMs',
  'interaction-action-timeout-ms': 'interactionActionTimeoutMs',
  'scroll-round-timeout-ms': 'controlledScrollRoundTimeoutMs',
  'interaction-expansion-timeout-ms': 'interactionExpansionTimeoutMs',
  'page-processing-timeout-ms': 'pageProcessingTimeoutMs',
  'llm-json-build-timeout-ms': 'llmJsonBuildTimeoutMs',
  'no-progress-watchdog-ms': 'noProgressWatchdogMs',
});

/** Parses CLI-supplied `--<flag> <value>` pairs (already split into a Map by cli.ts) into
 * runtime-budget overrides, using the canonical flag table above. Throws on a non-numeric or
 * negative value so a typo'd override fails fast rather than silently falling back to a default. */
export function parseRuntimeBudgetOverridesFromArgs(values: ReadonlyMap<string, string>): RuntimeBudgetOverrides {
  const overrides: RuntimeBudgetOverrides = {};
  for (const [flag, key] of Object.entries(RUNTIME_BUDGET_CLI_FLAGS)) {
    const raw = values.get(flag);
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid value for --${flag}: ${raw}`);
    }
    overrides[key] = parsed;
  }
  return overrides;
}

// FIX-01: bounded, configurable limits for CF-02's passive network-evidence capture (same-origin
// textual xhr/fetch response bodies persisted under <runDir>/network/ and indexed in
// network-evidence.jsonl — see captureNetworkEvidence in url-discovery.ts). Kept as their own
// resolver (distinct from RuntimeBudgets above, which is exclusively time budgets) so a caller can
// override either independently; every eligible response still gets an explicit ledger record
// (captured/skipped/timeout/error) regardless of these limits — a response over either bound is
// never silently dropped.
export interface NetworkEvidenceLimits {
  /** Bounded max size, in bytes, of a single response body eligible for capture. A response whose
   *  declared or actual body size exceeds this is recorded with outcome 'skipped' and an explicit
   *  reason, never captured. */
  maxBodyBytes: number;
  /** Bounded max number of 'captured' network-evidence records recorded per page visit. Once a
   *  page's captured-record count reaches this limit, further eligible responses on that same
   *  page are recorded with outcome 'skipped' and an explicit reason instead of being captured. */
  maxRecordsPerPage: number;
}

export const DEFAULT_NETWORK_EVIDENCE_LIMITS: Readonly<NetworkEvidenceLimits> = Object.freeze({
  maxBodyBytes: 10 * 1024 * 1024,
  maxRecordsPerPage: 200,
});

export type NetworkEvidenceLimitOverrides = Partial<NetworkEvidenceLimits>;

export function resolveNetworkEvidenceLimits(overrides: NetworkEvidenceLimitOverrides = {}): NetworkEvidenceLimits {
  const resolved: NetworkEvidenceLimits = { ...DEFAULT_NETWORK_EVIDENCE_LIMITS };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof NetworkEvidenceLimits, number | undefined]>) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid network evidence limit override for ${key}: ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

// FIX-03: bounded_reveal action-count budgets — deliberately separate from RuntimeBudgets above
// (those are all time budgets; these are action-count ceilings). Enforced by bounded-reveal.ts:
// `maxActionsPerPage` bounds the total number of real actions executed against one page across
// every adapter combined; `maxActionsPerAdapter` additionally bounds how many actions any single
// adapter class (e.g. load_more) may run on that same page, so one chatty adapter can never
// consume the whole per-page budget by itself.
export interface BoundedRevealBudgets {
  maxActionsPerPage: number;
  maxActionsPerAdapter: number;
}

export const DEFAULT_BOUNDED_REVEAL_BUDGETS: Readonly<BoundedRevealBudgets> = Object.freeze({
  maxActionsPerPage: 20,
  maxActionsPerAdapter: 6,
});

export type BoundedRevealBudgetOverrides = Partial<BoundedRevealBudgets>;

export function resolveBoundedRevealBudgets(overrides: BoundedRevealBudgetOverrides = {}): BoundedRevealBudgets {
  const resolved: BoundedRevealBudgets = { ...DEFAULT_BOUNDED_REVEAL_BUDGETS };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof BoundedRevealBudgets, number | undefined]>) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid bounded_reveal budget override for ${key}: ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

export class NoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProgressError';
  }
}

/**
 * CD-N07 no-progress watchdog. A caller `touch()`es this on every observed stage/page/action
 * progress event (page attempted, page completed, a discovery batch finished, an interaction
 * candidate resolved, ...). If `budgetMs` elapses with no `touch()` call, `whenTriggered` rejects
 * so a caller racing it against the current bounded operation can abandon that operation and
 * advance/finalize partial state — it never blocks terminal run completion by itself (the
 * returned promise is only ever consumed via Promise.race, never awaited standalone).
 */
export class ProgressWatchdog {
  // Plain field assignment, not a constructor parameter property: this module runs under
  // node --experimental-strip-types, which rejects TypeScript parameter properties.
  private readonly budgetMs: number;
  private lastProgressAt = Date.now();
  private timer?: ReturnType<typeof setTimeout>;
  private triggered = false;
  private rejectFn?: (error: Error) => void;
  private readonly promise: Promise<never>;

  constructor(budgetMs: number) {
    this.budgetMs = budgetMs;
    this.promise = new Promise<never>((_, reject) => {
      this.rejectFn = reject;
    });
    // Never let an unresolved rejection produce an unhandled-rejection warning before anything
    // actually races it (e.g. a run that finishes/stops before the watchdog ever fires).
    this.promise.catch(() => {});
  }

  touch(): void {
    this.lastProgressAt = Date.now();
  }

  get hasTriggered(): boolean {
    return this.triggered;
  }

  /** Promise that rejects with NoProgressError once `budgetMs` passes with no `touch()` call.
   * Intended for use only inside Promise.race with the operation currently in flight. */
  get whenTriggered(): Promise<never> {
    return this.promise;
  }

  start(): void {
    if (this.budgetMs <= 0 || this.triggered) return;
    const check = (): void => {
      if (this.triggered) return;
      const idleMs = Date.now() - this.lastProgressAt;
      if (idleMs >= this.budgetMs) {
        this.triggered = true;
        this.rejectFn?.(new NoProgressError(`No stage/page/action progress observed for ${this.budgetMs}ms`));
        return;
      }
      this.timer = setTimeout(check, Math.max(50, this.budgetMs - idleMs));
    };
    this.timer = setTimeout(check, this.budgetMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RUNTIME_BUDGETS,
  resolveRuntimeBudgets,
  parseRuntimeBudgetOverridesFromArgs,
  ProgressWatchdog,
  NoProgressError,
} from './runtime-config.ts';

// CD-N07: centralized runtime-budget defaults, matching the ticket's documented values exactly —
// a drift here would silently change every module that derives its own timeout from these.

test('DEFAULT_RUNTIME_BUDGETS matches the CD-N07 documented defaults', () => {
  assert.deepEqual(DEFAULT_RUNTIME_BUDGETS, {
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
});

test('resolveRuntimeBudgets: no overrides returns the defaults unchanged', () => {
  const resolved = resolveRuntimeBudgets();
  assert.deepEqual(resolved, DEFAULT_RUNTIME_BUDGETS);
});

test('resolveRuntimeBudgets: an override replaces only its own key, every other budget keeps its default', () => {
  const resolved = resolveRuntimeBudgets({ pageProcessingTimeoutMs: 12_345 });
  assert.equal(resolved.pageProcessingTimeoutMs, 12_345);
  assert.equal(resolved.navigationTimeoutMs, DEFAULT_RUNTIME_BUDGETS.navigationTimeoutMs);
  assert.equal(resolved.noProgressWatchdogMs, DEFAULT_RUNTIME_BUDGETS.noProgressWatchdogMs);
});

test('resolveRuntimeBudgets: rejects a negative override rather than silently accepting it', () => {
  assert.throws(() => resolveRuntimeBudgets({ navigationTimeoutMs: -1 }), /Invalid runtime budget override/);
});

test('parseRuntimeBudgetOverridesFromArgs: maps every documented CLI flag to its budget key', () => {
  const values = new Map<string, string>([
    ['navigation-timeout-ms', '1111'],
    ['settle-ms', '2222'],
    ['response-body-scan-timeout-ms', '3333'],
    ['network-flush-timeout-ms', '4444'],
    ['source-discovery-timeout-ms', '5555'],
    ['interaction-action-timeout-ms', '6666'],
    ['scroll-round-timeout-ms', '7777'],
    ['interaction-expansion-timeout-ms', '8888'],
    ['page-processing-timeout-ms', '9999'],
    ['llm-json-build-timeout-ms', '11111'],
    ['no-progress-watchdog-ms', '22222'],
  ]);
  const overrides = parseRuntimeBudgetOverridesFromArgs(values);
  assert.deepEqual(overrides, {
    navigationTimeoutMs: 1111,
    pageSettleMs: 2222,
    responseBodyScanTimeoutMs: 3333,
    networkObserverFlushTimeoutMs: 4444,
    sourceFamilyDiscoveryTimeoutMs: 5555,
    interactionActionTimeoutMs: 6666,
    controlledScrollRoundTimeoutMs: 7777,
    interactionExpansionTimeoutMs: 8888,
    pageProcessingTimeoutMs: 9999,
    llmJsonBuildTimeoutMs: 11111,
    noProgressWatchdogMs: 22222,
  });
});

test('parseRuntimeBudgetOverridesFromArgs: an unrecognized flag is simply absent, never guessed at', () => {
  const overrides = parseRuntimeBudgetOverridesFromArgs(new Map([['navigation-timeout-ms', '500']]));
  assert.deepEqual(overrides, { navigationTimeoutMs: 500 });
});

test('parseRuntimeBudgetOverridesFromArgs: throws on a non-numeric value instead of silently falling back to the default', () => {
  assert.throws(
    () => parseRuntimeBudgetOverridesFromArgs(new Map([['navigation-timeout-ms', 'not-a-number']])),
    /Invalid value for --navigation-timeout-ms/,
  );
});

// --- ProgressWatchdog: fake/small timers only, never a real multi-second sleep. ---

test('ProgressWatchdog: whenTriggered never rejects before its budget elapses while touch() keeps resetting it', async () => {
  const watchdog = new ProgressWatchdog(30);
  watchdog.start();
  let touchCount = 0;
  const interval = setInterval(() => {
    touchCount += 1;
    watchdog.touch();
  }, 10);
  try {
    await Promise.race([
      watchdog.whenTriggered,
      new Promise((resolve) => setTimeout(resolve, 80)),
    ]);
    assert.equal(watchdog.hasTriggered, false, 'continuous touch() calls must keep the watchdog from firing');
    assert.ok(touchCount >= 2, 'expected the touch interval to have fired at least twice in the observation window');
  } finally {
    clearInterval(interval);
    watchdog.stop();
  }
});

test('ProgressWatchdog: whenTriggered rejects with NoProgressError once the budget elapses with no touch()', async () => {
  const watchdog = new ProgressWatchdog(20);
  watchdog.start();
  try {
    await assert.rejects(watchdog.whenTriggered, (error: unknown) => {
      assert.ok(error instanceof NoProgressError);
      return true;
    });
    assert.equal(watchdog.hasTriggered, true);
  } finally {
    watchdog.stop();
  }
});

test('ProgressWatchdog: a budget of 0 never starts (never fires), reserved as an explicit opt-out', async () => {
  const watchdog = new ProgressWatchdog(0);
  watchdog.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(watchdog.hasTriggered, false);
  watchdog.stop();
});

test('ProgressWatchdog: stop() prevents a pending timer from ever firing after the caller is done with it', async () => {
  const watchdog = new ProgressWatchdog(15);
  watchdog.start();
  watchdog.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(watchdog.hasTriggered, false, 'stop() must cancel the underlying timer, not just ignore its effect');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// The snapshot crawl is passive by contract: it may navigate and read, but it must
// never activate a page element. A regression here would make the saved trace claim
// post-action behaviour the run never observed.
//
// CD-N04 sanctioned exception: interaction-delta-profiler.ts is the one module allowed to
// perform a real, bounded, deterministic interaction (see its own module docstring) — a trace
// candidate alone still never becomes extracted evidence there; only a measured before/after
// delta can produce a 'revealed_evidence' outcome. It is excluded from the blanket scan below and
// instead covered by its own safety-contract assertions further down this file.
const INTERACTION_EXECUTION_MODULE = 'interaction-delta-profiler.ts';
// FIX-03 sanctioned exception: bounded-reveal.ts is the SECOND (and only other) module allowed to
// perform a real interaction — strictly the small allowlisted bounded_reveal adapter set (tab,
// accordion/disclosure, native select enumeration, combobox/listbox open, load-more), gated by its
// own isSafeToExecute() hard filter. Covered by its own safety-contract assertions below.
const BOUNDED_REVEAL_MODULE = 'bounded-reveal.ts';

const engineDir = import.meta.dirname;
const sources = fs
  .readdirSync(engineDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => ({ file, text: fs.readFileSync(path.join(engineDir, file), 'utf-8') }));

const passiveOnlySources = sources.filter(
  (source) => source.file !== INTERACTION_EXECUTION_MODULE && source.file !== BOUNDED_REVEAL_MODULE,
);

test('no snapshot-engine module performs a page-element interaction (except the sanctioned CD-N04 interaction-delta-profiler)', () => {
  const forbidden = [
    /\.click\s*\(/,
    /\.dblclick\s*\(/,
    /\.hover\s*\(/,
    /\.tap\s*\(/,
    /\.fill\s*\(/,
    /(?<!dialog)\.type\s*\(/, // dialog.type() reads the native dialog kind; it activates nothing
    /\.press\s*\(/,
    /\.selectOption\s*\(/,
    /\.check\s*\(/,
    /\.uncheck\s*\(/,
    /\.setInputFiles\s*\(/,
    /\.dragTo\s*\(/,
    /\.focus\s*\(/,
    /\.scrollIntoViewIfNeeded\s*\(/,
    /mouse\.\w+\s*\(/,
    /keyboard\.\w+\s*\(/,
  ];
  for (const { file, text } of passiveOnlySources) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${file} must not call ${pattern.source} — the crawl is passive-only`);
    }
  }
});

test('automatic dialogs are only dismissed, never accepted', () => {
  for (const { file, text } of sources) {
    assert.ok(!/dialog\.accept\s*\(/.test(text), `${file} must not accept native dialogs`);
  }
  const capture = sources.find((source) => source.file === 'page-capture.ts')?.text ?? '';
  assert.match(capture, /autoDismissedForCrawl/, 'auto-dismissed dialogs must be marked in the trace');
});

test('the crawler never closes the attached authenticated browser', () => {
  for (const { file, text } of sources) {
    assert.ok(!/browser\.close\s*\(/.test(text), `${file} must not close the user's attached Chrome`);
  }
});

// CD-N04: the sanctioned interaction module is still held to its own hard safety contract, even
// though it is allowed to call .click(). These checks are text-level guards against the specific
// regressions this ticket calls out (blindly clicking custom_pointer_control noise, executing
// transaction/account/game-launch actions, hostname-specific logic).
test('CD-N04: interaction-delta-profiler.ts never treats a bare custom_pointer_control hint as an executable action class', () => {
  const text = sources.find((source) => source.file === INTERACTION_EXECUTION_MODULE)?.text ?? '';
  assert.ok(text.length > 0, `${INTERACTION_EXECUTION_MODULE} must exist`);
  assert.ok(
    !text.includes("hints.has('custom_pointer_control')"),
    'custom_pointer_control must never be directly promoted to an executable action class',
  );
});

test('CD-N04: interaction-delta-profiler.ts excludes cookie/account/game-launch/transaction candidates from automatic execution', () => {
  const text = sources.find((source) => source.file === INTERACTION_EXECUTION_MODULE)?.text ?? '';
  for (const marker of ['COOKIE_PATTERN', 'ACCOUNT_PATTERN', 'GAME_LAUNCH_PATTERN', 'TRANSACTION_PATTERN']) {
    assert.match(text, new RegExp(marker), `${INTERACTION_EXECUTION_MODULE} must define ${marker} exclusion evidence`);
  }
});

test('CD-N04: no detector or action recipe in interaction-delta-profiler.ts depends on a casino hostname or framework-specific component name', () => {
  const text = sources.find((source) => source.file === INTERACTION_EXECUTION_MODULE)?.text ?? '';
  const forbiddenNameFragments = [/react/i, /angular/i, /\bvue\b/i, /bootstrap/i, /\.casino\b/i];
  for (const pattern of forbiddenNameFragments) {
    assert.ok(!pattern.test(text), `${INTERACTION_EXECUTION_MODULE} must not encode framework-specific detection for ${pattern.source}`);
  }
});

// FIX-03: bounded-reveal.ts is held to its own hard safety contract, even though it is allowed to
// call .click(). Text-level guards against the specific regressions FIX-03 calls out: no arbitrary
// custom-button clicking, transactional/credential/KYC/payment candidates always excluded, no
// hostname-specific logic.
test('FIX-03: bounded-reveal.ts defines the hard isSafeToExecute() gate and its exclusion patterns', () => {
  const text = sources.find((source) => source.file === BOUNDED_REVEAL_MODULE)?.text ?? '';
  assert.ok(text.length > 0, `${BOUNDED_REVEAL_MODULE} must exist`);
  assert.match(text, /export function isSafeToExecute/);
  for (const marker of ['FORM_SUBMISSION_PATTERN', 'TRANSACTIONAL_ACTION_PATTERN', 'CREDENTIAL_KYC_PAYMENT_PATTERN']) {
    assert.match(text, new RegExp(marker), `${BOUNDED_REVEAL_MODULE} must define ${marker} exclusion evidence`);
  }
});

test('FIX-03: bounded-reveal.ts never treats a bare custom_pointer_control hint as an executable adapter class', () => {
  const text = sources.find((source) => source.file === BOUNDED_REVEAL_MODULE)?.text ?? '';
  assert.ok(!text.includes("hints.has('custom_pointer_control')"));
});

test('FIX-03: bounded-reveal.ts does not implement modal_trigger/payment_method_card/pagination adapters (out of scope for bounded_reveal)', () => {
  const text = sources.find((source) => source.file === BOUNDED_REVEAL_MODULE)?.text ?? '';
  assert.ok(!/return\s+'modal_trigger'/.test(text));
  assert.ok(!/return\s+'payment_method_card'/.test(text));
  assert.ok(!/return\s+'pagination'/.test(text));
});

test('FIX-03: no detector or action recipe in bounded-reveal.ts depends on a casino hostname or framework-specific component name', () => {
  const text = sources.find((source) => source.file === BOUNDED_REVEAL_MODULE)?.text ?? '';
  const forbiddenNameFragments = [/react/i, /angular/i, /\bvue\b/i, /bootstrap/i, /\.casino\b/i];
  for (const pattern of forbiddenNameFragments) {
    assert.ok(!pattern.test(text), `${BOUNDED_REVEAL_MODULE} must not encode framework-specific detection for ${pattern.source}`);
  }
});

// Guard the runtime loader contract: the engine must load under
// node --experimental-strip-types (no enums, namespaces, or parameter properties).
test('every snapshot-engine module loads under type stripping', async () => {
  for (const { file } of sources) {
    await import(new URL(`./${file}`, import.meta.url).href);
  }
});

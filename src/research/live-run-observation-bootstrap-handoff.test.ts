import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { initializeRun } from './discovery-orchestrator.ts';
import { stageDispatcher, MissingObservationSourceError } from './stage-dispatcher.ts';
import type { PageObservation } from './url-map-recon/types.ts';

/**
 * Test: Live run observation bootstrap and handoff (Issue 32) — black-box, against the
 * real production seams (`initializeRun`, `stageDispatcher`), never a reimplementation.
 */

function writeFixtures(inputDir: string) {
  const template = {
    casinos: { name: 'Casinos', operator_fields: [], fields: { url: { type: 'url' } } },
    sports: { name: 'Sports', operator_fields: [], fields: { url: { type: 'url' } } },
    deposits: { name: 'Deposits', operator_fields: [], fields: { method: { type: 'text' } } },
    support: { name: 'Support', operator_fields: [], fields: { email: { type: 'email' } } },
    legal: { name: 'Legal', operator_fields: [], fields: { license_number: { type: 'text' } } },
    bonuses: { name: 'Bonuses', operator_fields: [], fields: { bonus_type: { type: 'text' } } },
    withdrawals: { name: 'Withdrawals', operator_fields: [], fields: { method: { type: 'text' } } },
    'live-casino': { name: 'Live Casino', operator_fields: [], fields: { url: { type: 'url' } } },
    slots: { name: 'Slots', operator_fields: [], fields: { url: { type: 'url' } } },
    'responsible-gaming': { name: 'Responsible Gaming', operator_fields: [], fields: { url: { type: 'url' } } },
    betting: { name: 'Betting', operator_fields: [], fields: { country: { type: 'text' } } },
  };
  const dropdowns = { countries: { canonical: 'GB' }, licenses: { canonical: 'MGA' } };
  writeFileSync(path.join(inputDir, 'template.json'), JSON.stringify(template));
  writeFileSync(path.join(inputDir, 'dropdowns.json'), JSON.stringify(dropdowns));
  writeFileSync(path.join(inputDir, 'extraction-rules.json'), JSON.stringify({ rules: [] }));
  writeFileSync(path.join(inputDir, 'url-rules.json'), JSON.stringify({ rules: [] }));
  return {
    template_path: path.join(inputDir, 'template.json'),
    extraction_rules_path: path.join(inputDir, 'extraction-rules.json'),
    url_rules_path: path.join(inputDir, 'url-rules.json'),
  };
}

test('Issue 32 AC1: bootstrap creates a run directory and run-context.json without dispatching any stage', async () => {
  const inputDir = mkdtempSync('/tmp/bootstrap-inputs-');
  const baseDir = mkdtempSync('/tmp/bootstrap-run-');
  try {
    const fixtures = writeFixtures(inputDir);
    const result = await initializeRun({
      baseDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'bootstrap-run-1',
      ...fixtures,
    });

    assert.ok(existsSync(path.join(result.run_dir, 'run-context.json')), 'run-context.json exists');
    assert.equal(result.canonical_origin, 'https://example-casino.com', 'canonical_origin returned to caller');
    assert.ok(result.run_dir.length > 0, 'run_dir path returned to caller');

    // No stage ran: only the run_started trace event exists, no stage artifacts.
    assert.ok(!existsSync(path.join(result.run_dir, 'raw-url-candidates.json')), 'stage 1 did not run');
    const traceEvents = readFileSync(path.join(result.run_dir, 'trace-events.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.equal(traceEvents.length, 1, 'only the run_started event was written');
    assert.equal(traceEvents[0].action, 'run_started');
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Issue 32 AC2/AC7: stageDispatcher attaches to an existing bootstrapped run and picks up observations written into it', async () => {
  const inputDir = mkdtempSync('/tmp/attach-inputs-');
  const baseDir = mkdtempSync('/tmp/attach-run-');
  try {
    const fixtures = writeFixtures(inputDir);

    // Bootstrap phase: mint the run directory before any observation exists.
    const bootstrap = await initializeRun({
      baseDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'attach-run-1',
      ...fixtures,
    });

    // Simulate a browser agent writing page-observations.jsonl into the bootstrapped
    // run directory using its output_dir (never a synthetic path).
    const observations: PageObservation[] = [
      {
        observation_id: 'obs-1-dom-urls',
        extractor_id: 'DOM_URL_ATTRIBUTES_V1',
        page_url: 'https://example-casino.com/en/lobby',
        status: 'present',
        content_type: 'html',
        content: '<a href="/sports">Sports</a><a href="/support">Support</a>',
        timestamp: new Date().toISOString(),
      },
    ];
    const observationsPath = path.join(bootstrap.run_dir, 'page-observations.jsonl');
    writeFileSync(observationsPath, observations.map((o) => JSON.stringify(o)).join('\n') + '\n');

    // Attach phase: dispatch into the existing run directory instead of minting a new one.
    const result = await stageDispatcher({
      baseDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'attach-run-1',
      ...fixtures,
      existingRunDir: bootstrap.run_dir,
      observationsPath,
    });

    assert.equal(result.run_dir, bootstrap.run_dir, 'dispatch attached to the bootstrapped run directory, not a second one');
    assert.equal(result.run_id, bootstrap.run_id, 'attached run keeps the bootstrapped run_id');

    // Observations written into the bootstrapped dir were picked up end to end.
    assert.ok(existsSync(path.join(result.run_dir, 'raw-url-candidates.json')), 'stage 1 ran against the attached run');
    const candidates = JSON.parse(readFileSync(path.join(result.run_dir, 'raw-url-candidates.json'), 'utf-8'));
    assert.ok(Array.isArray(candidates) && candidates.length > 0, 'candidates extracted from the observations written into the run dir');

    // Only one run_started event exists: attach must not re-bootstrap.
    const traceEvents = readFileSync(path.join(result.run_dir, 'trace-events.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const runStartedEvents = traceEvents.filter((e) => e.action === 'run_started');
    assert.equal(runStartedEvents.length, 1, 'attach did not mint a second run');
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Issue 32 AC3: stageDispatcher with no existingRunDir still mints a new run exactly as before', async () => {
  const inputDir = mkdtempSync('/tmp/mint-inputs-');
  const baseDir = mkdtempSync('/tmp/mint-run-');
  try {
    const fixtures = writeFixtures(inputDir);
    const result = await stageDispatcher({
      baseDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'mint-run-1',
      ...fixtures,
      inputProvider: () => ({
        pageUrl: 'https://example-casino.com/en/lobby',
        html: '<a href="/sports">Sports</a>',
      }),
    });

    assert.ok(existsSync(path.join(result.run_dir, 'run-context.json')), 'a new run directory was minted with run-context.json');
    assert.equal(result.run_id, 'mint-run-1');
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Issue 32 AC4/AC6: dispatch with no observation source refuses to start; --observations-path bypasses agent invocation', async () => {
  const inputDir = mkdtempSync('/tmp/noinput-inputs-');
  const baseDir = mkdtempSync('/tmp/noinput-run-');
  try {
    const fixtures = writeFixtures(inputDir);

    await assert.rejects(
      () =>
        stageDispatcher({
          baseDir,
          casino_url: 'https://example-casino.com',
          geo: 'GB',
          run_id: 'noinput-run-1',
          ...fixtures,
        }),
      (err: unknown) => {
        assert.ok(err instanceof MissingObservationSourceError, 'typed MissingObservationSourceError thrown');
        assert.equal((err as MissingObservationSourceError).code, 'MISSING_OBSERVATION_SOURCE');
        return true;
      },
    );

    // Nothing was created: no run directory reported as if work happened.
    assert.ok(!existsSync(path.join(baseDir, 'example_casino_com')), 'no run directory minted for the refused dispatch');

    // AC6: an explicit observationsPath is sufficient on its own (no other provider needed).
    const observations: PageObservation[] = [
      {
        observation_id: 'obs-1',
        extractor_id: 'DOM_URL_ATTRIBUTES_V1',
        page_url: 'https://example-casino.com/en/lobby',
        status: 'present',
        content_type: 'html',
        content: '<a href="/support">Support</a>',
        timestamp: new Date().toISOString(),
      },
    ];
    const obsPath = path.join(baseDir, 'page-observations.jsonl');
    writeFileSync(obsPath, observations.map((o) => JSON.stringify(o)).join('\n') + '\n');

    const result = await stageDispatcher({
      baseDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'noinput-run-2',
      ...fixtures,
      observationsPath: obsPath,
    });
    assert.ok(existsSync(path.join(result.run_dir, 'raw-url-candidates.json')), 'observationsPath alone drove stage 1');
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

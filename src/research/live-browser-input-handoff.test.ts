import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageDispatcher } from './stage-dispatcher.ts';
import type { RunContext } from './discovery-orchestrator.ts';
import type { PageObservation } from './url-map-recon/types.ts';

/**
 * Test: Live browser input handoff (Issue 24) — exercises the real production seam.
 *
 * This is a black-box test of `stageDispatcher`'s `observationsPath` option, not a
 * reimplementation of the observation contract: it writes a `page-observations.jsonl`
 * file the way a browser agent would, points `stageDispatcher` at it, and inspects
 * what the run itself wrote. `observation-provider.ts` (the module actually converting
 * observations into stage input) is never imported directly — proving the seam works
 * end-to-end through the same entry point a live run would use.
 */

test('Issue 24 AC: Live browser input handoff contract and replay', async () => {
  const inputDir = mkdtempSync('/tmp/live-browser-inputs-');

  try {
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

    // A browser agent's handoff: observations for the one recipe step stage 1 runs
    // (see stage-dispatcher.ts case 1), plus one deliberately blocked observation for
    // a source the agent could not reach behind an auth gate.
    const observations: PageObservation[] = [
      {
        observation_id: 'obs-1-dom-urls',
        extractor_id: 'DOM_URL_ATTRIBUTES_V1',
        page_url: 'https://example-casino.com/en/lobby',
        status: 'present',
        content_type: 'html',
        content:
          '<a href="/account">Account</a><a href="/sports">Sports</a><a href="/slots">Slots</a><a href="/live-casino">Live Casino</a><a href="/support">Support</a>',
        timestamp: new Date().toISOString(),
      },
      {
        observation_id: 'obs-2-frame-blocked',
        extractor_id: 'FRAME_FORM_URLS_V1',
        page_url: 'https://example-casino.com/en/lobby',
        status: 'blocked',
        content_type: 'text',
        reason: 'login_required: Page behind authentication gate',
        timestamp: new Date().toISOString(),
      },
    ];

    async function runWithObservations(runId: string) {
      const runOutputDir = mkdtempSync('/tmp/live-browser-run-output-');
      const observationsPath = path.join(runOutputDir, 'page-observations.jsonl');
      writeFileSync(observationsPath, observations.map((obs) => JSON.stringify(obs)).join('\n') + '\n');

      const result = await stageDispatcher({
        baseDir: runOutputDir,
        casino_url: 'https://example-casino.com',
        geo: 'GB',
        run_id: runId,
        template_path: path.join(inputDir, 'template.json'),
        extraction_rules_path: path.join(inputDir, 'extraction-rules.json'),
        url_rules_path: path.join(inputDir, 'url-rules.json'),
        observationsPath,
      });

      // Reaching the stage-6 gate is stage 1-5's own success signal (it only fires once
      // field-requirements.json and clean-url-inventory.json exist on disk) — both outcome
      // shapes carry `run_dir`, so nothing past this point needs to branch on it.
      return { result, observationsPath, runOutputDir };
    }

    // Step 1: drive a run purely from recorded observations (no inputProvider supplied).
    const run1 = await runWithObservations('test-run-1');

    assert.ok(existsSync(path.join(run1.result.run_dir, 'raw-url-candidates.json')), 'raw-url-candidates.json exists');
    assert.ok(existsSync(path.join(run1.result.run_dir, 'clean-url-inventory.json')), 'clean-url-inventory.json exists');
    assert.ok(existsSync(path.join(run1.result.run_dir, 'field-requirements.json')), 'field-requirements.json exists');

    const candidates1 = JSON.parse(readFileSync(path.join(run1.result.run_dir, 'raw-url-candidates.json'), 'utf-8'));
    assert.ok(Array.isArray(candidates1) && candidates1.length > 0, 'candidates extracted from observation content, not fabricated');

    // AC8: the run records which provider produced its observations.
    const runContextPath = path.join(run1.result.run_dir, 'run-context.json');
    assert.ok(existsSync(runContextPath), 'run-context.json exists');
    const runContext1 = JSON.parse(readFileSync(runContextPath, 'utf-8')) as RunContext;
    assert.equal(runContext1.observation_provider?.provider_type, 'live_browser', 'run context records live_browser provider');
    assert.equal(runContext1.observation_provider?.observations_path, run1.observationsPath, 'run context records the observations file used');

    // AC5: the blocked observation exists with its status and reason preserved verbatim
    // in the observation artifact the agent wrote — never silently dropped or faked as present.
    const writtenObs = readFileSync(run1.observationsPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PageObservation);
    const blocked = writtenObs.find((obs) => obs.status === 'blocked');
    assert.ok(blocked, 'blocked observation present in the observation artifact');
    assert.equal(blocked!.reason, 'login_required: Page behind authentication gate');

    // AC4/AC: the run continued past the blocked observation instead of halting.
    const traceEvents1 = readFileSync(path.join(run1.result.run_dir, 'trace-events.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const stageStatuses1: Record<number, string> = {};
    for (const event of traceEvents1) {
      if (event.stage && event.action === 'stage_visited') stageStatuses1[event.stage] = event.status;
    }
    for (const stage of [1, 2, 3, 4, 5]) {
      assert.equal(stageStatuses1[stage], 'completed', `stage ${stage} completed despite one blocked observation`);
    }

    // AC7: replaying the same recorded observations produces identical artifacts.
    const run2 = await runWithObservations('test-run-2');
    const candidates2 = readFileSync(path.join(run2.result.run_dir, 'raw-url-candidates.json'), 'utf-8');
    const candidates1Raw = readFileSync(path.join(run1.result.run_dir, 'raw-url-candidates.json'), 'utf-8');
    assert.equal(candidates1Raw, candidates2, 'raw-url-candidates.json identical on replay');

    const cleaned1 = readFileSync(path.join(run1.result.run_dir, 'clean-url-inventory.json'), 'utf-8');
    const cleaned2 = readFileSync(path.join(run2.result.run_dir, 'clean-url-inventory.json'), 'utf-8');
    assert.equal(cleaned1, cleaned2, 'clean-url-inventory.json identical on replay');

    const reqs1 = readFileSync(path.join(run1.result.run_dir, 'field-requirements.json'), 'utf-8');
    const reqs2 = readFileSync(path.join(run2.result.run_dir, 'field-requirements.json'), 'utf-8');
    assert.equal(reqs1, reqs2, 'field-requirements.json identical on replay');

    // AC1: a fixture-backed run (explicit inputProvider, no observationsPath) takes a
    // different code path and records a different (or absent) provider — proving stage
    // modules themselves are unmodified by which provider is behind the seam.
    const fixtureRunDir = mkdtempSync('/tmp/live-browser-fixture-run-');
    const fixtureResult = await stageDispatcher({
      baseDir: fixtureRunDir,
      casino_url: 'https://example-casino.com',
      geo: 'GB',
      run_id: 'test-run-fixture',
      template_path: path.join(inputDir, 'template.json'),
      extraction_rules_path: path.join(inputDir, 'extraction-rules.json'),
      url_rules_path: path.join(inputDir, 'url-rules.json'),
      inputProvider: () => ({
        pageUrl: 'https://example-casino.com/en/lobby',
        html: '<a href="/sports">Sports</a>',
      }),
    });
    const fixtureRunContext = JSON.parse(
      readFileSync(path.join(fixtureResult.run_dir, 'run-context.json'), 'utf-8'),
    ) as RunContext;
    assert.equal(fixtureRunContext.observation_provider, undefined, 'fixture run with no observationsPath records no observation_provider');

    rmSync(inputDir, { recursive: true });
    rmSync(run1.runOutputDir, { recursive: true });
    rmSync(run2.runOutputDir, { recursive: true });
    rmSync(fixtureRunDir, { recursive: true });
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
  }
});

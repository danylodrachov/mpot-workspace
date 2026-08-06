import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { replayOrFallback, findReplayIncompatibilities } from './replay-fallback.ts';
import type { RecipeV1, RecipeStepV1 } from './types.ts';

const origin = 'https://example.com';
const casinoId = 'test-casino';
const geo = 'en';
const runId = 'run-001';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replay-fallback-'));
}

// DOM_URL_ATTRIBUTES_V1 currently only accepts 'html' (see EXTRACTOR_ACCEPTED_INPUT_TYPES).
// A recipe step recorded with mode 'json' is therefore stale/incompatible.
function incompatibleRecipe(): RecipeV1 {
  return {
    version: 1,
    casinoId,
    recordedAt: '2026-07-01T00:00:00Z',
    steps: [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl: 'https://example.com/',
        source: 'dom_anchor',
        resultType: 'url_list',
        recordedInputMode: 'json',
      },
    ],
  };
}

function compatibleRecipe(): RecipeV1 {
  return {
    version: 1,
    casinoId,
    recordedAt: '2026-07-01T00:00:00Z',
    steps: [
      {
        extractorId: 'DOM_URL_ATTRIBUTES_V1',
        pageUrl: 'https://example.com/',
        source: 'dom_anchor',
        resultType: 'url_list',
        recordedInputMode: 'html',
      },
    ],
  };
}

const firstPassSteps: RecipeStepV1[] = [
  {
    extractorId: 'DOM_URL_ATTRIBUTES_V1',
    pageUrl: 'https://example.com/',
    source: 'dom_anchor',
    resultType: 'url_list',
  },
];

test('findReplayIncompatibilities flags a step whose recorded mode is no longer accepted', () => {
  const incompatibilities = findReplayIncompatibilities(incompatibleRecipe());
  assert.equal(incompatibilities.length, 1);
  assert.equal(incompatibilities[0].extractorId, 'DOM_URL_ATTRIBUTES_V1');
  assert.equal(incompatibilities[0].recordedInputMode, 'json');
  assert.deepEqual(incompatibilities[0].currentAcceptedInputTypes, ['html']);
  assert.equal(incompatibilities[0].recipeId, `${casinoId}@2026-07-01T00:00:00Z`);
});

test('findReplayIncompatibilities returns nothing for a compatible recipe', () => {
  assert.deepEqual(findReplayIncompatibilities(compatibleRecipe()), []);
});

// AC: An incompatible replay recipe returns `replay_incompatible` rather than an empty successful result,
// and `replay_incompatible` selects first-pass extraction.
test('incompatible recipe returns replay_incompatible and falls back to first-pass extraction', async () => {
  const tempDir = makeTempDir();
  try {
    const html = '<a href="/bonus-terms">Bonus</a>';
    const traceEventsPath = path.join(tempDir, 'trace-events.jsonl');

    const result = await replayOrFallback({
      recipeInput: incompatibleRecipe(),
      provideInput: () => ({ pageUrl: 'https://example.com/', json: '{}' }),
      origin,
      baseDir: tempDir,
      casinoId,
      geo,
      runId,
      traceEventsPath,
      firstPassSteps,
      firstPassInputProvider: () => ({ pageUrl: 'https://example.com/', html }),
    });

    assert.equal(result.status, 'replay_incompatible');
    if (result.status === 'replay_incompatible') {
      assert.equal(result.incompatibilities.length, 1);
    }

    // First-pass extraction actually ran and persisted real candidates (not an
    // empty successful result).
    const candidatesPath = path.join(tempDir, casinoId, geo, runId, 'raw-url-candidates.json');
    const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.some((c: any) => c.url === 'https://example.com/bonus-terms'));
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// AC: A structured event is emitted on fallback with recipe ID, extractor ID, recorded
// input mode, and current accepted input types.
test('fallback emits a structured event carrying recipe id, extractor id, recorded mode, and accepted types', async () => {
  const tempDir = makeTempDir();
  try {
    const traceEventsPath = path.join(tempDir, 'trace-events.jsonl');

    await replayOrFallback({
      recipeInput: incompatibleRecipe(),
      provideInput: () => ({ pageUrl: 'https://example.com/', json: '{}' }),
      origin,
      baseDir: tempDir,
      casinoId,
      geo,
      runId,
      traceEventsPath,
      firstPassSteps,
      firstPassInputProvider: () => ({ pageUrl: 'https://example.com/', html: '<a href="/x">x</a>' }),
    });

    const lines = fs.readFileSync(traceEventsPath, 'utf-8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));
    const fallbackEvent = events.find((e) => e.action === 'replay_incompatible_fallback');
    assert.ok(fallbackEvent, 'expected a replay_incompatible_fallback event');

    const payload = JSON.parse(fallbackEvent.error);
    assert.equal(payload.recipeId, `${casinoId}@2026-07-01T00:00:00Z`);
    assert.equal(payload.extractorId, 'DOM_URL_ATTRIBUTES_V1');
    assert.equal(payload.recordedInputMode, 'json');
    assert.deepEqual(payload.currentAcceptedInputTypes, ['html']);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// AC: The prior replay artifact is unchanged on disk until first-pass extraction succeeds;
// a failed or aborted fallback leaves it intact.
test('a failed fallback leaves the prior artifact on disk untouched', async () => {
  const tempDir = makeTempDir();
  try {
    const outDir = path.join(tempDir, casinoId, geo, runId);
    fs.mkdirSync(outDir, { recursive: true });
    const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
    const sentinel = [{ url: 'https://example.com/prior-artifact', sourceFamily: 'dom_url_attributes', extractorId: 'DOM_URL_ATTRIBUTES_V1' }];
    fs.writeFileSync(candidatesPath, JSON.stringify(sentinel, null, 2));

    const traceEventsPath = path.join(tempDir, 'trace-events.jsonl');

    await assert.rejects(
      replayOrFallback({
        recipeInput: incompatibleRecipe(),
        provideInput: () => ({ pageUrl: 'https://example.com/', json: '{}' }),
        origin,
        baseDir: tempDir,
        casinoId,
        geo,
        runId,
        traceEventsPath,
        firstPassSteps,
        firstPassInputProvider: () => {
          throw new Error('simulated first-pass extraction failure');
        },
      }),
    );

    const stillOnDisk = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    assert.deepEqual(stillOnDisk, sentinel, 'prior artifact must be unchanged after a failed fallback');
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// AC: A compatible recipe still replays normally.
test('a compatible recipe replays normally without triggering fallback', async () => {
  const tempDir = makeTempDir();
  try {
    const outDir = path.join(tempDir, casinoId, geo, runId);
    fs.mkdirSync(outDir, { recursive: true });
    const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
    const sentinel = [{ url: 'https://example.com/should-not-change', sourceFamily: 'dom_url_attributes', extractorId: 'DOM_URL_ATTRIBUTES_V1' }];
    fs.writeFileSync(candidatesPath, JSON.stringify(sentinel, null, 2));

    const traceEventsPath = path.join(tempDir, 'trace-events.jsonl');
    let firstPassCalled = false;

    const result = await replayOrFallback({
      recipeInput: compatibleRecipe(),
      provideInput: () => ({ pageUrl: 'https://example.com/', html: '<a href="/replayed">Replayed</a>' }),
      origin,
      baseDir: tempDir,
      casinoId,
      geo,
      runId,
      traceEventsPath,
      firstPassSteps,
      firstPassInputProvider: () => {
        firstPassCalled = true;
        return { pageUrl: 'https://example.com/', html: '<a href="/first-pass">First pass</a>' };
      },
    });

    assert.equal(result.status, 'replayed');
    assert.equal(firstPassCalled, false, 'first-pass extraction must not run for a compatible recipe');
    assert.ok(!fs.existsSync(traceEventsPath) || fs.readFileSync(traceEventsPath, 'utf-8').trim() === '', 'no fallback event for a compatible replay');

    // Prior artifact untouched by a compatible replay path (this module doesn't persist
    // replay output itself — persistence for a successful replay is out of this issue's
    // scope; the guarantee under test is that fallback never ran).
    const stillOnDisk = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    assert.deepEqual(stillOnDisk, sentinel);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

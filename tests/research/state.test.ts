import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import {
  initRunState,
  loadRunState,
  saveRunState,
  markSurfaceCompleted,
  markExtractionCompleted,
  markResolutionCompleted,
  isSurfaceCompleted,
  isExtractionCompleted,
} from '../../src/research/state.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const testDir = path.join(projectRoot, 'tests/research/state-tmp');

test('state: initRunState creates fresh state with correct fields', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  assert.equal(state.casino, 'TestCasino', 'casino should match');
  assert.equal(state.geo, 'Norway', 'geo should match');
  assert.equal(state.phase, 'init', 'phase should start as init');
  assert(state.run_id, 'run_id should be set');
  assert.equal(typeof state.run_id, 'string', 'run_id should be string');
  assert.equal(state.completed_surfaces.length, 0, 'completed_surfaces should start empty');
  assert.equal(state.completed_extractions.length, 0, 'completed_extractions should start empty');
  assert.equal(state.completed_resolutions.length, 0, 'completed_resolutions should start empty');
});

test('state: saveRunState and loadRunState round-trip correctly', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const originalState = initRunState('TestCasino', 'Norway', testDir);
  originalState.completed_surfaces.push('surface1', 'surface2');
  originalState.completed_extractions.push('deposits:surface1');

  saveRunState(testDir, originalState);

  const loadedState = loadRunState(testDir);

  assert.equal(loadedState.casino, originalState.casino, 'casino should match');
  assert.equal(loadedState.geo, originalState.geo, 'geo should match');
  assert.equal(loadedState.run_id, originalState.run_id, 'run_id should match');
  assert.deepEqual(loadedState.completed_surfaces, originalState.completed_surfaces, 'completed_surfaces should match');
  assert.deepEqual(loadedState.completed_extractions, originalState.completed_extractions, 'completed_extractions should match');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('state: saveRunState uses atomic tmp+rename pattern (file created)', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const state = initRunState('TestCasino', 'Norway', testDir);
  saveRunState(testDir, state);

  const stateFile = path.join(testDir, 'run-state.json');
  assert(existsSync(stateFile), 'run-state.json should exist after save');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('state: markSurfaceCompleted adds to completed_surfaces', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markSurfaceCompleted(state, 'surface1');

  assert(state.completed_surfaces.includes('surface1'), 'surface should be marked completed');
  assert.equal(state.completed_surfaces.length, 1, 'should have one completed surface');
});

test('state: markSurfaceCompleted does not duplicate', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markSurfaceCompleted(state, 'surface1');
  markSurfaceCompleted(state, 'surface1'); // Try to mark again

  assert.equal(state.completed_surfaces.filter((s: any) => s === 'surface1').length, 1, 'should not duplicate');
});

test('state: markExtractionCompleted adds to completed_extractions', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markExtractionCompleted(state, 'casinos', 'surface1');

  assert(state.completed_extractions.includes('casinos:surface1'), 'extraction should be marked completed');
});

test('state: markResolutionCompleted adds to completed_resolutions', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markResolutionCompleted(state, 'casinos:license');

  assert(state.completed_resolutions.includes('casinos:license'), 'resolution should be marked completed');
});

test('state: isSurfaceCompleted returns true for completed surface', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markSurfaceCompleted(state, 'surface1');
  const result = isSurfaceCompleted(state, 'surface1');

  assert.equal(result, true, 'completed surface should return true');
});

test('state: isSurfaceCompleted returns false for non-completed surface', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  const result = isSurfaceCompleted(state, 'surface1');

  assert.equal(result, false, 'non-completed surface should return false');
});

test('state: isExtractionCompleted returns true for completed extraction', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  markExtractionCompleted(state, 'casinos', 'surface1');
  const result = isExtractionCompleted(state, 'casinos', 'surface1');

  assert.equal(result, true, 'completed extraction should return true');
});

test('state: isExtractionCompleted returns false for non-completed extraction', () => {
  const state = initRunState('TestCasino', 'Norway', testDir);

  const result = isExtractionCompleted(state, 'casinos', 'surface1');

  assert.equal(result, false, 'non-completed extraction should return false');
});

test('state: saveRunState with updated_at timestamp', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const state = initRunState('TestCasino', 'Norway', testDir);
  const beforeSave = new Date();
  saveRunState(testDir, state);
  const afterSave = new Date();

  const loaded = loadRunState(testDir);
  const updatedTime = new Date(loaded.updated_at);

  assert(updatedTime >= beforeSave && updatedTime <= afterSave, 'updated_at should be current timestamp');

  // Clean up
  rmSync(testDir, { recursive: true });
});

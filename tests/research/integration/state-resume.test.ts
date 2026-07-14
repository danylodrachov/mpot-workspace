import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initRunState,
  loadRunState,
  saveRunState,
  markSurfaceCompleted,
  isSurfaceCompleted,
} from '../../../src/research/state.ts';
import type { RunState } from '../../../src/research/types.ts';

test('integration: crash-and-resume simulated state tracking', () => {
  // Create temporary run directory
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'research-test-'));

  try {
    // Initialize fresh run state
    const initialState = initRunState('lolajack', 'norway', tempDir);
    assert.equal(initialState.casino, 'lolajack', 'casino set');
    assert.equal(initialState.geo, 'norway', 'geo set');
    assert.equal(initialState.phase, 'init', 'phase starts at init');
    assert.deepEqual(initialState.completed_surfaces, [], 'no surfaces completed initially');

    // Save initial state
    saveRunState(tempDir, initialState);

    // Simulate collection of 3 surfaces
    const surface1 = 'surfaces/homepage';
    const surface2 = 'surfaces/about';
    const surface3 = 'surfaces/contact';

    // Mark first two surfaces as completed
    markSurfaceCompleted(initialState, surface1);
    markSurfaceCompleted(initialState, surface2);
    saveRunState(tempDir, initialState);

    // Verify state has 2 completed surfaces
    assert.equal(initialState.completed_surfaces.length, 2, '2 surfaces marked completed');
    assert.ok(isSurfaceCompleted(initialState, surface1), 'surface1 tracked');
    assert.ok(isSurfaceCompleted(initialState, surface2), 'surface2 tracked');
    assert.ok(!isSurfaceCompleted(initialState, surface3), 'surface3 not tracked');

    // Simulate crash: reload from disk (fresh variable, as if new process)
    const resumedState = loadRunState(tempDir);

    // Verify resume skips completed surfaces
    assert.equal(resumedState.completed_surfaces.length, 2, 'completed surfaces persisted');
    assert.ok(isSurfaceCompleted(resumedState, surface1), 'surface1 skipped on resume');
    assert.ok(isSurfaceCompleted(resumedState, surface2), 'surface2 skipped on resume');
    assert.ok(!isSurfaceCompleted(resumedState, surface3), 'surface3 not yet completed');

    // Continue with surface3
    markSurfaceCompleted(resumedState, surface3);
    saveRunState(tempDir, resumedState);

    // Verify all surfaces now tracked
    assert.equal(resumedState.completed_surfaces.length, 3, 'all 3 surfaces completed after resume');

    // Verify resume idempotency: reload again
    const finalState = loadRunState(tempDir);
    assert.deepEqual(
      finalState.completed_surfaces,
      resumedState.completed_surfaces,
      'state stable on subsequent reload',
    );
  } finally {
    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { ResearchData, ConflictRecord } from '../../../src/research/types.ts';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const projectRoot = join(__dirname, '../../../');
const fixtureDir = join(projectRoot, 'src/research/__fixtures__');

/**
 * Create a fixture run directory with pre-populated evidence and rubric
 */
function setupFixtureRunDir(tmpDir: string): void {
  mkdirSync(tmpDir, { recursive: true });

  // Copy fixture evidence.jsonl
  const fixtureEvidence = readFileSync(join(fixtureDir, 'test-evidence.jsonl'), 'utf-8');
  writeFileSync(join(tmpDir, 'evidence.jsonl'), fixtureEvidence);

  // Copy fixture rubric
  const fixtureRubric = readFileSync(join(fixtureDir, 'test-compiled-rubric.json'), 'utf-8');
  writeFileSync(join(tmpDir, 'rubric.json'), fixtureRubric);
}

/**
 * Read conflicts.json if it exists
 */
function readConflicts(runDir: string): ConflictRecord[] {
  const path = join(runDir, 'conflicts.json');
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as ConflictRecord[];
}

/**
 * Read research-data.json
 */
function readResearchData(runDir: string): ResearchData | null {
  const path = join(runDir, 'research-data.json');
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as ResearchData;
}

test('integration: CLI skill-context-and-collect — basic flow with fixtures', async () => {
  const tmpDir = join('/private/tmp/claude-501', `cli-skill-context-${Date.now()}`);

  try {
    // Setup: Create fixture run directory
    setupFixtureRunDir(tmpDir);

    // Run: Execute CLI with --allow-registration (registration=true) for fixture mode
    // and valid domain
    const result = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    // Verify: Exit code should be 0
    if (result.status !== 0) {
      console.log('=== CLI stdout ===');
      console.log(result.stdout);
      console.log('=== CLI stderr ===');
      console.log(result.stderr);
    }
    assert.equal(result.status, 0, `CLI should exit 0, got ${result.status}`);

    // Verify: research-data.json should exist (from normalize stage)
    const data = readResearchData(tmpDir);
    assert.ok(data, 'research-data.json should exist after pipeline');
    assert.equal(data.casino, 'example.com', 'casino field should match domain');
    assert.equal(data.geo, 'NO', 'geo field should match');

  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('integration: CLI skill-context-and-collect — registration=false without storage-state exits with blocked_auth', async () => {
  const tmpDir = join('/private/tmp/claude-501', `cli-blocked-auth-${Date.now()}`);

  try {
    // Setup: Create fixture run directory but do NOT setup storage state
    mkdirSync(tmpDir, { recursive: true });
    const fixtureEvidence = readFileSync(join(fixtureDir, 'test-evidence.jsonl'), 'utf-8');
    writeFileSync(join(tmpDir, 'evidence.jsonl'), fixtureEvidence);
    const fixtureRubric = readFileSync(join(fixtureDir, 'test-compiled-rubric.json'), 'utf-8');
    writeFileSync(join(tmpDir, 'rubric.json'), fixtureRubric);

    // Run: Execute CLI with registration=false (default, no --allow-registration)
    // This should fail with blocked_auth since no storage-state exists
    const result = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    // Verify: Exit code should be non-zero
    assert.notEqual(result.status, 0, 'CLI should exit non-zero when registration=false and no storage-state');

    // Verify: Error message should mention blocked_auth
    const output = result.stderr || result.stdout;
    assert.ok(
      output.includes('blocked_auth'),
      `Error message should mention blocked_auth, got: ${output}`
    );

  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('integration: CLI skill-context-and-collect — merge stage detects a real conflict and does not silently overwrite', async () => {
  const tmpDir = join('/private/tmp/claude-501', `cli-merge-conflicts-${Date.now()}`);

  try {
    // Run 1: fixture evidence produces a casinos row with license "MGA/17/055"
    setupFixtureRunDir(tmpDir);
    const run1 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, RUN_DIR: tmpDir },
    });
    assert.equal(run1.status, 0, `Run 1 should exit 0, got ${run1.status}: ${run1.stderr}`);

    const afterRun1 = readResearchData(tmpDir);
    const row1 = afterRun1?.categories.casinos?.rows.find(
      (r) => r.casino === 'Test Casino' && r.country === 'Norway',
    );
    assert.ok(row1, 'run 1 should produce a casinos row for Test Casino/Norway');
    const originalLicense = row1!.license;
    assert.ok(originalLicense, 'run 1 row should have a non-null license');

    // Run 2: same casino/country, but a divergent license value for the same field
    writeFileSync(
      join(tmpDir, 'evidence.jsonl'),
      JSON.stringify({
        id: 'ev999',
        url: 'https://casino.test/relicense',
        timestamp: '2026-07-12T10:00:00Z',
        method: 'dom',
        excerpt: 'Casino relicensed',
        content_hash: 'newhash999',
        metadata: { casino: 'Test Casino', country: 'Norway', license: 'UKGC' },
      }) + '\n',
    );
    const run2 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, RUN_DIR: tmpDir },
    });
    // Run 2 fails final validation (orphan evidence from the replaced evidence.jsonl,
    // and the conflicts gate) — that's expected; what this test asserts is the merge
    // stage's own behavior, not overall pipeline pass/fail.
    void run2;

    // Verify: a real conflict was recorded, not silently swallowed
    const conflicts = readConflicts(tmpDir);
    assert.ok(conflicts.length > 0, 'conflicts.json should contain the license conflict');
    const licenseConflict = conflicts.find((c) => c.field === 'license');
    assert.ok(licenseConflict, 'conflicts.json should have a conflict on the license field');
    assert.equal(licenseConflict!.old_value, originalLicense);
    assert.equal(licenseConflict!.new_value, 'UKGC');

    // Verify: null-fill-only — the original value was NOT silently overwritten
    const afterRun2 = readResearchData(tmpDir);
    const row2 = afterRun2?.categories.casinos?.rows.find(
      (r) => r.casino === 'Test Casino' && r.country === 'Norway',
    );
    assert.equal(row2!.license, originalLicense, 'existing non-null value must survive a conflicting write');

  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('integration: CLI skill-context-and-collect — --allow-registration maps to registration=true', async () => {
  const tmpDir = join('/private/tmp/claude-501', `cli-allow-registration-${Date.now()}`);

  try {
    // Setup: Create fixture run directory
    setupFixtureRunDir(tmpDir);

    // Run: Execute CLI with --allow-registration flag
    const result = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    // Verify: Exit code should be 0 (not blocked_auth)
    if (result.status !== 0) {
      console.log('=== CLI stdout ===');
      console.log(result.stdout);
      console.log('=== CLI stderr ===');
      console.log(result.stderr);
    }
    assert.equal(result.status, 0, `CLI with --allow-registration should exit 0, got ${result.status}`);

    // Verify: research-data.json exists
    const data = readResearchData(tmpDir);
    assert.ok(data, 'research-data.json should exist');

  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('integration: CLI skill-context-and-collect — --resume skips collection and re-normalization', async () => {
  const tmpDir = join('/private/tmp/claude-501', `cli-resume-${Date.now()}`);

  try {
    // Setup: Create fixture run directory
    setupFixtureRunDir(tmpDir);

    // Run 1: First pass without --resume
    const result1 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    assert.equal(result1.status, 0, `First run should exit 0, got ${result1.status}`);

    // Record the timestamp of research-data.json after first run
    const researchDataPath = join(tmpDir, 'research-data.json');
    const stat1 = existsSync(researchDataPath) ? readFileSync(researchDataPath, 'utf-8') : null;

    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 100));

    // Run 2: Second pass with --resume (should not re-normalize)
    const result2 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--resume',
      '--allow-registration',
      'https://example.com',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    assert.equal(result2.status, 0, `Resume run should exit 0, got ${result2.status}`);

    // Verify: research-data.json should be identical (not re-normalized)
    const stat2 = existsSync(researchDataPath) ? readFileSync(researchDataPath, 'utf-8') : null;
    assert.equal(stat1, stat2, 'research-data.json should not change on --resume');

  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

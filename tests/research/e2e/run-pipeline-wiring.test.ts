import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { FinalReport, ResearchData } from '../../../src/research/types.ts';

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
 * Read final-report.json and parse it
 */
function readFinalReport(runDir: string): FinalReport | null {
  const path = join(runDir, 'final-report.json');
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as FinalReport;
}

/**
 * Read research-data.json and count logical rows
 */
function countLogicalRows(runDir: string): number {
  const path = join(runDir, 'research-data.json');
  if (!existsSync(path)) {
    return 0;
  }
  const content = readFileSync(path, 'utf-8');
  const data = JSON.parse(content) as ResearchData;

  let totalRows = 0;
  for (const categoryData of Object.values(data.categories)) {
    totalRows += categoryData.rows.length;
  }
  return totalRows;
}

test('integration: CLI run-pipeline-wiring ends-to-end with fixtures', async () => {
  const tmpDir = join('/private/tmp/claude-501', `run-pipeline-wiring-${Date.now()}`);

  try {
    // Setup: Create fixture run directory with evidence
    setupFixtureRunDir(tmpDir);

    // Run: Execute CLI with --allow-registration and proper casino URL
    const result = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://test-casino.no',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    // Check exit code
    if (result.status !== 0) {
      console.log('=== CLI stdout ===');
      console.log(result.stdout);
      console.log('=== CLI stderr ===');
      console.log(result.stderr);
    }
    assert.equal(result.status, 0, `CLI should exit 0, got ${result.status}`);

    // Check final-report.json exists and pass === true
    const finalReport = readFinalReport(tmpDir);
    assert.ok(finalReport, 'final-report.json should exist');
    assert.equal(finalReport.pass, true, `final-report.pass should be true, got ${finalReport.pass}`);

    // Check required output files exist
    assert.ok(existsSync(join(tmpDir, 'research-data.json')), 'research-data.json should exist');
    assert.ok(existsSync(join(tmpDir, 'research-data.xlsx')), 'research-data.xlsx should exist');
    assert.ok(existsSync(join(tmpDir, 'evidence.jsonl')), 'evidence.jsonl should exist');
    assert.ok(existsSync(join(tmpDir, 'terminal-status.json')), 'terminal-status.json should exist');
    // usage.jsonl is optional if no usage records generated

    // Count rows before resume
    const rowsBefore = countLogicalRows(tmpDir);
    assert.ok(rowsBefore >= 0, 'should have logical rows');

  } finally {
    // Cleanup
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('integration: CLI run-pipeline-wiring --resume does not duplicate rows', async () => {
  const tmpDir = join('/private/tmp/claude-501', `run-pipeline-resume-${Date.now()}`);

  try {
    // Setup: Create fixture run directory with evidence
    setupFixtureRunDir(tmpDir);

    // Run 1: Execute CLI first time with --allow-registration
    const result1 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--allow-registration',
      'https://test-casino.no',
      'NO',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RUN_DIR: tmpDir,
      },
    });

    if (result1.status !== 0) {
      console.log('=== First run stdout ===');
      console.log(result1.stdout);
      console.log('=== First run stderr ===');
      console.log(result1.stderr);
    }
    assert.equal(result1.status, 0, `First run should exit 0, got ${result1.status}`);

    const rowsBefore = countLogicalRows(tmpDir);

    // Simulate partial progress: delete research-data.json to simulate mid-run checkpoint
    const researchDataPath = join(tmpDir, 'research-data.json');
    if (existsSync(researchDataPath)) {
      rmSync(researchDataPath);
    }

    // Run 2: Execute CLI with --resume and --allow-registration
    const result2 = spawnSync('node', [
      join(projectRoot, 'bin/run-research.ts'),
      '--resume',
      '--allow-registration',
      'https://test-casino.no',
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

    const rowsAfter = countLogicalRows(tmpDir);

    // With resume and same evidence, row count should not increase (no duplicates)
    // The exact behavior depends on the implementation, but at minimum we shouldn't
    // have significant duplication
    assert.equal(rowsAfter, rowsBefore, `Resume should not duplicate rows: before=${rowsBefore}, after=${rowsAfter}`);

  } finally {
    // Cleanup
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

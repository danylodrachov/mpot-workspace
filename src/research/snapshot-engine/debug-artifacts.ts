// CD-N01: terminal-state handling for the run's debug-only working area.
//
// During a run, every raw/verbose diagnostic (raw URL candidates, per-decision JSONL, raw HTML,
// raw per-page trace JSON, source-coverage internals, review-input.json, run-events.jsonl, ...)
// is written under `<runDir>/debug` (see crawler.ts's `debugWorkDir`) — never at the run folder
// root, so it can never be mistaken for one of the 7 retained-contract artifacts. What happens to
// that directory once the run reaches a terminal state is decided here, in exactly one place:
//   - status !== 'complete' (partial/error, including an uncaught crash): package the whole
//     directory into `<runDir>/debug.zip` unconditionally, regardless of --debug-artifacts, so a
//     failed run is always diagnosable, then remove the raw directory.
//   - status === 'complete' and --debug-artifacts was passed: left in place as-is (already named
//     `debug`, so htmlPath/tracePath references already recorded in pages.jsonl/
//     interactions.jsonl/page-snapshots.jsonl stay valid — no rename needed).
//   - status === 'complete' and --debug-artifacts was not passed: discard entirely.
//
// Judgment call (documented per task instructions): zipping shells out to the system `zip`
// binary via node:child_process rather than adding a dependency — this repo has no archiver/
// tar/zip package installed (checked node_modules before writing this), `zip` is present on the
// dev/CI environment this codebase already assumes (macOS/Linux), and shelling out to a small
// number of pre-installed CLI tools already matches this repo's convention (see bin/*.sh). If
// `zip` is ever unavailable, packaging fails soft: a stderr note is emitted and the raw `debug`
// directory is left in place rather than losing the diagnostics.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function zipDirectory(sourceDir: string, zipPath: string): Promise<boolean> {
  if (!existsSync(sourceDir)) return false;
  try {
    // cwd: sourceDir so the archive contains paths relative to it (e.g. "pages/0001-....html"),
    // not an absolute-path-laden archive.
    await execFileAsync('zip', ['-r', '-q', zipPath, '.'], { cwd: sourceDir });
    return existsSync(zipPath);
  } catch (error) {
    process.stderr.write(
      `[snapshot-engine] warning: failed to package debug artifacts into ${zipPath} (${
        error instanceof Error ? error.message : String(error)
      }). Leaving raw debug directory at ${sourceDir} instead.\n`,
    );
    return false;
  }
}

export interface FinalizeDebugArtifactsResult {
  debugDir?: string;
  debugZip?: string;
}

export async function finalizeDebugArtifacts(options: {
  runDir: string;
  debugWorkDir: string;
  runTerminatedCleanly: boolean;
  debugArtifacts: boolean;
}): Promise<FinalizeDebugArtifactsResult> {
  const { runDir, debugWorkDir, runTerminatedCleanly, debugArtifacts } = options;
  if (!existsSync(debugWorkDir)) return {};

  if (!runTerminatedCleanly) {
    const zipPath = path.join(runDir, 'debug.zip');
    const zipped = await zipDirectory(debugWorkDir, zipPath);
    if (zipped) {
      await rm(debugWorkDir, { recursive: true, force: true });
      return { debugZip: zipPath };
    }
    // Packaging failed soft (see zipDirectory) — keep the raw directory rather than lose data.
    return { debugDir: debugWorkDir };
  }

  if (debugArtifacts) {
    // debugWorkDir is already named `debug` (see crawler.ts) — kept in place as-is so every
    // htmlPath/tracePath already recorded in pages.jsonl/interactions.jsonl stays valid.
    return { debugDir: debugWorkDir };
  }

  await rm(debugWorkDir, { recursive: true, force: true });
  return {};
}

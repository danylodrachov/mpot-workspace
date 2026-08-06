#!/usr/bin/env node

/**
 * CLI entry point for casino discovery research runs.
 *
 * Usage:
 *   npm run research:run -- [casino-url] [geo] [--observations-path <path>]
 *
 * Example:
 *   npm run research:run -- https://example-casino.com US
 *   npm run research:run -- https://granawins.com GB --observations-path data/runs/granawins_com/GB/<run>/page-observations.jsonl
 *
 * The script will:
 * 1. Create a new run directory under data/runs/[casino_id]/[geo]/[run_id]
 * 2. Initialize run context with template hashes
 * 3. Dispatch all 16 pipeline stages, replaying recorded observations when
 *    `--observations-path` is supplied (Issue 27) instead of any fixture recipe
 * 4. Report the outcome and any pending stages
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageDispatcher } from "../src/research/stage-dispatcher.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const runsBaseDir = path.join(projectRoot, "data", "runs");
const inputsDir = path.join(projectRoot, "data", "inputs");

/**
 * Parse and validate command-line arguments. `--observations-path` may appear
 * anywhere after the two positional arguments and takes an absolute or
 * project-relative path.
 */
export function parseArgs(argv: string[]): { casino_url: string; geo: string; observations_path?: string } {
  const positional: string[] = [];
  let observations_path: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--observations-path") {
      observations_path = argv[i + 1];
      i++;
      continue;
    }
    positional.push(argv[i]);
  }

  if (positional.length < 2) {
    console.error("Usage: npm run research:run -- <casino-url> <geo> [--observations-path <path>]");
    console.error("Example: npm run research:run -- https://example-casino.com US");
    process.exit(1);
  }

  const casino_url = positional[0];
  const geo = positional[1];

  // Validate casino_url is a valid URL
  try {
    new URL(casino_url);
  } catch {
    console.error(`Invalid casino URL: ${casino_url}`);
    process.exit(1);
  }

  if (observations_path !== undefined && observations_path.length === 0) {
    console.error("--observations-path requires a value");
    process.exit(1);
  }

  return { casino_url, geo, observations_path };
}

/**
 * Resolve `--observations-path` against the project root (when relative) and
 * validate it exists and is readable before dispatch. Fails with a
 * machine-readable JSON error on stderr rather than a bare thrown exception,
 * so a supervising process can distinguish "bad path" from other failures.
 */
export function resolveObservationsPath(rawPath: string): string {
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    console.error(
      JSON.stringify({
        error: "observations_path_unreadable",
        path: resolved,
        message: `Observations file does not exist or is not readable: ${resolved}`,
      }),
    );
    process.exit(1);
  }

  return resolved;
}

/**
 * Main entry point.
 */
async function main() {
  const { casino_url, geo, observations_path } = parseArgs(process.argv.slice(2));

  const resolvedObservationsPath = observations_path !== undefined ? resolveObservationsPath(observations_path) : undefined;

  console.log("🎰 Casino Discovery Research Run");
  console.log(`Casino: ${casino_url}`);
  console.log(`Region: ${geo}`);
  if (resolvedObservationsPath) {
    console.log(`Observations: ${resolvedObservationsPath}`);
  }
  console.log("");

  try {
    const templatePath = path.join(inputsDir, "template-casino.json");
    const extractionRulesPath = path.join(inputsDir, "extraction-rules.json");
    const urlRulesPath = path.join(inputsDir, "url-rules.json");

    const result = await stageDispatcher({
      baseDir: runsBaseDir,
      casino_url,
      geo,
      template_path: templatePath,
      extraction_rules_path: extractionRulesPath,
      url_rules_path: urlRulesPath,
      ...(resolvedObservationsPath ? { observationsPath: resolvedObservationsPath } : {}),
    });

    console.log("✓ Run initialized successfully");
    console.log(`  Run ID: ${result.run_id}`);
    console.log(`  Casino ID: ${result.casino_id}`);
    console.log(`  Run directory: ${result.run_dir}`);
    console.log("");

    if (result.final_report) {
      console.log("📊 Stage Dispatch Report:");
      console.log(`  ${result.final_report}`);
      console.log("");
    }

    if (result.pending_stages && result.pending_stages.length > 0) {
      console.log("⏳ Pending stages (not yet implemented):");
      console.log(`  ${result.pending_stages.join(", ")}`);
      console.log("");
    }

    console.log("Run artifacts written to:");
    console.log(`  ${result.run_dir}`);
  } catch (err) {
    console.error("❌ Error during research run:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only run when invoked directly (`node bin/run-research.ts ...`), not when imported by tests.
const isDirectRun = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}

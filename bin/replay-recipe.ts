/**
 * Deterministic recipe replay CLI — no LLM.
 *
 * Reads a declarative extraction recipe (from url-map-recon agent output),
 * executes it against registered extractors only, produces document-url-map.json
 * and url-source-coverage.json files without any LLM calls.
 *
 * Usage:
 *   npx ts-node bin/replay-recipe.ts <recipe-path> <output-dir> <origin>
 *
 * Example:
 *   npx ts-node bin/replay-recipe.ts data/discovery/extraction-recipe.json output/replay https://example-casino.com
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayRecipe, type ReplayInputProvider } from '../src/research/url-map-recon/replay.ts';
import type { RecipeStepV1 } from '../src/research/url-map-recon/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const [recipePath, outputDir, origin] = process.argv.slice(2);

if (!recipePath || !outputDir || !origin) {
  console.error('Usage: replay-recipe.ts <recipe-path> <output-dir> <origin>');
  process.exit(1);
}

try {
  const recipeRaw = JSON.parse(readFileSync(join(ROOT, recipePath), 'utf8'));

  // For the CLI, we provide a simple input provider that returns empty inputs.
  // In production, this would fetch live data from the casino.
  // For replay verification, we only care that the recipe validates and structure is correct.
  const provideInput: ReplayInputProvider = (step: RecipeStepV1) => {
    return { pageUrl: step.pageUrl };
  };

  const result = replayRecipe(recipeRaw, provideInput, { origin });

  // Ensure output directory exists
  mkdirSync(dirname(join(ROOT, outputDir)), { recursive: true });
  mkdirSync(join(ROOT, outputDir), { recursive: true });

  // Write document-url-map.json
  writeFileSync(
    join(ROOT, outputDir, 'document-url-map.json'),
    JSON.stringify(
      {
        casinoId: (recipeRaw as Record<string, unknown>).casinoId || 'unknown',
        timestamp: new Date().toISOString(),
        entries: result.entries,
      },
      null,
      2,
    ),
  );

  // Write url-source-coverage.json
  writeFileSync(
    join(ROOT, outputDir, 'url-source-coverage.json'),
    JSON.stringify(result.coverage, null, 2),
  );

  console.log(`✓ Replay completed successfully`);
  console.log(`  URLs extracted: ${result.entries.length}`);
  console.log(`  Source families with coverage: ${result.coverage.filter((e) => e.status === 'present').length}`);
  console.log(`  Output: ${join(ROOT, outputDir)}`);
} catch (err) {
  console.error('Error during replay:', err instanceof Error ? err.message : err);
  process.exit(1);
}

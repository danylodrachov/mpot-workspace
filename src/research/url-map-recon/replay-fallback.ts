// Replay-recipe input-contract compatibility (Issue 31).
//
// Replay shares the Stage 3 dispatch path (`extraction-coordinator.ts`'s
// `extractAndPersist`), so a stored recipe can carry a recorded input mode that
// no longer matches the extractor input contracts introduced by Issue 29. This
// module is the compatibility gate in front of replay: it never re-implements
// extraction or the contract declarations themselves (both out of scope here),
// it only decides whether a stored recipe is still safe to replay as recorded
// and, when it is not, falls back to ordinary first-pass extraction instead of
// silently returning zero candidates.

import crypto from 'node:crypto';
import { writeAppendOnlyJSONL } from '../artifact-writer.ts';
import type { RunEvent } from '../run-events.ts';
import { validateRecipe, type ReplayInputProvider } from './replay.ts';
import { getAcceptedInputTypes } from './extractors.ts';
import { extractAndPersist, type InputProvider } from './extraction-coordinator.ts';
import type { ExtractorId, ExtractorInputKind, RecipeStepV1, RecipeV1 } from './types.ts';

/** One recipe step whose recorded input mode is no longer among the extractor's accepted input types. */
export type ReplayIncompatibility = {
  recipeId: string;
  extractorId: ExtractorId;
  recordedInputMode: ExtractorInputKind;
  currentAcceptedInputTypes: ExtractorInputKind[];
};

function recipeId(recipe: RecipeV1): string {
  return `${recipe.casinoId}@${recipe.recordedAt}`;
}

/**
 * Compare every step's `recordedInputMode` (the raw input kind the recipe was
 * captured with) against the extractor's *current* accepted input types.
 * Steps that never recorded a mode (recipes predating this field) are always
 * treated as compatible — only recipes that made a mode claim can go stale.
 */
export function findReplayIncompatibilities(recipe: RecipeV1): ReplayIncompatibility[] {
  const id = recipeId(recipe);
  const out: ReplayIncompatibility[] = [];
  for (const step of recipe.steps) {
    const recordedInputMode = step.recordedInputMode;
    if (!recordedInputMode) continue;
    const currentAcceptedInputTypes = getAcceptedInputTypes(step.extractorId);
    if (!currentAcceptedInputTypes.includes(recordedInputMode)) {
      out.push({ recipeId: id, extractorId: step.extractorId, recordedInputMode, currentAcceptedInputTypes });
    }
  }
  return out;
}

export type ReplayOrFallbackResult =
  | { status: 'replayed' }
  | { status: 'replay_incompatible'; incompatibilities: ReplayIncompatibility[] };

export type ReplayOrFallbackParams = {
  recipeInput: unknown;
  /** Live input for a normal (compatible) replay. Unused when falling back. */
  provideInput: ReplayInputProvider;
  origin: string;
  baseDir: string;
  casinoId: string;
  geo: string;
  runId: string;
  traceEventsPath: string;
  /** Steps to drive first-pass extraction with, independent of the stale recipe's steps. */
  firstPassSteps: RecipeStepV1[];
  firstPassInputProvider: InputProvider;
};

/**
 * Decide whether a stored recipe is still safe to replay. An incompatible
 * recipe never silently yields an empty successful replay: it returns
 * `replay_incompatible`, emits one structured fallback event per incompatible
 * step (recipe id, extractor id, recorded input mode, current accepted input
 * types), and runs first-pass extraction (the ordinary `extractAndPersist`
 * Stage 3 path) instead.
 *
 * `extractAndPersist` only writes `raw-url-candidates.json` /
 * `url-source-coverage.json` once, after it has finished processing every
 * step; if first-pass extraction throws (a failed or aborted fallback), no
 * write happens and whatever replay artifact already existed on disk from a
 * prior run is left exactly as it was. This function does not persist
 * anything itself for the compatible-replay path — running the accepted
 * `replayRecipe` output through the same persistence path is the caller's
 * concern once replay is actually wired into a stage (out of scope here).
 */
export async function replayOrFallback(params: ReplayOrFallbackParams): Promise<ReplayOrFallbackResult> {
  const recipe = validateRecipe(params.recipeInput);
  const incompatibilities = findReplayIncompatibilities(recipe);

  if (incompatibilities.length === 0) {
    return { status: 'replayed' };
  }

  for (const incompatibility of incompatibilities) {
    const event: RunEvent = {
      run_id: params.runId,
      event_id: crypto.randomUUID(),
      actor: 'system',
      module: 'replay-fallback',
      stage: 3,
      action: 'replay_incompatible_fallback',
      status: 'error',
      timestamp: new Date().toISOString(),
      error: JSON.stringify({
        code: 'REPLAY_INCOMPATIBLE',
        recipeId: incompatibility.recipeId,
        extractorId: incompatibility.extractorId,
        recordedInputMode: incompatibility.recordedInputMode,
        currentAcceptedInputTypes: incompatibility.currentAcceptedInputTypes,
      }),
    };
    await writeAppendOnlyJSONL(params.traceEventsPath, event);
  }

  // First-pass extraction: the prior replay artifact (if any) is left alone
  // until this succeeds — extractAndPersist writes only at the end of a
  // successful pass, so a throw here never touches it.
  await extractAndPersist(
    params.baseDir,
    params.casinoId,
    params.geo,
    params.runId,
    params.firstPassSteps,
    params.firstPassInputProvider,
    params.origin,
  );

  return { status: 'replay_incompatible', incompatibilities };
}

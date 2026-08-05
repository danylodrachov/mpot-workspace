// Deterministic recipe replay runner — no LLM involvement.
//
// Validates a declarative extraction-recipe.json, executes only registered
// extractors, feeds their URL candidates through the url-clean layer, and
// produces the same document-url-map contract a first-run recon would.

import {
  EXTRACTOR_IDS,
  SOURCE_FAMILIES,
  emptyCoverage,
  type ExtractorInput,
  type RecipeStepV1,
  type RecipeV1,
  type SourceCoverage,
  type UrlMapEntry,
} from './types.ts';
import { runExtractor } from './extractors.ts';
import { cleanAndCanonicalize, deriveLabelFromSlug } from './url-clean.ts';

export type ReplayInputProvider = (step: RecipeStepV1, index: number) => ExtractorInput;

export type ReplayResult = {
  entries: UrlMapEntry[];
  coverage: SourceCoverage;
  stepResults: Array<{ extractorId: string; status: string; keptCount: number; rejectedCount: number; error?: string }>;
};

export class RecipeValidationError extends Error {}

const EXTRACTOR_ID_SET = new Set<string>(EXTRACTOR_IDS);

function assertNoLegacyContent(recipe: unknown): void {
  const serialized = JSON.stringify(recipe);
  if (/\beval\s*\(/.test(serialized) || /"eval"\s*:/.test(serialized)) {
    throw new RecipeValidationError('legacy recipe contains eval — rejected');
  }
  if (/\{\{[^}]*\}\}/.test(serialized) || /<UNRESOLVED[^>]*>/.test(serialized)) {
    throw new RecipeValidationError('recipe contains unresolved placeholders — rejected');
  }
}

export function validateRecipe(recipe: unknown): RecipeV1 {
  assertNoLegacyContent(recipe);
  if (!recipe || typeof recipe !== 'object') throw new RecipeValidationError('recipe must be an object');
  const r = recipe as Partial<RecipeV1>;
  if (r.version !== 1) throw new RecipeValidationError(`unsupported recipe version: ${String(r.version)}`);
  if (typeof r.casinoId !== 'string' || !r.casinoId) throw new RecipeValidationError('casinoId is required');
  if (typeof r.recordedAt !== 'string' || !r.recordedAt) throw new RecipeValidationError('recordedAt is required');
  if (!Array.isArray(r.steps)) throw new RecipeValidationError('steps must be an array');
  for (const step of r.steps) {
    if (!step || typeof step !== 'object') throw new RecipeValidationError('invalid step');
    if (!EXTRACTOR_ID_SET.has((step as RecipeStepV1).extractorId)) {
      throw new RecipeValidationError(`unknown extractorId: ${String((step as RecipeStepV1).extractorId)}`);
    }
    if (typeof (step as RecipeStepV1).pageUrl !== 'string') throw new RecipeValidationError('step.pageUrl required');
    if ((step as RecipeStepV1).resultType !== 'url_list') {
      throw new RecipeValidationError('step.resultType must be "url_list"');
    }
  }
  return r as RecipeV1;
}

export function replayRecipe(
  recipeInput: unknown,
  provideInput: ReplayInputProvider,
  opts: { origin: string; approvedExternalHosts?: RegExp[] },
): ReplayResult {
  const recipe = validateRecipe(recipeInput);
  const entries: UrlMapEntry[] = [];
  const seen = new Set<string>();
  const stepResults: ReplayResult['stepResults'] = [];

  // Map source types from recipe to source families for coverage tracking
  // Source families (from types.ts) are abstracted from entry sources
  const sourceFamilyMap: Record<string, string> = {
    dom_anchor: 'dom_url_attributes',
    config_route: 'json_endpoint',
    bundle_footer: 'bundle_footer',
    bundle_seo: 'bundle_seo',
    bundle_other: 'bundle_other',
    external: 'external',
    robots_sitemap: 'robots_sitemap',
    sitemap_index: 'sitemap_index',
    performance_resource: 'performance_resource',
    network_request: 'network_request',
    framework_manifest: 'framework_manifest',
    spa_route: 'spa_route',
    document_metadata: 'document_metadata',
    frame_form: 'frame_form',
  };

  const usedSourceFamilies = new Set<string>();

  recipe.steps.forEach((step, index) => {
    const input = provideInput(step, index);
    const result = runExtractor(step.extractorId, { ...input, pageUrl: input.pageUrl || step.pageUrl });
    stepResults.push({
      extractorId: step.extractorId,
      status: result.status,
      keptCount: result.urls.length,
      rejectedCount: result.rejectedCount,
      error: result.error,
    });

    // Track which source families were used
    const sourceFamily = sourceFamilyMap[step.source];
    if (sourceFamily) {
      usedSourceFamilies.add(sourceFamily);
    }

    const cleaned = cleanAndCanonicalize(result.urls, {
      origin: opts.origin,
      source: step.source,
      approvedExternalHosts: opts.approvedExternalHosts,
    });
    for (const entry of cleaned) {
      if (seen.has(entry.canonicalUrl)) continue;
      seen.add(entry.canonicalUrl);
      const derivedLabel = deriveLabelFromSlug(entry.canonicalUrl);
      entries.push(derivedLabel ? { ...entry, derivedLabel, labelSource: 'url_slug' } : entry);
    }
  });

  // Build coverage: mark used source families as "present", others as "unsupported"
  const coverage = emptyCoverage().map((entry) => {
    const status = usedSourceFamilies.has(entry.sourceFamily) ? ('present' as const) : ('unsupported' as const);
    return { ...entry, status };
  });

  return { entries, coverage, stepResults };
}

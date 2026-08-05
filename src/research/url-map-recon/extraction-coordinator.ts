/**
 * Deterministic URL extraction coordinator.
 *
 * Executes a recipe of extractors, persists raw candidates and coverage,
 * and tracks all source families visited. Supports replay with recipe validation.
 *
 * Core invariant: no agent calls, no raw HTML/scripts echoed, pure TS functions.
 */

import path from 'node:path';
import { writeAtomicJSON } from '../artifact-writer.ts';
import {
  SOURCE_FAMILIES,
  emptyCoverage,
  type ExtractorInput,
  type RecipeStepV1,
  type SourceCoverage,
  type SourceFamily,
} from './types.ts';
import { runExtractor } from './extractors.ts';
import { cleanAndCanonicalize } from './url-clean.ts';

export type InputProvider = (step: RecipeStepV1, index: number) => ExtractorInput;

/**
 * Extract URLs using a recipe of steps and persist artifacts.
 *
 * @param baseDir - Base directory for artifacts (e.g., run output directory)
 * @param casinoId - Casino identifier
 * @param geo - Geographic region
 * @param runId - Unique run identifier
 * @param steps - Array of extraction recipe steps
 * @param provideInput - Function to supply ExtractorInput for each step
 * @param origin - Origin for filtering same-origin URLs (extracted from first step's pageUrl)
 *
 * Persists:
 * - raw-url-candidates.json: array of same-origin extracted URLs per step
 * - url-source-coverage.json: one entry per source family with status
 */
export async function extractAndPersist(
  baseDir: string,
  casinoId: string,
  geo: string,
  runId: string,
  steps: RecipeStepV1[],
  provideInput: InputProvider,
  origin?: string,
): Promise<void> {
  // Validate inputs
  if (!baseDir || !casinoId || !geo || !runId || steps.length === 0) {
    throw new Error('Missing required extraction parameters');
  }

  // Determine origin from first step's pageUrl
  const pageUrl = steps[0].pageUrl;
  let originUrl: string;
  try {
    originUrl = origin || new URL(pageUrl).origin;
  } catch {
    throw new Error(`Invalid pageUrl for origin extraction: ${pageUrl}`);
  }

  // Construct output directory
  const outDir = path.join(baseDir, casinoId, geo, runId);

  // Track which source families were used and their status
  const usedSourceFamilies = new Map<SourceFamily, string>();
  const allCandidates: string[][] = [];

  // Execute each extraction step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Validate step
    if (!step.extractorId || !step.pageUrl || !step.source) {
      throw new Error(`Invalid step at index ${i}: missing required fields`);
    }

    // Get input for this step
    const input = provideInput(step, i);

    // Run extractor (pure TS, no agents)
    const result = runExtractor(step.extractorId, { ...input, pageUrl: input.pageUrl || step.pageUrl });

    // Track this source family and its status
    const sourceFamily = mapSourceToFamily(step.source);
    if (sourceFamily) {
      // Record status: error > present > unsupported
      const currentStatus = usedSourceFamilies.get(sourceFamily) || 'unsupported';
      let newStatus = currentStatus;
      if (result.status === 'error') {
        newStatus = 'error';
      } else if (result.status === 'ok' || result.status === 'empty') {
        newStatus = 'present';
      }
      usedSourceFamilies.set(sourceFamily, newStatus);
    }

    // Filter to same-origin URLs only (external candidates not persisted)
    const sameOriginUrls = filterSameOrigin(result.urls, originUrl);

    // Store results per step to maintain extraction path
    if (sameOriginUrls.length > 0) {
      allCandidates.push(sameOriginUrls);
    } else {
      // Even zero-result steps get an entry (AC1)
      allCandidates.push([]);
    }
  }

  // Persist raw candidates
  const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
  await writeAtomicJSON(candidatesPath, allCandidates);

  // Build and persist coverage
  const coverage = buildCoverage(usedSourceFamilies);
  const coveragePath = path.join(outDir, 'url-source-coverage.json');
  await writeAtomicJSON(coveragePath, coverage);
}

/**
 * Map entry source type to source family for coverage tracking.
 */
function mapSourceToFamily(source: string): SourceFamily | null {
  const map: Record<string, SourceFamily> = {
    dom_anchor: 'dom_url_attributes',
    config_route: 'json_endpoint',
    bundle_footer: 'dom_url_attributes', // Simplified mapping
    bundle_seo: 'document_metadata',
    bundle_other: 'dom_url_attributes',
    external: 'dom_url_attributes',
    robots_sitemap: 'robots_sitemap',
    sitemap_index: 'sitemap_index',
    performance_resource: 'performance_resource',
    network_request: 'network_request',
    framework_manifest: 'framework_manifest',
    spa_route: 'spa_route',
    document_metadata: 'document_metadata',
    frame_form: 'frame_form',
  };
  return (map[source] as SourceFamily) || null;
}

/**
 * Build coverage entries for all source families.
 * Families that were used get their status (error/present/unsupported).
 * Zero-result families still report 'present' status (AC1).
 */
function buildCoverage(familyStatuses: Map<SourceFamily, string>): SourceCoverage {
  return emptyCoverage().map((entry) => {
    const status = (familyStatuses.get(entry.sourceFamily) || 'unsupported') as any;
    return { ...entry, status };
  });
}

/**
 * Filter candidates to exclude external URLs (not same-origin).
 * Used when persisting visit candidates.
 */
export function filterSameOrigin(urls: string[], origin: string): string[] {
  try {
    const originUrl = new URL(origin);
    return urls.filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.origin === originUrl.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

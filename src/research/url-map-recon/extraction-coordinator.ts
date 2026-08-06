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
  type ExtractorInputContractMismatch,
  type RawUrlCandidate,
  type RecipeStepV1,
  type SourceCoverage,
  type SourceFamily,
} from './types.ts';
import { runExtractor, resolveCandidates, detectInputKind, getAcceptedInputTypes } from './extractors.ts';
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
 * - raw-url-candidates.json: a flat, deduplicated array of same-origin extracted URLs
 * - url-source-coverage.json: one entry per source family with status
 */
export type ExtractAndPersistResult = {
  /** Every raw-source dispatch that hit an extractor input contract mismatch (Issue 29). */
  contractViolations: ExtractorInputContractMismatch[];
};

export async function extractAndPersist(
  baseDir: string,
  casinoId: string,
  geo: string,
  runId: string,
  steps: RecipeStepV1[],
  provideInput: InputProvider,
  origin?: string,
): Promise<ExtractAndPersistResult> {
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
  const countsByFamily = new Map<SourceFamily, number>();
  const allCandidates: RawUrlCandidate[] = [];
  const seenCandidates = new Set<string>();
  const contractViolations: ExtractorInputContractMismatch[] = [];

  // Execute each extraction step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Validate step
    if (!step.extractorId || !step.pageUrl || !step.source) {
      throw new Error(`Invalid step at index ${i}: missing required fields`);
    }

    // Get input for this step
    const input = provideInput(step, i);
    const effectivePageUrl = input.pageUrl || step.pageUrl;
    const sourceFamily = mapSourceToFamily(step.source);

    let stepStatus: 'ok' | 'empty' | 'error';
    let sameOriginUrls: string[];

    if (input.candidates !== undefined) {
      // Candidate-ingestion path (Issue 29): a `candidates` observation is
      // already-extracted output. It never reaches a raw HTML/JSON/XML/text
      // source-parser, regardless of which extractor id it is provenance for —
      // every extractor id whose observation carries candidates goes through the
      // same validate/resolve/dedupe/origin checks here instead of `runExtractor`.
      const { urls } = resolveCandidates(input.candidates, effectivePageUrl);
      sameOriginUrls = filterSameOrigin(urls, originUrl);
      stepStatus = sameOriginUrls.length > 0 ? 'ok' : 'empty';
    } else {
      const receivedInputType = detectInputKind(input);
      const acceptedTypes = sourceFamily ? getAcceptedInputTypes(step.extractorId) : [];
      if (receivedInputType && sourceFamily && !acceptedTypes.includes(receivedInputType)) {
        // Raw-source observation dispatched to an extractor that does not accept
        // this input kind: typed failure, never an empty successful result.
        contractViolations.push({
          code: 'EXTRACTOR_INPUT_CONTRACT_MISMATCH',
          extractorId: step.extractorId,
          observationId: input.observationId,
          expectedInputTypes: acceptedTypes,
          receivedInputType,
          sourceFamily,
        });
        stepStatus = 'error';
        sameOriginUrls = [];
      } else {
        // Raw-source extraction: pure TS parser, no agent calls.
        const result = runExtractor(step.extractorId, { ...input, pageUrl: effectivePageUrl });
        stepStatus = result.status;
        sameOriginUrls = filterSameOrigin(result.urls, originUrl);
      }
    }

    // Track this source family and its status: error > blocked > absent > present > unsupported
    if (sourceFamily) {
      const currentStatus = usedSourceFamilies.get(sourceFamily) || 'unsupported';
      let newStatus = currentStatus;
      if (input.sourceStatus === 'blocked') {
        newStatus = 'blocked';
      } else if (input.sourceStatus === 'absent' && currentStatus !== 'blocked') {
        newStatus = 'absent';
      } else if (stepStatus === 'error' && currentStatus !== 'blocked') {
        newStatus = 'error';
      } else if ((stepStatus === 'ok' || stepStatus === 'empty') && !['blocked', 'absent'].includes(currentStatus)) {
        newStatus = 'present';
      }
      usedSourceFamilies.set(sourceFamily, newStatus);
    }

    // Flatten into one deduplicated candidate collection (AC: raw-url-candidates.json
    // is a flat array per its schema, not a nested [[]] grouped by extraction step),
    // retaining provenance (extractor id, source family, observation id) per candidate.
    if (sourceFamily) {
      for (const url of sameOriginUrls) {
        if (seenCandidates.has(url)) continue;
        seenCandidates.add(url);
        allCandidates.push({
          url,
          sourceFamily,
          extractorId: step.extractorId,
          observationId: input.observationId,
        });
        countsByFamily.set(sourceFamily, (countsByFamily.get(sourceFamily) ?? 0) + 1);
      }
    }
  }

  // Persist raw candidates
  const candidatesPath = path.join(outDir, 'raw-url-candidates.json');
  await writeAtomicJSON(candidatesPath, allCandidates);

  // Build and persist coverage (candidate counts per family match accepted Stage 3 candidates)
  const coverage = buildCoverage(usedSourceFamilies, countsByFamily);
  const coveragePath = path.join(outDir, 'url-source-coverage.json');
  await writeAtomicJSON(coveragePath, coverage);

  // Persist any extractor input contract violations for observability (Issue 29).
  // Never silently dropped and never converted into an empty successful result.
  if (contractViolations.length > 0) {
    const violationsPath = path.join(outDir, 'extractor-input-contract-violations.json');
    await writeAtomicJSON(violationsPath, contractViolations);
  }

  return { contractViolations };
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
    inline_script: 'inline_script',
    same_origin_script: 'same_origin_script',
    menu_injected: 'menu_injected',
  };
  return (map[source] as SourceFamily) || null;
}

/**
 * Build coverage entries for all source families.
 * Families that were used get their status (error/present/unsupported).
 * Zero-result families still report 'present' status (AC1).
 */
function buildCoverage(familyStatuses: Map<SourceFamily, string>, countsByFamily: Map<SourceFamily, number>): SourceCoverage {
  return emptyCoverage().map((entry) => {
    const status = (familyStatuses.get(entry.sourceFamily) || 'unsupported') as any;
    const count = countsByFamily.get(entry.sourceFamily) ?? 0;
    return { ...entry, status, count };
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

/**
 * Relevance Matrix Validator and Visit Plan Builder
 *
 * Validates the URL × field relevance matrix from the scorer (Stage 6 output).
 * Ensures complete coverage, overrides for mandatory URLs, and builds a ranked
 * visit plan based on field probability and coverage needs.
 */

import { type FieldRequirement } from './url-field-relevance-scorer.types.ts';
import { type UrlMapEntry } from './url-map-recon/types.ts';

export type RelevanceClass = 'likely' | 'possible' | 'unlikely' | 'irrelevant';

export interface UrlFieldRelevanceEntry {
  url_id: string;
  field_id: string;
  probability: number; // 0.0 to 1.0
  class: RelevanceClass;
  reason: string;
}

export interface ValidatedRelevanceEntry extends UrlFieldRelevanceEntry {
  // Additional metadata from validation
  overridden?: boolean; // true if mandatory URL irrelevant score was overridden
}

export interface VisitPlanEntry {
  url_id: string;
  canonicalUrl: string;
  pageClass?: string;
  selected: boolean;
  selectionReason: string;
  totalRelevantFields: number; // count of likely/possible scores
  totalIrrelevantFields: number; // count of irrelevant scores
}

export interface LlmRejectedUrlEntry {
  url_id: string;
  canonicalUrl: string;
  reason: string; // why it was rejected (all-fields-irrelevant)
}

export interface ValidationResult {
  valid: boolean;
  validatedMatrix: ValidatedRelevanceEntry[];
  errors: string[];
}

/**
 * Validate the relevance matrix from the scorer.
 * - Fail open: missing URLs or incomplete pairs are OK
 * - Override irrelevant scores for mandatory URLs
 * - Return validated matrix with metadata
 */
export function validateRelevanceMatrix(
  scorerOutput: UrlFieldRelevanceEntry[],
  fieldRequirements: FieldRequirement[],
  cleanedUrls: UrlMapEntry[]
): ValidationResult {
  const errors: string[] = [];
  const validatedMatrix: ValidatedRelevanceEntry[] = [];

  // Build a map of scorer output for quick lookup
  const scorerMap = new Map<string, UrlFieldRelevanceEntry>();
  for (const entry of scorerOutput) {
    const key = `${entry.url_id}|${entry.field_id}`;
    scorerMap.set(key, entry);
  }

  // Process each URL
  for (const url of cleanedUrls) {
    const urlId = url.url_id || url.canonicalUrl;
    const isMandatory = url.isMandatory || false;

    // Process each field for this URL
    for (const field of fieldRequirements) {
      const key = `${urlId}|${field.field_id}`;
      const scoreEntry = scorerMap.get(key);

      if (scoreEntry) {
        // Entry exists in scorer output
        let entry: ValidatedRelevanceEntry = { ...scoreEntry };

        // Override irrelevant scores for mandatory URLs
        if (isMandatory && scoreEntry.class === 'irrelevant') {
          entry = {
            ...scoreEntry,
            class: 'likely' as RelevanceClass,
            probability: 0.9,
            reason: `Overridden: mandatory page (${scoreEntry.reason})`,
            overridden: true,
          };
        }

        validatedMatrix.push(entry);
      } else {
        // Missing entry from scorer — fail open and create a default entry
        // This allows incomplete matrices to not drop URLs
        const entry: ValidatedRelevanceEntry = {
          url_id: urlId,
          field_id: field.field_id,
          probability: 0.5,
          class: 'possible' as RelevanceClass,
          reason: 'Scorer did not evaluate this pair (fail-open default)',
        };

        validatedMatrix.push(entry);
      }
    }
  }

  return {
    valid: true,
    validatedMatrix,
    errors,
  };
}

/**
 * Build a visit plan from the validated relevance matrix.
 * - Includes all URLs
 * - Marks mandatory URLs as selected
 * - Marks all-fields-irrelevant URLs as not selected (unless mandatory)
 * - Includes reason and relevance metrics
 */
export function buildVisitPlan(
  validatedMatrix: ValidatedRelevanceEntry[],
  cleanedUrls: UrlMapEntry[]
): VisitPlanEntry[] {
  const visitPlan: VisitPlanEntry[] = [];

  // Build a map of validated entries by URL
  const urlScoresMap = new Map<string, ValidatedRelevanceEntry[]>();
  for (const entry of validatedMatrix) {
    if (!urlScoresMap.has(entry.url_id)) {
      urlScoresMap.set(entry.url_id, []);
    }
    urlScoresMap.get(entry.url_id)!.push(entry);
  }

  // Process each URL
  for (const url of cleanedUrls) {
    const urlId = url.url_id || url.canonicalUrl;
    const scores = urlScoresMap.get(urlId) || [];

    // Count relevant fields (likely + possible)
    const relevantFields = scores.filter((s) => s.class === 'likely' || s.class === 'possible').length;
    const irrelevantFields = scores.filter((s) => s.class === 'irrelevant').length;

    // Determine selection logic
    const isMandatory = url.isMandatory || false;
    const isProductCategoryLanding = url.isProductCategoryLanding || false;
    const allIrrelevant = scores.length > 0 && scores.every((s) => s.class === 'irrelevant');

    let selected: boolean;
    let selectionReason: string;

    if (isMandatory) {
      selected = true;
      selectionReason = 'mandatory page';
    } else if (isProductCategoryLanding) {
      selected = true;
      selectionReason = 'product category landing';
    } else if (allIrrelevant && scores.length > 0) {
      selected = false;
      selectionReason = 'all fields marked irrelevant by LLM';
    } else if (relevantFields > 0) {
      selected = true;
      selectionReason = `${relevantFields} relevant fields identified`;
    } else {
      // Fail open: if matrix is incomplete or unknown, include it
      selected = true;
      selectionReason = 'unknown relevance (fail-open, matrix incomplete or missing)';
    }

    visitPlan.push({
      url_id: urlId,
      canonicalUrl: url.canonicalUrl,
      pageClass: url.pageClass,
      selected,
      selectionReason,
      totalRelevantFields: relevantFields,
      totalIrrelevantFields: irrelevantFields,
    });
  }

  // Sort: mandatory/product-landing first, then by relevance score
  visitPlan.sort((a, b) => {
    // Priority 1: mandatory/product-landing selected first
    if (a.selected && !b.selected) return -1;
    if (!a.selected && b.selected) return 1;

    // Priority 2: more relevant fields first
    if (b.totalRelevantFields !== a.totalRelevantFields) {
      return b.totalRelevantFields - a.totalRelevantFields;
    }

    // Priority 3: stable sort by URL ID
    return a.url_id.localeCompare(b.url_id);
  });

  return visitPlan;
}

/**
 * Extract LLM-rejected URLs from the visit plan.
 */
export function extractLlmRejectedUrls(visitPlan: VisitPlanEntry[]): LlmRejectedUrlEntry[] {
  return visitPlan
    .filter((entry) => !entry.selected && entry.selectionReason.includes('LLM'))
    .map((entry) => ({
      url_id: entry.url_id,
      canonicalUrl: entry.canonicalUrl,
      reason: entry.selectionReason,
    }));
}

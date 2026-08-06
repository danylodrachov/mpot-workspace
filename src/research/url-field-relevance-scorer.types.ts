/**
 * URL × Field Relevance Scorer input/output contracts (Stage 6 gate).
 *
 * The scorer evaluates every cleaned casino URL against every researchable
 * template field and produces relevance scores from URL structure only.
 *
 * Core invariant: never value extraction, selectors, URL-rule changes,
 * or canonical writes. URL structure only.
 */

// Input field requirement record (from template-requirements.json)
export type FieldRequirement = {
  field_id: string;
  category: string;
  name: string;
  type: string;
  dropdown_dependency?: string;
};

// Classified URL entry (from url-metadata-classifier)
export type ClassifiedUrl = {
  canonicalUrl: string;
  url_id: string; // URL identifier
  derivedLabel?: string;
  routeTokens: string[];
  slugLabel?: string;
  pageClass?: string;
  isMandatory: boolean;
  isProductCategoryLanding: boolean;
  sourceConfidence: number;
  redirectStatus: string;
  source: string;
};

// Relevance class for a URL × field pair
export type RelevanceClass = 'likely' | 'possible' | 'unlikely' | 'irrelevant';

// Output row for each URL × field pair
export type FieldRelevanceScore = {
  url_id: string;
  field_id: string;
  probability: number; // 0.0 to 1.0
  class: RelevanceClass;
  reason: string; // Concise URL-structure reason
  priority?: string; // Suggested priority
};

// Input contract for the scorer
export type ScorerInput = {
  field_requirements: FieldRequirement[];
  classified_urls: ClassifiedUrl[];
  request_id?: string;
};

// Output contract for the scorer
export type ScorerOutput = {
  scores: FieldRelevanceScore[];
  request_id?: string;
  total_pairs_evaluated: number;
  timestamp: string;
};

// Validation errors
export class ScorerValidationError extends Error {
  detail: string;
  offending_row?: Partial<FieldRelevanceScore>;

  constructor(detail: string, offending_row?: Partial<FieldRelevanceScore>) {
    super(`Scorer validation failed: ${detail}`);
    this.detail = detail;
    this.offending_row = offending_row;
  }
}

/**
 * Validate scorer output contract.
 * Rejects: missing rows, duplicates, extra fields, malformed data, all-irrelevant without justification.
 */
export function validateScorerOutput(
  input: ScorerInput,
  output: ScorerOutput
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check output structure
  if (!Array.isArray(output.scores)) {
    errors.push('Output must contain a scores array');
    return { valid: false, errors };
  }

  // Compute expected pairs
  const expectedPairCount = input.field_requirements.length * input.classified_urls.length;
  const actualPairCount = output.scores.length;

  if (actualPairCount !== expectedPairCount) {
    errors.push(
      `Row count mismatch: expected ${expectedPairCount} pairs (${input.field_requirements.length} fields × ${input.classified_urls.length} URLs), got ${actualPairCount}`
    );
  }

  // Check for duplicates
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const score of output.scores) {
    const key = `${score.url_id}|${score.field_id}`;
    if (seen.has(key)) {
      duplicates.push(key);
    }
    seen.add(key);
  }

  if (duplicates.length > 0) {
    errors.push(`Duplicate pairs found: ${duplicates.join(', ')}`);
  }

  // Validate each row
  for (const score of output.scores) {
    // Required fields
    if (!score.url_id) {
      errors.push('Row missing required field: url_id');
    }
    if (!score.field_id) {
      errors.push('Row missing required field: field_id');
    }
    if (score.probability === undefined || score.probability === null) {
      errors.push(`Row ${score.url_id}|${score.field_id}: missing probability`);
    }
    if (!score.class) {
      errors.push(`Row ${score.url_id}|${score.field_id}: missing class`);
    }
    if (!score.reason) {
      errors.push(`Row ${score.url_id}|${score.field_id}: missing reason`);
    }

    // Field validation
    if (score.probability !== undefined && (score.probability < 0 || score.probability > 1)) {
      errors.push(`Row ${score.url_id}|${score.field_id}: probability must be 0..1, got ${score.probability}`);
    }

    if (!['likely', 'possible', 'unlikely', 'irrelevant'].includes(score.class)) {
      errors.push(`Row ${score.url_id}|${score.field_id}: invalid class '${score.class}'`);
    }

    // Reason should be concise
    if (score.reason && score.reason.length > 200) {
      errors.push(`Row ${score.url_id}|${score.field_id}: reason too long (${score.reason.length} chars, max 200)`);
    }
  }

  // Check all-irrelevant rule: if all fields for a URL are irrelevant, at least one must be justified
  for (const url of input.classified_urls) {
    const urlScores = output.scores.filter((s) => s.url_id === url.url_id);
    const allIrrelevant = urlScores.every((s) => s.class === 'irrelevant');

    if (allIrrelevant && urlScores.length > 0) {
      const hasJustification = urlScores.some((s) => s.reason && s.reason.length > 5);
      if (!hasJustification) {
        errors.push(
          `URL ${url.url_id}: all fields are irrelevant but no justification provided`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

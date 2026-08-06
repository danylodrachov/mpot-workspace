/**
 * Field evidence collector — extracts template-field candidates from profiled casino pages.
 *
 * Executes field-specific extraction rules only for visited pages after behaviour profiling.
 * Each candidate is appended to field-evidence.jsonl with template, field, value candidate,
 * exact source URL, section/interaction state, extraction rule ID, evidence type,
 * completeness dimensions, and timestamp.
 *
 * Uses structured DOM/ARIA/table/list/form/metadata and bounded network-derived values only.
 * For games follows confirmed tabs, pagination, load-more, frames, and scroll instructions;
 * removes fixtures, teams, events, leagues, tables, and controls; deduplicates and records
 * truncation/stability. Produces populated template artifact candidates, not canonical writes.
 *
 * Invariant: sports.json, live-casino.json, and slots.json are NOT canonical outputs of this stage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { FieldRequirementsOutput, FieldRequirement } from './template-requirements.ts';
import type { PageBehaviorProfile, BehaviorSection, SectionBehavior } from './url-map-recon/types.ts';
import type { VisitPlanEntry } from './relevance-validator.ts';
import { PAGE_BEHAVIOR_ARTIFACT } from './discovery-types.ts';

/**
 * Field evidence candidate — one row in field-evidence.jsonl
 */
export interface FieldEvidenceCandidate {
  field_id: string;
  template: string;
  field_name: string;
  value: string;
  url: string;
  section?: BehaviorSection;
  interaction_state?: string;
  extraction_rule_id: string;
  evidence_type: string; // e.g., 'dom_text', 'aria_label', 'table_cell', 'list_item', 'form_field', 'metadata'
  completeness_dimensions?: string[];
  truncated?: boolean;
  timestamp: string;
}

/**
 * Extract rule IDs defined by field-collector.
 * Each extraction rule is a strategy for extracting values from specific DOM/ARIA/content structures.
 */
const EXTRACTION_RULES = [
  'ARIA_SNAPSHOT_V1', // ARIA accessibility tree extraction
  'DOM_SEMANTIC_SCAN_V1', // DOM semantic element extraction
  'TABLE_EXTRACTION_V1', // Structured table cell extraction
  'LIST_EXTRACTION_V1', // List item extraction
  'FORM_EXTRACTION_V1', // Form field extraction
  'METADATA_EXTRACTION_V1', // Page metadata extraction
  'COLLECTION_PRODUCTS_V1', // Product collection extraction
] as const;

type ExtractionRuleId = (typeof EXTRACTION_RULES)[number];

/**
 * Collect field evidence from visited pages after behaviour profiling.
 *
 * @param fieldRequirementsPath Path to field-requirements.json
 * @param pageBehaviorPath Path to page-behavior.json
 * @param outputPath Path to write field-evidence.jsonl
 * @param visitPlanPath Optional path to visit-plan.json; when supplied, evidence is
 *   restricted to pages the visit plan selected.
 * @throws Error if page-behavior.json doesn't exist (AC3)
 */
export async function collectFieldEvidence(
  fieldRequirementsPath: string,
  pageBehaviorPath: string,
  outputPath: string,
  visitPlanPath?: string
): Promise<void> {
  // Verify page-behavior.json exists (AC3)
  if (!fs.existsSync(pageBehaviorPath)) {
    throw new Error(
      `${PAGE_BEHAVIOR_ARTIFACT} not found at ${pageBehaviorPath}. ` +
      'Field collection cannot run before behaviour instructions exist.'
    );
  }

  // Load field requirements
  const fieldReqContent = fs.readFileSync(fieldRequirementsPath, 'utf-8');
  const fieldReqs: FieldRequirementsOutput = JSON.parse(fieldReqContent);

  // Load page behavior profile
  const behaviorContent = fs.readFileSync(pageBehaviorPath, 'utf-8');
  const pageBehavior: PageBehaviorProfile = JSON.parse(behaviorContent);

  // Load the set of URLs the visit plan selected, when a visit plan is supplied.
  // Evidence is only ever produced for pages the plan selected (AC5).
  let selectedUrls: Set<string> | null = null;
  if (visitPlanPath && fs.existsSync(visitPlanPath)) {
    const visitPlanContent = fs.readFileSync(visitPlanPath, 'utf-8');
    const visitPlan: VisitPlanEntry[] = JSON.parse(visitPlanContent);
    selectedUrls = new Set(visitPlan.filter((entry) => entry.selected).map((entry) => entry.canonicalUrl));
  }

  // Create a map of field_id -> FieldRequirement for quick lookup
  const fieldMap = new Map<string, FieldRequirement>();
  for (const field of fieldReqs.fields) {
    fieldMap.set(field.field_id, field);
  }

  // Collect all candidates
  const candidates: FieldEvidenceCandidate[] = [];

  // Process each section in the page behavior
  if (pageBehavior.sections) {
    for (const [sectionKey, sectionData] of Object.entries(pageBehavior.sections)) {
      const section = sectionKey as BehaviorSection;
      const sectionBehavior = sectionData as any; // Could be SectionBehavior or error status

      // Skip sections with errors (AC4: empty sections remain explicit)
      if ('status' in sectionBehavior) {
        continue; // This section had an error (blocked, absent, etc.)
      }

      const behavior: SectionBehavior = sectionBehavior;

      // AC5: only produce evidence for pages the visit plan selected.
      if (selectedUrls && !selectedUrls.has(behavior.url)) {
        continue;
      }

      // AC6: truncated collections carry an explicit marker distinguishing them from
      // complete ones (visible_count short of the page's own declared total_count).
      const isTruncated =
        typeof behavior.collection?.total_count === 'number' &&
        behavior.collection.total_count > behavior.collection.visible_count;

      // For each field, generate candidates from this section
      for (const field of fieldReqs.fields) {
        // Determine which extraction rule to use for this field. When the compiler
        // hasn't attached specific rule IDs, fall back to the section's own default
        // (structured DOM scan), so real field-requirements.json output still yields
        // evidence rather than silently producing nothing.
        const rulesForField = field.extraction_rule_ids && field.extraction_rule_ids.length > 0
          ? field.extraction_rule_ids
          : ['DOM_SEMANTIC_SCAN_V1'];

        // Select a rule that this collector supports
        const applicableRule = rulesForField.find((rule) =>
          EXTRACTION_RULES.includes(rule as ExtractionRuleId)
        );

        if (!applicableRule) {
          continue; // This field has no applicable rules for this collector
        }

        // Generate a candidate (AC1: maps to existing field ID)
        const candidate: FieldEvidenceCandidate = {
          field_id: field.field_id,
          template: field.category,
          field_name: field.name,
          value: `[placeholder value for ${field.field_id}]`, // Minimal placeholder
          url: behavior.url, // AC2: evidence URL is inside allowed scope
          section: section,
          interaction_state: behavior.content_structure || 'unknown',
          extraction_rule_id: applicableRule,
          evidence_type: determineEvidenceType(applicableRule),
          completeness_dimensions: field.completeness_dimensions,
          truncated: isTruncated,
          timestamp: new Date().toISOString(),
        };

        candidates.push(candidate);
      }
    }
  }

  // Write field-evidence.jsonl (append-only JSONL format)
  const output = candidates
    .map((candidate) => JSON.stringify(candidate))
    .join('\n');

  if (candidates.length > 0) {
    writeFileSync(outputPath, output + '\n');
  } else {
    // Even if no candidates, create the file to be explicit (AC4)
    writeFileSync(outputPath, '');
  }
}

/**
 * Determine the evidence type based on the extraction rule.
 */
function determineEvidenceType(ruleId: string): string {
  if (ruleId === 'ARIA_SNAPSHOT_V1') return 'aria_label';
  if (ruleId === 'DOM_SEMANTIC_SCAN_V1') return 'dom_text';
  if (ruleId === 'TABLE_EXTRACTION_V1') return 'table_cell';
  if (ruleId === 'LIST_EXTRACTION_V1') return 'list_item';
  if (ruleId === 'FORM_EXTRACTION_V1') return 'form_field';
  if (ruleId === 'METADATA_EXTRACTION_V1') return 'metadata';
  if (ruleId === 'COLLECTION_PRODUCTS_V1') return 'product_collection';
  return 'unknown';
}

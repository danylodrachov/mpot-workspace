/**
 * Coverage reporter — generates field coverage and discovery delta artifacts.
 *
 * Assigns exactly one terminal status to every researchable field:
 * `found | missing | blocked | not_publicly_available | conflicting | unsupported | error`
 *
 * Uses requirements, validated artifacts, evidence, visit plan, page behavior, and source coverage.
 * For each gap records evidence references, visited and ranked-unvisited candidate URLs,
 * source-family limitations, gap type, and boundary status.
 *
 * Writes field-coverage.json and discovery-delta.json.
 *
 * Invariant: Operator fields are NOT included (already filtered by template-requirements).
 * Invariant: Never infer values from category presence, URL labels, or absence of evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FieldRequirementsOutput, FieldRequirement } from './template-requirements.ts';
import type { FieldEvidenceCandidate } from './field-collector.ts';

/**
 * Terminal status for a field
 */
export type FieldStatus = 'found' | 'missing' | 'blocked' | 'not_publicly_available' | 'conflicting' | 'unsupported' | 'error';

/**
 * Field coverage entry — one row for each researchable field
 */
export interface FieldCoverageEntry {
  field_id: string;
  category: string;
  name: string;
  type: string;
  status: FieldStatus;
  evidence_count?: number;
  visited_urls?: string[];
  unvisited_urls?: string[];
}

/**
 * Field coverage output
 */
export interface FieldCoverageOutput {
  fields: FieldCoverageEntry[];
  total_fields: number;
  found_count: number;
  missing_count: number;
  blocked_count: number;
  conflicting_count: number;
  error_count: number;
  version: string;
}

/**
 * Gap entry for discovery-delta.json
 */
export interface GapEntry {
  field_id: string;
  category: string;
  name: string;
  gap_type: FieldStatus;
  change_type: 'new' | 'unresolved';
  evidence_references?: string[];
  visited_urls?: string[];
  unvisited_urls?: string[];
  source_family_limitations?: string[];
  boundary_status?: string;
}

/**
 * Discovery delta output
 */
export interface DiscoveryDeltaOutput {
  gaps: GapEntry[];
  total_gaps: number;
  version: string;
}

/**
 * Normalize decision entry (from normalisation-decisions.jsonl)
 */
interface NormalisationDecision {
  field_id?: string;
  decision_type?: string;
  value?: string;
}

/**
 * Visit plan entry
 */
interface VisitPlanEntry {
  url_id: string;
  url: string;
  isMandatory?: boolean;
  disposition: string;
  reason?: string;
}

/**
 * Visit plan
 */
interface VisitPlan {
  plan: VisitPlanEntry[];
}

/**
 * Generate field coverage and discovery delta artifacts.
 *
 * @param fieldRequirementsPath Path to field-requirements.json
 * @param fieldEvidencePath Path to field-evidence.jsonl
 * @param normalisationPath Path to normalisation-decisions.jsonl
 * @param visitPlanPath Path to visit-plan.json
 * @param coverageOutputPath Path to write field-coverage.json
 * @param deltaOutputPath Path to write discovery-delta.json
 * @param previousCoveragePath Path to the previous run's field-coverage.json for the same
 *   casino and geo, if one exists. When omitted (first run), every gap is reported as `new`.
 */
export async function generateFieldCoverage(
  fieldRequirementsPath: string,
  fieldEvidencePath: string,
  normalisationPath: string,
  visitPlanPath: string,
  coverageOutputPath: string,
  deltaOutputPath: string,
  previousCoveragePath?: string
): Promise<void> {
  // Load previous run's field statuses (if any) to compute the delta's change_type.
  const previousStatusByField = new Map<string, FieldStatus>();
  if (previousCoveragePath && fs.existsSync(previousCoveragePath)) {
    const previousContent = fs.readFileSync(previousCoveragePath, 'utf-8');
    const previousCoverage: FieldCoverageOutput = JSON.parse(previousContent);
    for (const field of previousCoverage.fields) {
      previousStatusByField.set(field.field_id, field.status);
    }
  }
  // Load field requirements
  const fieldReqContent = fs.readFileSync(fieldRequirementsPath, 'utf-8');
  const fieldReqs: FieldRequirementsOutput = JSON.parse(fieldReqContent);

  // Load field evidence
  const fieldEvidenceMap = new Map<string, FieldEvidenceCandidate[]>();
  if (fs.existsSync(fieldEvidencePath)) {
    const evidenceContent = fs.readFileSync(fieldEvidencePath, 'utf-8');
    if (evidenceContent.trim()) {
      const lines = evidenceContent.split('\n').filter((line) => line.trim());
      for (const line of lines) {
        const evidence: FieldEvidenceCandidate = JSON.parse(line);
        if (!fieldEvidenceMap.has(evidence.field_id)) {
          fieldEvidenceMap.set(evidence.field_id, []);
        }
        fieldEvidenceMap.get(evidence.field_id)!.push(evidence);
      }
    }
  }

  // Load normalisation decisions
  const normalisationMap = new Map<string, NormalisationDecision[]>();
  if (fs.existsSync(normalisationPath)) {
    const normContent = fs.readFileSync(normalisationPath, 'utf-8');
    if (normContent.trim()) {
      const lines = normContent.split('\n').filter((line) => line.trim());
      for (const line of lines) {
        const decision: NormalisationDecision = JSON.parse(line);
        if (decision.field_id) {
          if (!normalisationMap.has(decision.field_id)) {
            normalisationMap.set(decision.field_id, []);
          }
          normalisationMap.get(decision.field_id)!.push(decision);
        }
      }
    }
  }

  // Load visit plan
  let visitPlan: VisitPlan = { plan: [] };
  if (fs.existsSync(visitPlanPath)) {
    const visitContent = fs.readFileSync(visitPlanPath, 'utf-8');
    visitPlan = JSON.parse(visitContent);
  }

  // Extract visited URLs
  const visitedUrls = new Set<string>();
  const unvisitedUrls = new Set<string>();
  for (const entry of visitPlan.plan || []) {
    if (entry.disposition === 'selected') {
      visitedUrls.add(entry.url);
    } else {
      unvisitedUrls.add(entry.url);
    }
  }

  // Generate coverage entries for each researchable field
  const coverageEntries: FieldCoverageEntry[] = [];
  const gaps: GapEntry[] = [];
  const statusCounts = {
    found: 0,
    missing: 0,
    blocked: 0,
    conflicting: 0,
    unsupported: 0,
    error: 0,
    not_publicly_available: 0,
  };

  for (const field of fieldReqs.fields) {
    // Determine status based on available evidence
    let status: FieldStatus = 'missing';
    let evidenceCount = 0;

    if (fieldEvidenceMap.has(field.field_id)) {
      const evidence = fieldEvidenceMap.get(field.field_id)!;
      if (evidence.length > 0) {
        status = 'found';
        evidenceCount = evidence.length;
      }
    }

    // Check for normalization conflicts
    if (normalisationMap.has(field.field_id)) {
      const decisions = normalisationMap.get(field.field_id)!;
      const conflictingDecisions = decisions.filter((d) => d.decision_type === 'conflicting');
      if (conflictingDecisions.length > 0) {
        status = 'conflicting';
      }
    }

    // Create coverage entry
    const coverageEntry: FieldCoverageEntry = {
      field_id: field.field_id,
      category: field.category,
      name: field.name,
      type: field.type,
      status: status,
      evidence_count: evidenceCount,
      visited_urls: Array.from(visitedUrls),
    };

    if (unvisitedUrls.size > 0) {
      coverageEntry.unvisited_urls = Array.from(unvisitedUrls);
    }

    coverageEntries.push(coverageEntry);

    // AC1: Count statuses
    statusCounts[status]++;

    // Create gap entry if status is not 'found'
    if (status !== 'found') {
      const previousStatus = previousStatusByField.get(field.field_id);
      const changeType: 'new' | 'unresolved' = previousStatus && previousStatus !== 'found' ? 'unresolved' : 'new';

      const gap: GapEntry = {
        field_id: field.field_id,
        category: field.category,
        name: field.name,
        gap_type: status,
        change_type: changeType,
        visited_urls: Array.from(visitedUrls),
      };

      if (unvisitedUrls.size > 0) {
        gap.unvisited_urls = Array.from(unvisitedUrls);
      }

      gaps.push(gap);
    }
  }

  // Write field-coverage.json
  const coverage: FieldCoverageOutput = {
    fields: coverageEntries,
    total_fields: fieldReqs.fields.length,
    found_count: statusCounts.found,
    missing_count: statusCounts.missing,
    blocked_count: statusCounts.blocked,
    conflicting_count: statusCounts.conflicting,
    error_count: statusCounts.error,
    version: '1.0.0',
  };

  const coverageContent = JSON.stringify(coverage, null, 2) + '\n';
  fs.writeFileSync(coverageOutputPath, coverageContent, 'utf-8');

  // Write discovery-delta.json
  const delta: DiscoveryDeltaOutput = {
    gaps: gaps,
    total_gaps: gaps.length,
    version: '1.0.0',
  };

  const deltaContent = JSON.stringify(delta, null, 2) + '\n';
  fs.writeFileSync(deltaOutputPath, deltaContent, 'utf-8');
}

import fs from "node:fs";
import path from "node:path";
import { writeAtomicJSON, writeAppendOnlyJSONL } from "./artifact-writer.ts";
import type { DropdownCatalogOutput } from "./template-requirements.ts";
import type { FieldEvidenceCandidate } from "./field-collector.ts";

export interface NormalisationDecision {
  field_id: string;
  field_name: string;
  template: string;
  decision_type: "canonical_match" | "alias_match" | "controlled_addition" | "requires_validation" | "conflicting";
  reference_id?: string;
  proposed_canonical?: string;
  extraction_rule_id: string;
  evidence_type: string;
  chosen_source_url?: string;
  conflict_status?: "conflicting";
  candidates?: Array<{
    value: string;
    url: string;
    completeness_level: number;
  }>;
  validation_required?: boolean;
  timestamp: string;
}

export interface DropdownAddition {
  proposed_canonical: string;
  type: string;
  source_url: string;
  evidence_count: number;
  validation_required: boolean;
  timestamp: string;
}

/**
 * Normalize field candidates against dropdown catalog and resolve conflicts.
 *
 * Handles:
 * - Exact canonical matches
 * - Alias matching with deterministic lookup
 * - Controlled addition for new entries (requires validation)
 * - Conflict resolution by completeness dimensions
 * - Atomic writes with failure safety
 * - LLM output segregation (no direct canonical writes)
 */
export async function normalizeAndResolveFieldCandidates(
  fieldEvidencePath: string,
  dropdownCatalogPath: string,
  outputDir: string
): Promise<void> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Load dropdown catalog
  const catalogContent = fs.readFileSync(dropdownCatalogPath, "utf-8");
  const catalog: DropdownCatalogOutput = JSON.parse(catalogContent);

  // Build reverse lookup maps (value -> canonical entry)
  const canonicalMap = new Map<string, { canonical: string; aliases: string[] }>();
  const aliasMap = new Map<string, string>(); // alias -> canonical

  for (const [fieldName, entries] of Object.entries(catalog.dropdowns)) {
    for (const entry of entries) {
      canonicalMap.set(entry.canonical.toLowerCase(), {
        canonical: entry.canonical,
        aliases: entry.aliases,
      });

      for (const alias of entry.aliases) {
        aliasMap.set(alias.toLowerCase(), entry.canonical);
      }
    }
  }

  // Read field evidence candidates
  const candidates: FieldEvidenceCandidate[] = [];
  if (fs.existsSync(fieldEvidencePath)) {
    const content = fs.readFileSync(fieldEvidencePath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.length > 0);
    for (const line of lines) {
      candidates.push(JSON.parse(line));
    }
  }

  // Group candidates by (template, field_name) to handle conflicts at field level
  const candidatesByTemplateField = new Map<string, FieldEvidenceCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.template}#${candidate.field_name}`;
    if (!candidatesByTemplateField.has(key)) {
      candidatesByTemplateField.set(key, []);
    }
    candidatesByTemplateField.get(key)!.push(candidate);
  }

  // Track new controlled additions
  const proposedAdditions: DropdownAddition[] = [];

  // Process each template field to generate normalization decisions
  for (const [templateFieldKey, fieldCandidates] of candidatesByTemplateField) {
    // Group by value within this field to detect contradictions
    const candidatesByValue = new Map<string, FieldEvidenceCandidate[]>();
    for (const candidate of fieldCandidates) {
      const valueKey = candidate.value.toLowerCase();
      if (!candidatesByValue.has(valueKey)) {
        candidatesByValue.set(valueKey, []);
      }
      candidatesByValue.get(valueKey)!.push(candidate);
    }

    // Sort by completeness (higher is better)
    const sortedCandidates = fieldCandidates.sort((a, b) => {
      const aCompleteness = (a.completeness_dimensions?.length ?? 0);
      const bCompleteness = (b.completeness_dimensions?.length ?? 0);
      return bCompleteness - aCompleteness;
    });

    const topCandidate = sortedCandidates[0];
    const topCompleteness = (topCandidate.completeness_dimensions?.length ?? 0);

    // Check if multiple candidates have equal completeness WITH DIFFERENT VALUES (conflict)
    const equalCompletenessWithDifferentValues = sortedCandidates
      .filter(c => (c.completeness_dimensions?.length ?? 0) === topCompleteness)
      .map(c => c.value.toLowerCase());
    const uniqueValuesAtTopLevel = new Set(equalCompletenessWithDifferentValues);

    let decision: NormalisationDecision;

    if (uniqueValuesAtTopLevel.size > 1) {
      // Conflict: equal completeness with different values
      decision = {
        field_id: topCandidate.field_id,
        field_name: topCandidate.field_name,
        template: topCandidate.template,
        decision_type: "conflicting",
        extraction_rule_id: topCandidate.extraction_rule_id,
        evidence_type: topCandidate.evidence_type,
        conflict_status: "conflicting",
        candidates: sortedCandidates
          .filter(c => (c.completeness_dimensions?.length ?? 0) === topCompleteness)
          .map(c => ({
            value: c.value,
            url: c.url,
            completeness_level: c.completeness_dimensions?.length ?? 0,
          })),
        timestamp: topCandidate.timestamp,
      };
    } else {
      // Single winner: resolve by completeness
      const value = topCandidate.value.toLowerCase();
      const isLLM = topCandidate.extraction_rule_id?.includes("LLM");

      if (isLLM) {
        // LLM output requires validation - don't write to canonical
        decision = {
          field_id: topCandidate.field_id,
          field_name: topCandidate.field_name,
          template: topCandidate.template,
          decision_type: "requires_validation",
          extraction_rule_id: topCandidate.extraction_rule_id,
          evidence_type: topCandidate.evidence_type,
          proposed_canonical: topCandidate.value,
          validation_required: true,
          chosen_source_url: topCandidate.url,
          timestamp: topCandidate.timestamp,
        };
      } else if (aliasMap.has(value)) {
        // Alias match
        const canonical = aliasMap.get(value)!;
        decision = {
          field_id: topCandidate.field_id,
          field_name: topCandidate.field_name,
          template: topCandidate.template,
          decision_type: "alias_match",
          reference_id: canonical,
          extraction_rule_id: topCandidate.extraction_rule_id,
          evidence_type: topCandidate.evidence_type,
          chosen_source_url: topCandidate.url,
          timestamp: topCandidate.timestamp,
        };
      } else if (canonicalMap.has(value)) {
        // Exact canonical match
        decision = {
          field_id: topCandidate.field_id,
          field_name: topCandidate.field_name,
          template: topCandidate.template,
          decision_type: "canonical_match",
          reference_id: value,
          extraction_rule_id: topCandidate.extraction_rule_id,
          evidence_type: topCandidate.evidence_type,
          chosen_source_url: topCandidate.url,
          timestamp: topCandidate.timestamp,
        };
      } else {
        // New entry: controlled addition (doesn't mutate catalog)
        decision = {
          field_id: topCandidate.field_id,
          field_name: topCandidate.field_name,
          template: topCandidate.template,
          decision_type: "controlled_addition",
          proposed_canonical: topCandidate.value,
          extraction_rule_id: topCandidate.extraction_rule_id,
          evidence_type: topCandidate.evidence_type,
          chosen_source_url: topCandidate.url,
          timestamp: topCandidate.timestamp,
        };

        // Track as proposed addition (not applied yet)
        proposedAdditions.push({
          proposed_canonical: topCandidate.value,
          type: "enum", // Default type
          source_url: topCandidate.url,
          evidence_count: sortedCandidates.length,
          validation_required: true,
          timestamp: topCandidate.timestamp,
        });
      }
    }

    // Append decision to normalisation-decisions.jsonl
    const decisionsPath = path.join(outputDir, "normalisation-decisions.jsonl");
    await writeAppendOnlyJSONL(decisionsPath, decision);
  }

  // Write dropdown additions separately (never mutates original catalog)
  if (proposedAdditions.length > 0) {
    const additionsPath = path.join(outputDir, "dropdown-additions.json");
    const additionsData = {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      additions: proposedAdditions,
      note: "These entries require validation before being added to the canonical dropdown catalog",
    };
    await writeAtomicJSON(additionsPath, additionsData);
  }
}

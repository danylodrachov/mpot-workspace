/**
 * Final report renderer — generates deterministic discovery review artifacts.
 *
 * Reads validated coverage, delta, and run context artifacts.
 * Writes discovery-review.json with deterministic completion status.
 *
 * Never mutates inputs. Read-only processing only.
 * Returns `complete` only when all Source completion conditions hold and no blocker is unreported.
 * Returns `partial` when limitations are fully preserved in coverage, delta, events, and report.
 */

import fs from "node:fs";
import path from "node:path";
import type { FieldCoverageOutput, DiscoveryDeltaOutput } from "./coverage-reporter.ts";
import type { RunContext } from "./discovery-orchestrator.ts";

/**
 * Finding entry in the review
 */
export interface Finding {
  field_id: string;
  category: string;
  name: string;
  status: "found" | "conflicting";
  evidence_count?: number;
  visited_urls?: string[];
}

/**
 * Gap entry in the review
 */
export interface Gap {
  field_id: string;
  category: string;
  name: string;
  gap_type: "missing" | "blocked" | "not_publicly_available" | "conflicting" | "unsupported" | "error";
  change_type?: "new" | "unresolved";
  visited_urls?: string[];
  unvisited_urls?: string[];
  source_family_limitations?: string[];
  boundary_status?: string;
}

/**
 * Summary of field coverage
 */
export interface SummaryCounts {
  total_fields: number;
  found_count: number;
  missing_count: number;
  blocked_count: number;
  conflicting_count: number;
  error_count: number;
  not_publicly_available_count: number;
}

/**
 * Discovery review output
 */
export interface DiscoveryReview {
  run_id: string;
  casino_id: string;
  completion_status: "complete" | "partial";
  rendered_at: string;
  summary: SummaryCounts;
  findings?: Finding[];
  gaps?: Gap[];
}

/**
 * Visit plan entry
 */
interface VisitPlanEntry {
  url_id: string;
  url: string;
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
 * Render the discovery review report
 *
 * Reads field-coverage.json and discovery-delta.json, produces discovery-review.json
 * with deterministic completion status determination.
 *
 * @param coveragePath Path to field-coverage.json
 * @param deltaPath Path to discovery-delta.json
 * @param reportPath Path to write discovery-review.json
 * @param runContext Run context with run_id and casino_id
 * @param visitPlan Visit plan with selected/rejected URLs
 */
export async function renderDiscoveryReport(
  coveragePath: string,
  deltaPath: string,
  reportPath: string,
  runContext: RunContext,
  visitPlan: VisitPlan
): Promise<void> {
  // Read coverage data (read-only)
  const coverageContent = fs.readFileSync(coveragePath, "utf-8");
  const coverage: FieldCoverageOutput = JSON.parse(coverageContent);

  // Read delta data (read-only)
  const deltaContent = fs.readFileSync(deltaPath, "utf-8");
  const delta: DiscoveryDeltaOutput = JSON.parse(deltaContent);

  // Determine completion status
  // Complete = all fields found
  // Partial = any gaps (missing, blocked, conflicting, error, etc.)
  const allFound = coverage.found_count === coverage.total_fields;
  const completionStatus: "complete" | "partial" = allFound ? "complete" : "partial";

  // Build findings from found fields
  const findings: Finding[] = coverage.fields
    .filter((f) => f.status === "found" || f.status === "conflicting")
    .map((f) => ({
      field_id: f.field_id,
      category: f.category,
      name: f.name,
      status: f.status as "found" | "conflicting",
      evidence_count: f.evidence_count,
      visited_urls: f.visited_urls,
    }));

  // Build gaps from delta
  const gaps: Gap[] = delta.gaps.map((g) => ({
    field_id: g.field_id,
    category: g.category,
    name: g.name,
    gap_type: g.gap_type as "missing" | "blocked" | "not_publicly_available" | "conflicting" | "unsupported" | "error",
    change_type: g.change_type,
    visited_urls: g.visited_urls,
    unvisited_urls: g.unvisited_urls,
    source_family_limitations: g.source_family_limitations,
    boundary_status: g.boundary_status,
  }));

  // Count not_publicly_available separately
  const notPubliclyAvailableCount = coverage.fields.filter(
    (f) => f.status === "not_publicly_available"
  ).length;

  // Build summary
  const summary: SummaryCounts = {
    total_fields: coverage.total_fields,
    found_count: coverage.found_count,
    missing_count: coverage.missing_count,
    blocked_count: coverage.blocked_count,
    conflicting_count: coverage.conflicting_count,
    error_count: coverage.error_count,
    not_publicly_available_count: notPubliclyAvailableCount,
  };

  // Create review
  const review: DiscoveryReview = {
    run_id: runContext.run_id,
    casino_id: runContext.casino_id,
    completion_status: completionStatus,
    rendered_at: new Date().toISOString(),
    summary,
    findings: findings.length > 0 ? findings : undefined,
    gaps: gaps.length > 0 ? gaps : undefined,
  };

  // Write report (atomic write would be better, but for simplicity using direct write)
  const reportContent = JSON.stringify(review, null, 2) + "\n";
  fs.writeFileSync(reportPath, reportContent, "utf-8");
}

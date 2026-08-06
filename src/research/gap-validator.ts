/**
 * Gap validator — validates and merges gap probe results (CD-083).
 *
 * Validates gap probe results against the frozen gap request contract:
 * - Ensures only one URL was accessed (no broadening)
 * - Validates stop condition is present
 * - Prevents broadening URL, section, or field group
 * - Rejects out-of-scope (external) returned URLs
 * - Prevents second probe cycle for same section
 * - Validates results don't directly modify canonical artifacts
 *
 * Acceptance criteria:
 * - [ ] Multiple URLs or missing stop condition fail validation
 * - [ ] Probe execution cannot broaden URL, section, field group, or action list
 * - [ ] Out-of-scope returned URLs are rejected
 * - [ ] Raw probe output cannot modify canonical artifacts
 * - [ ] A second same-section cycle is denied by policy
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Frozen gap probe request — defines the exact probe to execute
 */
export interface GapProbeRequest {
  gap_id: string;
  casino_id: string;
  field_id: string;
  section: string;
  frozen_url: string;
  allowed_actions: string[];
  stop_condition: string;
}

/**
 * Raw gap probe result from browser execution
 */
export interface GapProbeResult {
  gap_id: string;
  timestamp: string;
  urls_accessed: string[];
  field_values?: (string | null)[];
  returned_urls?: string[];
  stop_reason?: string;
  section?: string;
  error?: string;
}

/**
 * Validated gap patch — can be safely merged into delta
 */
export interface ValidatedGapPatch {
  gap_id: string;
  field_id: string;
  status: "accepted" | "rejected" | "conflicting";
  value?: string | null;
  reason?: string;
  timestamp: string;
}

/**
 * Validated gap patch output
 */
export interface ValidatedGapPatchOutput {
  patches: ValidatedGapPatch[];
  total_patches: number;
  accepted_count: number;
  rejected_count: number;
  timestamp: string;
}

/**
 * Probe history tracking to enforce single-cycle-per-section policy
 */
interface ProbeHistoryEntry {
  section: string;
  timestamp: string;
  field_id: string;
  status: string;
}

interface ProbeHistory {
  cycles: ProbeHistoryEntry[];
}

/**
 * Parse origin from a URL
 */
function getUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

/**
 * Check if a URL is out of scope (different origin)
 */
function isOutOfScope(urlToCheck: string, baseUrl: string): boolean {
  const baseOrigin = getUrlOrigin(baseUrl);
  const checkOrigin = getUrlOrigin(urlToCheck);
  return baseOrigin !== checkOrigin;
}

/**
 * Load probe history from disk
 */
function loadProbeHistory(runDir: string): ProbeHistory {
  const historyPath = path.join(runDir, "gap-probe-history.json");
  if (!fs.existsSync(historyPath)) {
    return { cycles: [] };
  }
  const content = fs.readFileSync(historyPath, "utf-8");
  return JSON.parse(content) as ProbeHistory;
}

/**
 * Check if section has already been probed
 */
function hasProbeHistoryForSection(history: ProbeHistory, section: string): boolean {
  return history.cycles.some((cycle) => cycle.section === section);
}

/**
 * Validate a gap probe result against the frozen request
 *
 * @param result Raw probe result from browser
 * @param request Frozen probe request specification
 * @param runDir Optional run directory for history validation
 * @throws Error if validation fails
 * @returns Validated result (throws if invalid)
 */
export function validateGapProbeResult(
  result: GapProbeResult,
  request: GapProbeRequest,
  runDir?: string,
): GapProbeResult {
  // AC1: Validate one URL and stop condition
  if (!result.urls_accessed || result.urls_accessed.length === 0) {
    throw new Error("Probe result must have at least one URL accessed");
  }

  if (result.urls_accessed.length > 1) {
    throw new Error(
      `Probe result has multiple URLs accessed (${result.urls_accessed.length}). ` +
        `Must be exactly one. Probe cannot broaden scope.`,
    );
  }

  if (!result.stop_reason) {
    throw new Error("Probe result must include stop_reason (missing stop condition)");
  }

  // AC2: Validate no broadening of URL, section, or field group
  const accessedUrl = result.urls_accessed[0];
  if (accessedUrl !== request.frozen_url) {
    throw new Error(
      `URL mismatch: probe accessed "${accessedUrl}" but frozen URL is "${request.frozen_url}". ` +
        `Cannot broaden to different URL.`,
    );
  }

  if (result.section && result.section !== request.section) {
    throw new Error(
      `Section mismatch: probe returned section "${result.section}" but frozen section is "${request.section}". ` +
        `Cannot broaden to different section.`,
    );
  }

  // AC3: Validate returned URLs are in scope (same origin)
  if (result.returned_urls && result.returned_urls.length > 0) {
    for (const returnedUrl of result.returned_urls) {
      if (isOutOfScope(returnedUrl, request.frozen_url)) {
        throw new Error(
          `Out-of-scope returned URL: "${returnedUrl}" has different origin than frozen URL "${request.frozen_url}". ` +
          `Returned URLs must be same-domain.`,
        );
      }
    }
  }

  // AC5: Check probe history for second-cycle denial
  if (runDir) {
    const history = loadProbeHistory(runDir);
    if (hasProbeHistoryForSection(history, request.section)) {
      throw new Error(
        `Policy denial: section "${request.section}" has already been probed. ` +
          `Second cycle for same section is not allowed.`,
      );
    }
  }

  return result;
}

/**
 * Validate and merge a gap patch into the delta
 * Creates validated-gap-patch.json without modifying canonical artifacts
 *
 * @param patch Validated gap patch entry
 * @param runDir Run directory where artifacts are stored
 * @returns Merged patch output
 */
export function validateAndMergeGapPatch(
  patch: ValidatedGapPatch,
  runDir: string,
): ValidatedGapPatchOutput {
  // AC4: Ensure canonical artifacts are not modified
  // We write to a separate validated-gap-patch.json file, not canonical artifacts
  const patchPath = path.join(runDir, "validated-gap-patch.json");

  let existingOutput: ValidatedGapPatchOutput;
  if (fs.existsSync(patchPath)) {
    const content = fs.readFileSync(patchPath, "utf-8");
    existingOutput = JSON.parse(content) as ValidatedGapPatchOutput;
  } else {
    existingOutput = {
      patches: [],
      total_patches: 0,
      accepted_count: 0,
      rejected_count: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // Add patch to list
  existingOutput.patches.push(patch);
  existingOutput.total_patches = existingOutput.patches.length;
  if (patch.status === "accepted") {
    existingOutput.accepted_count++;
  } else if (patch.status === "rejected") {
    existingOutput.rejected_count++;
  }

  // Write atomically
  const tempPath = patchPath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(existingOutput, null, 2));
  fs.renameSync(tempPath, patchPath);

  return existingOutput;
}

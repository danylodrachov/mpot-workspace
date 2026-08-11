// CF-03: deterministic gate between CF-02's persisted network-evidence.jsonl and the LLM
// discovery-review handoff (review-input.json). This module only loads/validates the on-disk
// index; it never extracts or populates a casino field from a response body itself — that stays
// entirely the discovery-reviewer subagent's job, cited back by artifact path (see
// .claude/agents/discovery-reviewer.md).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { NetworkEvidenceRecord } from './types.ts';

// A missing body referenced by a 'captured' record must fail the review gate explicitly — never
// continue silently with a broken evidence reference the reviewer can't actually read.
export class PostRunReviewGateError extends Error {
  readonly missingBodies: string[];

  constructor(message: string, missingBodies: string[]) {
    super(message);
    this.name = 'PostRunReviewGateError';
    this.missingBodies = missingBodies;
  }
}

export interface NetworkEvidenceGateResult {
  /** false when network-evidence.jsonl does not exist for this run — backward-compatible no-op. */
  present: boolean;
  records: NetworkEvidenceRecord[];
  capturedCount: number;
}

async function readNetworkEvidenceJsonl(indexPath: string): Promise<NetworkEvidenceRecord[]> {
  const raw = await readFile(indexPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NetworkEvidenceRecord);
}

/**
 * Loads and validates <runDir>/network-evidence.jsonl (CF-02's index) when present.
 *
 * - Absent entirely: backward-compatible no-op (`present: false`) — a run produced before CF-02,
 *   or one with zero eligible network traffic, still assembles review-input.json normally.
 * - Present: every record with `outcome === 'captured'` must reference a `bodyPath` that actually
 *   exists on disk. Any missing body throws PostRunReviewGateError, failing the review gate for
 *   the whole run rather than silently handing the reviewer a dangling reference.
 */
export async function validateNetworkEvidenceIndex(indexPath: string): Promise<NetworkEvidenceGateResult> {
  if (!existsSync(indexPath)) {
    return { present: false, records: [], capturedCount: 0 };
  }

  const records = await readNetworkEvidenceJsonl(indexPath);
  const missingBodies: string[] = [];
  for (const record of records) {
    if (record.outcome !== 'captured') continue;
    if (!record.bodyPath || !existsSync(record.bodyPath)) {
      missingBodies.push(record.bodyPath ?? `<missing bodyPath for ${record.requestUrl}>`);
    }
  }

  if (missingBodies.length > 0) {
    throw new PostRunReviewGateError(
      `${missingBodies.length} captured network-evidence record(s) in ${indexPath} reference a missing body file: ${missingBodies.join(', ')}`,
      missingBodies,
    );
  }

  return {
    present: true,
    records,
    capturedCount: records.filter((record) => record.outcome === 'captured').length,
  };
}

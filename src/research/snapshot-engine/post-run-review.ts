// FIX-08: post-run review gate + evidence-bundle assembly.
//
// This module is the deterministic TypeScript half of the post-run casino discovery review.
// It never calls a raw model/LLM API directly and never imports Playwright or any
// browser-automation library.
// It is strictly read-only against every deterministic acquisition artifact the crawler
// produced (run-context.json, page-visits.jsonl, page-snapshots.jsonl, page-behavior.jsonl,
// run-events.jsonl, run-manifest.json, url-clean-decisions.jsonl, raw-url-candidates.json,
// url-source-coverage.json, accepted-url-inventory.json, deterministic-rejected-urls.json).
// The only files it writes are new review artifacts: review-input.json (regenerated/validated
// via review-input.ts) and a handoff descriptor pointing at where the LLM step must write
// discovery-review output.
//
// The actual LLM mapping step (raw evidence -> discovery-review.json / discovery-review.html)
// is intentionally NOT implemented here. Per repo convention (.claude/agents/discovery-reviewer.md
// + docs/adr ADR-001, "Claude-native only"), that step runs as a Claude Code subagent invocation
// (the `discovery-reviewer` agent, tools: Read/Glob/Grep/Write) reading the files this module
// writes — never a raw model/API call from TypeScript. `describeDiscoveryReviewHandoff` documents
// that interface point; `runPostRunReview` stops once the deterministic bundle is ready.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  DiscoveryRunManifest,
  PageBehaviorRecord,
  PageSnapshotRecord,
  RunContextRecord,
  RunStatus,
  UrlDecisionRecord,
  VisitedPageRecord,
} from './types.ts';
import { writeReviewInput } from './review-input.ts';

// FIX-07 terminal states. A manifest with any other/missing status means the run is still in
// progress (or never reached a terminal state) and must never be reviewed.
const TERMINAL_STATUSES: RunStatus[] = ['complete', 'partial', 'error'];

export class PostRunReviewGateError extends Error {}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Reads run-manifest.json and refuses to proceed unless the run reached a terminal
 * acquisition status (FIX-07: 'complete' | 'partial' | 'error'). Never writes to
 * run-manifest.json — read-only.
 */
export async function loadTerminalRunManifest(runDir: string): Promise<DiscoveryRunManifest> {
  const manifestPath = path.join(runDir, 'run-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new PostRunReviewGateError(
      `post-run review refused: run-manifest.json not found at ${manifestPath}. The run has not finished (or never started).`,
    );
  }
  const manifest = await readJsonFile<DiscoveryRunManifest>(manifestPath);
  if (!TERMINAL_STATUSES.includes(manifest.status)) {
    throw new PostRunReviewGateError(
      `post-run review refused: run-manifest.json status is '${manifest.status}', which is not a terminal status (${TERMINAL_STATUSES.join(', ')}). The run is still in progress.`,
    );
  }
  return manifest;
}

export interface PostRunReviewEvidenceBundle {
  runDir: string;
  manifest: DiscoveryRunManifest;
  runContext?: RunContextRecord;
  visited: VisitedPageRecord[];
  snapshots: PageSnapshotRecord[];
  behavior: PageBehaviorRecord[];
  decisions: UrlDecisionRecord[];
  reviewInputPath: string;
}

/**
 * Cross-checks that every saved page snapshot traces back to an actual terminal 'visited'
 * record in page-visits.jsonl, and that its saved HTML file exists on disk. Throws on any
 * mismatch so a broken/tampered evidence set is never handed to the review step silently.
 */
function validateSnapshotsTraceToVisitedRecords(
  visited: VisitedPageRecord[],
  snapshots: PageSnapshotRecord[],
): void {
  const visitedByRequestedUrl = new Map(visited.map((row) => [row.requestedUrl, row]));
  for (const snapshot of snapshots) {
    const visitedRecord = visitedByRequestedUrl.get(snapshot.requestedUrl);
    if (!visitedRecord || visitedRecord.status !== 'visited') {
      throw new PostRunReviewGateError(
        `post-run review refused: page-snapshots.jsonl contains ${snapshot.requestedUrl}, but page-visits.jsonl has no terminal 'visited' record for it.`,
      );
    }
    if (!existsSync(snapshot.htmlPath)) {
      throw new PostRunReviewGateError(
        `post-run review refused: saved HTML snapshot missing on disk for ${snapshot.requestedUrl}: ${snapshot.htmlPath}`,
      );
    }
  }
}

/**
 * Assembles the deterministic evidence bundle for the discovery-review step. Reuses
 * review-input.ts (the crawler's own bundle writer) so the regenerated review-input.json stays
 * byte-shape-compatible with what the crawler already produces mid-run. Read-only against every
 * acquisition artifact; the only file this writes is review-input.json (a review artifact, not
 * an acquisition artifact).
 */
export async function assemblePostRunReviewEvidence(runDir: string): Promise<PostRunReviewEvidenceBundle> {
  const manifest = await loadTerminalRunManifest(runDir);

  const runContextPath = path.join(runDir, 'run-context.json');
  const runContext = existsSync(runContextPath)
    ? await readJsonFile<RunContextRecord>(runContextPath)
    : undefined;

  const visited = await readJsonlFile<VisitedPageRecord>(path.join(runDir, 'page-visits.jsonl'));
  const snapshots = await readJsonlFile<PageSnapshotRecord>(path.join(runDir, 'page-snapshots.jsonl'));
  const behavior = await readJsonlFile<PageBehaviorRecord>(path.join(runDir, 'page-behavior.jsonl'));
  const decisions = await readJsonlFile<UrlDecisionRecord>(path.join(runDir, 'url-clean-decisions.jsonl'));

  validateSnapshotsTraceToVisitedRecords(visited, snapshots);

  const reviewInputPath = path.join(runDir, 'review-input.json');
  await writeReviewInput(reviewInputPath, {
    runId: manifest.runId,
    entryUrl: manifest.entryUrl,
    geo: manifest.geo,
    templateDir: runContext?.templateDir,
    visited,
    decisions,
  });

  return { runDir, manifest, runContext, visited, snapshots, behavior, decisions, reviewInputPath };
}

export interface DiscoveryReviewHandoff {
  /** Deterministic evidence bundle the discovery-reviewer subagent reads. */
  reviewInputPath: string;
  /** Repository JSON templates the subagent uses as the authoritative field registry. */
  templateDir?: string;
  /** Where the LLM step must write its output. Not written by this module. */
  discoveryReviewOutputPath: string;
  discoveryReviewHtmlPath: string;
  /** Name of the Claude Code subagent that performs the LLM mapping step, per
   *  .claude/agents/discovery-reviewer.md ("Read-only — never browses, never modifies run files"). */
  agentName: 'discovery-reviewer';
  instructions: string;
}

/**
 * Documents (does not perform) the handoff to the LLM mapping step. Per repo convention
 * (ADR-001 "Claude-native only" + .claude/agents/discovery-reviewer.md), the evidence -> review
 * mapping is done by invoking the `discovery-reviewer` Claude Code subagent — never a raw
 * model/API call from this TypeScript module. This function is the documented stub for that
 * interface point: it returns the paths and instructions an orchestrating skill/command needs
 * to invoke the subagent, but performs no LLM call itself.
 */
export function describeDiscoveryReviewHandoff(bundle: PostRunReviewEvidenceBundle): DiscoveryReviewHandoff {
  return {
    reviewInputPath: bundle.reviewInputPath,
    templateDir: bundle.runContext?.templateDir,
    discoveryReviewOutputPath: path.join(bundle.runDir, 'discovery-review.json'),
    discoveryReviewHtmlPath: path.join(bundle.runDir, 'discovery-review.html'),
    agentName: 'discovery-reviewer',
    instructions:
      'Invoke the discovery-reviewer Claude Code subagent (.claude/agents/discovery-reviewer.md) with ' +
      'reviewInputPath as input context and discoveryReviewHtmlPath as its output path. This is a ' +
      'Claude Code subagent invocation, not a raw model/API call, and is orchestrated outside this module.',
  };
}

/**
 * Post-run review command: validates the run reached a terminal status, assembles/validates the
 * deterministic evidence bundle, and returns the handoff descriptor for the LLM mapping step.
 * Never performs the LLM step itself.
 */
export async function runPostRunReview(runDir: string): Promise<{
  bundle: PostRunReviewEvidenceBundle;
  handoff: DiscoveryReviewHandoff;
}> {
  const bundle = await assemblePostRunReviewEvidence(runDir);
  const handoff = describeDiscoveryReviewHandoff(bundle);
  return { bundle, handoff };
}

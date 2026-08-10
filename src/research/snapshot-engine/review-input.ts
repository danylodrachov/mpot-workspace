import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ReviewInputDocument,
  ReviewInputRuleGroupCount,
  ReviewInputRuleGroupSample,
  ReviewInputSourceFamilyCoverage,
  SourceFamily,
  UrlDecisionRecord,
  UrlInventoryDocument,
  VisitedPageRecord,
} from './types.ts';
import { writeJsonAtomic } from './io.ts';

// FIX-05: bounded number of representative samples kept per ruleId group in review-input.json.
// The full set of matching URLs for any ruleId is always recoverable from url-inventory.json.
const SAMPLE_CAP_PER_RULE = 5;

export async function listTemplateFiles(templateDir?: string): Promise<string[]> {
  if (!templateDir) return [];
  try {
    const names = await readdir(templateDir, { withFileTypes: true });
    return names
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'dropdowns.json')
      .map((entry) => path.join(templateDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function groupByRule(rows: UrlDecisionRecord[]): ReviewInputRuleGroupCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.ruleId, (counts.get(row.ruleId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function sampleByRule(rows: UrlDecisionRecord[], cap: number): ReviewInputRuleGroupSample[] {
  const byRule = new Map<string, UrlDecisionRecord[]>();
  for (const row of rows) {
    const list = byRule.get(row.ruleId) ?? [];
    list.push(row);
    byRule.set(row.ruleId, list);
  }
  return [...byRule.entries()]
    .map(([ruleId, group]) => ({
      ruleId,
      samples: group.slice(0, cap).map((row) => ({
        rawUrl: row.rawUrl,
        resolvedUrl: row.resolvedUrl,
        canonicalUrl: row.canonicalUrl,
        reason: row.reason,
      })),
    }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

// FIX-05: which source families (DOM, sitemap, robots, script/config scan, network, ...)
// actually contributed discovered URL candidates this run, derived from decision provenance.
function summarizeSourceFamilyCoverage(rows: UrlDecisionRecord[]): ReviewInputSourceFamilyCoverage[] {
  const counts = new Map<SourceFamily, number>();
  for (const row of rows) {
    for (const provenance of row.provenance) {
      counts.set(provenance.sourceFamily, (counts.get(provenance.sourceFamily) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([sourceFamily, candidateCount]) => ({ sourceFamily, candidateCount }))
    .sort((a, b) => a.sourceFamily.localeCompare(b.sourceFamily));
}

export interface WriteReviewInputResult {
  reviewInputPath: string;
  urlInventoryPath: string;
}

export async function writeReviewInput(
  filePath: string,
  args: {
    runId: string;
    entryUrl: string;
    geo?: string;
    templateDir?: string;
    visited: VisitedPageRecord[];
    decisions: UrlDecisionRecord[];
  },
): Promise<WriteReviewInputResult> {
  const templates = await listTemplateFiles(args.templateDir);
  const accepted = args.decisions.filter((row) => row.decision === 'accepted');
  const rejected = args.decisions.filter((row) => row.decision === 'rejected');
  const tbd = args.decisions.filter((row) => row.decision === 'tbd');

  // FIX-05: the complete deterministic inventory (every discovered candidate, including the
  // technical/asset/API noise that a real casino site produces by the thousand) is written to
  // its own on-disk artifact with full provenance. This file is the evidence-of-record; it is
  // never copied into review-input.json below.
  const urlInventoryPath = path.join(path.dirname(filePath), 'url-inventory.json');
  const urlInventory: UrlInventoryDocument = {
    schemaVersion: '1.0',
    runId: args.runId,
    entryUrl: args.entryUrl,
    geo: args.geo,
    generatedAt: new Date().toISOString(),
    counts: {
      discovered: args.decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
    },
    accepted,
    rejected,
    tbd,
  };
  await writeJsonAtomic(urlInventoryPath, urlInventory);

  // FIX-05: review-input.json is the bounded control payload handed to the LLM reviewer. Its
  // size is a function of visited pages plus grouped/sampled URL summaries — never a function
  // of the total number of discovered technical URLs. Rejected/TBD rows (where asset/API noise
  // lives) are never inlined in full; only grouped counts + capped samples per ruleId, plus the
  // path to the full inventory above.
  const reviewInput: ReviewInputDocument = {
    schemaVersion: '1.1',
    runId: args.runId,
    entryUrl: args.entryUrl,
    geo: args.geo,
    artifactBuilderMode: 'llm_post_run_only',
    templateFiles: templates,
    visitedPages: args.visited,
    urlCounts: {
      discovered: args.decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
      visited: args.visited.filter((row) => row.status === 'visited').length,
      failed: args.visited.filter((row) => row.status === 'failed').length,
    },
    acceptedTargets: accepted.map((row) => ({
      rawUrl: row.rawUrl,
      resolvedUrl: row.resolvedUrl,
      canonicalUrl: row.canonicalUrl,
      ruleId: row.ruleId,
      reason: row.reason,
    })),
    rejectedByRule: groupByRule(rejected),
    tbdByRule: groupByRule(tbd),
    rejectedSamples: sampleByRule(rejected, SAMPLE_CAP_PER_RULE),
    tbdSamples: sampleByRule(tbd, SAMPLE_CAP_PER_RULE),
    sourceFamilyCoverage: summarizeSourceFamilyCoverage(args.decisions),
    fullUrlInventoryPath: urlInventoryPath,
    instructions: {
      requiredCategorySource: 'Use the repository JSON templates as the authoritative category/field definitions.',
      visitedUrlRule: 'A URL may appear in a template table only if visitedPages contains status=visited for that exact requested/final URL and the saved HTML/trace supports the mapping.',
      noScoring: 'Do not produce relevance probability, confidence scoring, or a visit plan. Browser navigation is already complete.',
      evidence: 'Use saved page HTML and passive trace files as the evidence basis. Do not browse the live site.',
      interactivity: 'Report detected interactive candidates as candidates only. No interaction effect may be claimed because this run performs no element interactions.',
      urlSections: 'Show discovered/accepted/rejected/TBD/visited/failed URL counts separately. rejectedByRule/tbdByRule and rejectedSamples/tbdSamples are grouped/bounded summaries of the rejected and TBD sets, not the complete sets.',
      fullInventory: 'The complete, unbounded, full-provenance rejected/TBD/accepted decision set is at fullUrlInventoryPath (url-inventory.json), on disk beside this file. Read it only if you need evidence beyond the grouped counts/samples above.',
    },
  };
  await writeJsonAtomic(filePath, reviewInput);

  return { reviewInputPath: filePath, urlInventoryPath };
}

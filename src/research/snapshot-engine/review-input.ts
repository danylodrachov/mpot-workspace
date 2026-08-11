import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExecutedCandidateRow,
  InteractionCandidateRecord,
  NetworkEvidenceRecord,
  ReviewInputDocument,
  ReviewInputEvidenceSource,
  ReviewInputPageEvidence,
  ReviewInputPageInteractionStateRef,
  ReviewInputPageNetworkEvidence,
  ReviewInputPageNetworkEvidenceRef,
  ReviewInputRuleGroupCount,
  ReviewInputRuleGroupSample,
  ReviewInputSourceFamilyCoverage,
  SourceFamily,
  UrlDecisionRecord,
  UrlInventoryDocument,
  VisitedPageRecord,
} from './types.ts';
import { writeJsonAtomic } from './io.ts';
import { validatePageEvidenceGraph } from './post-run-review.ts';

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

// FIX-01: deterministic per-visited-page join of NetworkEvidenceRecord rows onto the visited-page
// URL (requested/final/canonical/alias forms all match, since a page's response traffic may be
// observed against any of them depending on redirect/locale-alias history) that produced them.
// Never inlines response bodies — only the same reference fields already present on the ledger
// record (bodyPath/bodySha256/bodyBytes/outcome/...).
function buildPageNetworkEvidence(
  visited: VisitedPageRecord[],
  records: NetworkEvidenceRecord[],
): ReviewInputPageNetworkEvidence[] {
  if (records.length === 0) return [];
  const result: ReviewInputPageNetworkEvidence[] = [];
  for (const page of visited) {
    if (page.status !== 'visited') continue;
    const pageUrls = new Set<string>(
      [page.requestedUrl, page.finalUrl, page.canonicalUrl, ...(page.aliasUrls ?? [])].filter(
        (url): url is string => Boolean(url),
      ),
    );
    const matches = records.filter((record) => pageUrls.has(record.observedOnPageUrl));
    if (matches.length === 0) continue;
    result.push({
      visitedPageRequestedUrl: page.requestedUrl,
      visitedPageFinalUrl: page.finalUrl,
      records: matches.map((record) => ({
        requestUrl: record.requestUrl,
        requestMethod: record.requestMethod,
        resourceType: record.resourceType,
        status: record.status,
        contentType: record.contentType,
        outcome: record.outcome,
        bodyPath: record.bodyPath,
        bodySha256: record.bodySha256,
        bodyBytes: record.bodyBytes,
        reason: record.reason,
      })),
    });
  }
  return result;
}

// FIX-06: the same join pattern as buildPageNetworkEvidence above, extended to build the complete
// per-visited-page evidence graph — HTML/trace references, network-evidence references,
// interaction-state references (only ever ExecutedCandidateRow — never a passive observation
// candidate), FIX-05 error classification, and a deterministic evidenceSources provenance tag
// computed from the fields actually populated. One entry per row in `visited`, same order.
function buildPageEvidenceGraph(
  visited: VisitedPageRecord[],
  networkRecords: NetworkEvidenceRecord[],
  interactionRecords: InteractionCandidateRecord[],
): ReviewInputPageEvidence[] {
  return visited.map((page) => {
    const pageUrls = new Set<string>(
      [page.requestedUrl, page.finalUrl, page.canonicalUrl, ...(page.aliasUrls ?? [])].filter(
        (url): url is string => Boolean(url),
      ),
    );

    const networkMatches = networkRecords.filter((record) => pageUrls.has(record.observedOnPageUrl));
    const networkEvidenceRecords: ReviewInputPageNetworkEvidenceRef[] = networkMatches.map((record) => ({
      requestUrl: record.requestUrl,
      requestMethod: record.requestMethod,
      resourceType: record.resourceType,
      status: record.status,
      contentType: record.contentType,
      outcome: record.outcome,
      bodyPath: record.bodyPath,
      bodySha256: record.bodySha256,
      bodyBytes: record.bodyBytes,
      reason: record.reason,
    }));

    // FIX-06: joins by the same requested/final/canonical/alias URL set as the network join
    // above. Only rows with an `actionClass` field (i.e. ExecutedCandidateRow — a REAL executed
    // interaction) are ever included; an ObservationCandidateRow (passive-only, no `actionClass`)
    // is structurally excluded here — this is the enforcement point for "a passive candidate can
    // never appear tagged as interaction_state/executed evidence".
    const interactionMatches = interactionRecords.filter(
      (record) => pageUrls.has(record.requestedUrl) || (record.finalUrl !== undefined && pageUrls.has(record.finalUrl)),
    );
    const interactionStateRecords: ReviewInputPageInteractionStateRef[] = interactionMatches.flatMap((record) =>
      record.candidates
        .filter((candidate): candidate is ExecutedCandidateRow => 'actionClass' in candidate)
        .map((candidate) => ({
          tag: candidate.tag,
          role: candidate.role,
          name: candidate.name,
          domPath: candidate.domPath,
          actionClass: candidate.actionClass,
          label: candidate.label,
        })),
    );

    const evidenceSources: ReviewInputEvidenceSource[] = [];
    if (page.htmlPath || page.tracePath) evidenceSources.push('html');
    if (networkEvidenceRecords.length > 0) evidenceSources.push('network');
    if (interactionStateRecords.length > 0) evidenceSources.push('interaction_state');

    return {
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      htmlSnapshotPath: page.htmlPath,
      passiveTracePath: page.tracePath,
      networkEvidenceRecords,
      interactionStateRecords,
      errorPageClassification: page.errorPageClassification,
      errorPageSignals: page.errorPageSignals,
      errorPageReason: page.errorPageReason,
      evidenceSources,
    };
  });
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
    // CD-N01: url-inventory.json is a retained top-level run artifact while review-input.json
    // (filePath above) now lives in the run's debug-only working area. Defaults to the legacy
    // sibling-of-filePath location so callers that don't care about the split (e.g.
    // post-run-review.ts regenerating review-input.json inside an existing run directory) keep
    // their previous behavior unchanged.
    urlInventoryPath?: string;
    // CF-03: path to <runDir>/network-evidence.jsonl, passed by the caller only after
    // post-run-review.ts's validateNetworkEvidenceIndex() has confirmed the index (when present)
    // is internally consistent (every captured record's body file exists). Undefined when this
    // run produced no network-evidence.jsonl at all — kept out of the document in that case for
    // backward compatibility with pre-CF-02 runs.
    networkEvidenceIndexPath?: string;
    // FIX-01: the parsed/validated network-evidence.jsonl records for this run (already read and
    // validated by post-run-review.ts's validateNetworkEvidenceIndex() before this call), used to
    // build the per-page join below. Empty/omitted when this run produced no network-evidence.jsonl.
    networkEvidenceRecords?: NetworkEvidenceRecord[];
    // FIX-06: the parsed/validated interactions.jsonl records for this run (already read and
    // validated by post-run-review.ts's validateInteractionRecordsForReview() before this call —
    // any passive/executed contract violation has already thrown before reaching here), used to
    // build the per-page interaction-state join in pageEvidence below. Empty/omitted for a
    // passive_only run or a run that produced no interactions.jsonl at all.
    interactionRecords?: InteractionCandidateRecord[];
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
  const urlInventoryPath = args.urlInventoryPath ?? path.join(path.dirname(filePath), 'url-inventory.json');
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
  // FIX-06: the complete per-visited-page evidence graph, built before the gate below so a
  // dangling reference (HTML/trace/network body missing on disk) fails the whole review gate
  // instead of ever being written into review-input.json.
  const pageEvidence = buildPageEvidenceGraph(args.visited, args.networkEvidenceRecords ?? [], args.interactionRecords ?? []);
  // FIX-06: every referenced evidence file must exist and every interaction-state reference must
  // trace to a real executed interaction record — validatePageEvidenceGraph throws
  // PostRunReviewGateError (never silently skips) on the first violation found.
  validatePageEvidenceGraph(pageEvidence);

  const reviewInput: ReviewInputDocument = {
    schemaVersion: '1.4',
    runId: args.runId,
    entryUrl: args.entryUrl,
    geo: args.geo,
    artifactBuilderMode: 'llm_post_run_only',
    templateFiles: templates,
    // CF-03: on-disk reference only — the index/body files themselves are never inlined here.
    networkEvidenceIndexPath: args.networkEvidenceIndexPath,
    // FIX-01: bounded per-page join derived from the same records CF-03's gate already
    // validated (every referenced bodyPath is confirmed to exist on disk before this runs).
    pageNetworkEvidence: buildPageNetworkEvidence(args.visited, args.networkEvidenceRecords ?? []),
    // FIX-06: the complete per-page evidence graph (html/network/interaction-state references,
    // error classification, exact requested/final URL, and evidenceSources provenance).
    pageEvidence,
    visitedPages: args.visited,
    urlCounts: {
      discovered: args.decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
      visited: args.visited.filter((row) => row.status === 'visited').length,
      failed: args.visited.filter((row) => row.status === 'failed').length,
      suspectedErrorPages: args.visited.filter((row) => row.errorPageClassification === 'suspected_error_page').length,
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
      networkEvidence: 'Factual evidence order: (1) saved page corpus/HTML, (2) interaction/passive trace evidence, (3) same-origin captured network evidence associated with that visited page. When networkEvidenceIndexPath (network-evidence.jsonl) is present, a JSON-template field may cite a captured network evidence record/body path when the value is absent from the rendered DOM but present in a browser-observed response for that same visited page. A captured network response never proves that an unvisited document URL was visited, and never substitutes for saved corpus/HTML or trace evidence when both exist. Cite it as: visited page URL, request URL, and the network evidence body/index reference.',
      // FIX-06: the complete evidence-graph entry point and its provenance/interaction semantics.
      evidenceGraph: 'pageEvidence carries one entry per visited page with explicit references (never inlined bodies/full text): htmlSnapshotPath, passiveTracePath, networkEvidenceRecords, interactionStateRecords, errorPageClassification/errorPageSignals/errorPageReason, and evidenceSources (html/network/interaction_state, possibly several at once). Use HTML + network + behavior/trace + interaction-state evidence together — a fact may come from a captured JSON response (networkEvidenceRecords) even when it is absent from the visible rendered baseline text, as long as the response was observed on that same visited page.',
      interactionState: 'interactionStateRecords on a pageEvidence entry are ALWAYS drawn from a real, executed bounded_reveal interaction record (ExecutedCandidateRow) for that page — never from a passive observation candidate. A passive candidate (detected_candidate_only / detector_error) is never interaction success and must never be reported as one; report it only as "candidate detected". Action-derived evidence (e.g. content revealed by a tab/accordion/select/combobox/load-more control) is valid only when it is backed by a real interactionStateRecords entry for that page — never inferred from the mere presence of a passive trace candidate.',
      absentEvidence: 'blocked, unsupported, timeout, and any other non-revealing executed-interaction outcome must remain reported as missing/absent evidence for that candidate — never inferred or guessed into a positive fact. Keep absent/blocked/unsupported evidence visibly distinct from positive facts in the review output; do not silently fold them together.',
    },
  };
  await writeJsonAtomic(filePath, reviewInput);

  return { reviewInputPath: filePath, urlInventoryPath };
}

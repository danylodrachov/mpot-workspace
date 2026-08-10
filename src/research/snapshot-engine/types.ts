export type SourceFamily =
  | 'entry'
  | 'dom_url_attribute'
  | 'document_metadata'
  | 'performance_resource'
  | 'inline_script_url_token'
  | 'external_script_url_token'
  | 'network_request'
  | 'network_response'
  | 'network_body_url_token'
  | 'robots_sitemap'
  | 'sitemap_url'
  | 'frame_url'
  | 'redirect';

export type UrlDecisionKind = 'accepted' | 'rejected' | 'tbd';

export interface CandidateProvenance {
  sourceFamily: SourceFamily;
  discoveredOn: string;
  sourceUrl?: string;
  label?: string;
  attribute?: string;
}

export interface RawUrlCandidate {
  rawUrl: string;
  provenance: CandidateProvenance;
}

export interface UrlDecisionRecord {
  rawUrl: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  decision: UrlDecisionKind;
  ruleId: string;
  reason: string;
  normalizedFrom?: string;
  // FIX-03: locale segment stripped from the raw/resolved URL for route-identity matching
  // (e.g. "en", "en-gb"), undefined when the URL carried no locale prefix.
  locale?: string;
  // FIX-03: once locale/redirect aliases that share one canonicalUrl are merged into a single
  // accepted target, this lists every other resolved URL that was folded into it (the chosen
  // representative's own resolvedUrl is excluded). Populated only on the merged record produced
  // at discovery freeze, never on the raw per-candidate decision log.
  aliasUrls?: string[];
  provenance: CandidateProvenance[];
}

export interface InteractiveElementTrace {
  frameUrl: string;
  domPath: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  href?: string;
  action?: string;
  visible: boolean;
  disabled: boolean;
  tabindex?: number;
  ariaExpanded?: string;
  ariaControls?: string;
  ariaHaspopup?: string;
  ariaModal?: string;
  contentEditable: boolean;
  cursorPointer: boolean;
  eventAttributeHints: string[];
  detectorHints: string[];
}

export interface VisibleOverlayTrace {
  frameUrl: string;
  domPath: string;
  tag: string;
  role?: string;
  name?: string;
  ariaModal?: string;
  open?: boolean;
}

export interface FrameTrace {
  url: string;
  name?: string;
  parentUrl?: string;
  isMainFrame: boolean;
}

export interface AutomaticDialogTrace {
  type: string;
  message: string;
  defaultValue?: string;
  autoDismissedForCrawl: boolean;
}

export interface NetworkTraceSummary {
  requests: number;
  responses: number;
  failedRequests: number;
  xhrOrFetchResponses: number;
  scriptResponses: number;
  jsonResponses: number;
  websocketConnections: number;
}

export interface RuntimeSignals {
  documentReadyState?: string;
  scriptCount: number;
  moduleScriptCount: number;
  iframeCount: number;
  lazyImageCount: number;
  lazySourceCount: number;
  loadingIndicatorCandidates: number;
  paginationCandidates: number;
  loadMoreCandidates: number;
  frameworkMarkers: string[];
}

export interface PagePassiveTrace {
  schemaVersion: '1.0';
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  title?: string;
  interactiveElements: InteractiveElementTrace[];
  visibleOverlays: VisibleOverlayTrace[];
  frames: FrameTrace[];
  automaticDialogs: AutomaticDialogTrace[];
  network: NetworkTraceSummary;
  runtimeSignals: RuntimeSignals;
  notes: string[];
}

// No deterministic access/block-page detector exists yet in this codebase; such pages are
// classified as 'failed' with reason 'blocked_suspected' until one is added (see FIX-02 ticket).
// FIX-07: 'page_capture_timeout' covers the whole capture/profiler step (navigation, settle,
// DOM/behavior profiling) blowing through its bounded per-page deadline. 'run_deadline_reached'
// covers an accepted URL that the run-level watchdog never attempted because the overall run
// deadline was already reached — a distinct terminal state from any operation that actually ran
// and failed, so downstream consumers can tell "we tried and it broke" from "we ran out of time".
// FIX-04: 'page_settle_timeout' is a narrower, more specific terminal state than
// 'page_capture_timeout' — it means navigation itself completed (finalUrl/httpStatus are known
// and preserved on the record) but the bounded deterministic settle routine (final URL +
// document readyState + rendered-DOM content-hash stability + absence of a visible loading
// indicator) never converged before its own settleMs budget ran out. Distinct from
// 'page_capture_timeout' so downstream consumers (post-run review, FIX-05) can tell "navigation
// succeeded but the DOM was never trustworthy" apart from "the whole capture step hung". A
// record with this failureReason always has status 'failed' and never has htmlPath/tracePath/
// htmlSha256 set — there is no code path where a page_settle_timeout record is also reported as
// a clean 'visited' snapshot.
export type PageFailureReason =
  | 'http_client_error'
  | 'http_server_error'
  | 'navigation_exception'
  | 'blocked_suspected'
  | 'page_capture_timeout'
  | 'page_settle_timeout'
  | 'run_deadline_reached';

export interface VisitedPageRecord {
  requestedUrl: string;
  finalUrl?: string;
  // FIX-03: the deterministic route identity this visit represents (locale-agnostic canonical
  // URL). Set for every visit scheduled from the accepted inventory so a redirect or locale
  // alias observed later can be proven to belong to this same visit rather than requiring a
  // new one.
  canonicalUrl?: string;
  // FIX-03: other requested/final URLs (locale aliases discovered pre-visit, or a same-route
  // redirect target discovered during navigation) that were merged into this one visit instead
  // of scheduling a duplicate. requestedUrl/finalUrl above remain the single navigation actually
  // performed; this is additional history, never a second navigation.
  aliasUrls?: string[];
  status: 'visited' | 'failed';
  httpStatus?: number;
  failureReason?: PageFailureReason;
  title?: string;
  htmlPath?: string;
  tracePath?: string;
  htmlSha256?: string;
  discoveredBy: CandidateProvenance[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: {
    name: string;
    message: string;
  };
}

export interface RunContextRecord {
  schemaVersion: '1.0';
  runId: string;
  entryUrl: string;
  allowedOrigin: string;
  geo?: string;
  templateDir?: string;
  startedAt: string;
  urlRulesVersion: string;
  browserMode: 'cdp';
  interactionMode: 'passive_only';
}

// One line per lifecycle event, appended as it happens so a crash mid-run still leaves a
// factual timeline of what was attempted/completed up to that point.
export interface RunEventRecord {
  timestamp: string;
  event: string;
  details?: Record<string, unknown>;
}

// One line per page-attempt terminal outcome, appended immediately after each page's
// visit/failure is resolved (never batched at end of run).
export type PageVisitRecord = VisitedPageRecord;

// One line per successfully captured page (status === 'visited'), appended immediately
// after that page's HTML/trace are written to disk.
export interface PageSnapshotRecord {
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  title?: string;
  htmlPath: string;
  tracePath: string;
  htmlSha256: string;
  capturedAt: string;
}

// One line per successfully captured page's passive-interactivity/behavior profile,
// appended immediately after that page's trace is produced.
export type PageBehaviorRecord = PagePassiveTrace;

// FIX-06: exactly one terminal status per configured source family.
// - complete:    the extractor for this source family ran to completion this run.
// - absent:      the extractor ran, but the underlying data source does not exist for this
//                 target (e.g. no sitemap.xml, no robots.txt Sitemap: directive).
// - blocked:     the extractor ran but was denied access (e.g. HTTP 403, robots disallow).
// - unsupported: this source family's extractor never actually ran during this run (not
//                 wired for this target/path) — never inferred merely from "no exception".
// - error:       the extractor threw / a bounded operation (e.g. FIX-01 body-scan timeout)
//                 failed to complete within its deadline.
export type SourceFamilyStatus = 'complete' | 'absent' | 'blocked' | 'unsupported' | 'error';

export interface SourceCoverageRecord {
  sourceFamily: SourceFamily;
  status: SourceFamilyStatus;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  tbdCount: number;
  errors: string[];
  errorDetails: Array<{ name: string; message: string }>;
  durationMs?: number;
}

// FIX-07: the run must always reach one of these three terminal states — never remain
// implicitly "still running" once run-manifest.json is written.
//   - complete: every accepted URL received a terminal visited/failed record within the run
//               deadline (individual page/source failures are still 'complete' at the run level;
//               FIX-02/FIX-06 already give those their own terminal states).
//   - partial:  the run-level watchdog deadline was reached before every accepted URL got a
//               terminal record, but at least one page was successfully visited.
//   - error:    the run-level watchdog deadline was reached and not a single accepted URL was
//               successfully visited.
export type RunStatus = 'complete' | 'partial' | 'error';

export interface DiscoveryRunManifest {
  schemaVersion: '1.0';
  runId: string;
  entryUrl: string;
  allowedOrigin: string;
  geo?: string;
  startedAt: string;
  completedAt: string;
  browserMode: 'cdp';
  urlRulesVersion: string;
  interactionMode: 'passive_only';
  status: RunStatus;
  counts: {
    discovered: number;
    accepted: number;
    rejected: number;
    tbd: number;
    visited: number;
    failed: number;
  };
  artifacts: {
    runContext: string;
    rawUrlCandidates: string;
    urlSourceCoverage: string;
    acceptedUrlInventory: string;
    deterministicRejectedUrls: string;
    urlCleanDecisions: string;
    pageVisits: string;
    pageSnapshots: string;
    pageBehavior: string;
    runEvents: string;
    reviewInput: string;
    postVisitObservations: string;
    pagesDirectory: string;
  };
}

// FIX-08: post-run review output schema. This document is produced by the LLM discovery-review
// step (Claude Code subagent invocation — see .claude/agents/discovery-reviewer.md), never by a
// raw model/API call from this codebase. This module only defines the shape and assembles the
// deterministic evidence bundle the subagent reads; it never fabricates review content itself.
//
// URL/page states are kept separate and are never collapsed into a generic "missing" bucket:
//   - discovered: every raw URL candidate seen by any source-family extractor this run.
//   - accepted / rejected: URL Rules decision outcome (url-clean-decisions.jsonl, decision !== 'tbd').
//   - visited: pages the browser actually navigated to and captured (page-visits.jsonl, status 'visited').
//   - failed: pages the browser attempted but did not successfully capture (status 'failed'), with
//             their PageFailureReason preserved verbatim (never generalized).
//   - blocked: the subset of failed pages whose failureReason is 'blocked_suspected' — access was
//              denied rather than merely erroring, kept as its own bucket per ADR-001 (official-site-only,
//              anonymous-first access-gate handling).
export interface PostRunReviewPageEvidence {
  visitedPageRequestedUrl: string;
  visitedPageFinalUrl?: string;
  htmlPath?: string;
  tracePath?: string;
  title?: string;
}

export interface PostRunReviewInteractiveCandidate {
  frameUrl: string;
  domPath: string;
  tag: string;
  role?: string;
  name?: string;
  /** Always 'detected_candidate_only' — this run performs no element interaction, so no
   *  post-action effect (e.g. "opens a modal") may ever be asserted. */
  label: 'detected_candidate_only';
}

export interface DiscoveryReviewUrlRecord {
  rawUrl: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  ruleId: string;
  reason: string;
}

// FIX-05: the reviewer control payload (review-input.json) must stay bounded by visited pages
// plus grouped/sampled URL summaries — never by the total count of discovered technical URLs
// (assets/APIs/config endpoints can run into the thousands on a real casino site). The complete,
// unbounded, full-provenance decision set is written separately to url-inventory.json
// (see UrlInventoryDocument below); review-input.json only ever references it by path.
export interface ReviewInputRuleGroupCount {
  ruleId: string;
  count: number;
}

export interface ReviewInputRuleSample {
  rawUrl: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  reason: string;
}

export interface ReviewInputRuleGroupSample {
  ruleId: string;
  // FIX-05: capped at a small fixed number per rule ID group — representative evidence only,
  // never the full set of matching URLs. The full set for this ruleId is always recoverable
  // from url-inventory.json via fullUrlInventoryPath.
  samples: ReviewInputRuleSample[];
}

export interface ReviewInputSourceFamilyCoverage {
  sourceFamily: SourceFamily;
  candidateCount: number;
}

export interface ReviewInputAcceptedTarget {
  rawUrl: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  ruleId: string;
  reason: string;
}

export interface ReviewInputDocument {
  schemaVersion: '1.1';
  runId: string;
  entryUrl: string;
  geo?: string;
  artifactBuilderMode: 'llm_post_run_only';
  templateFiles: string[];
  visitedPages: VisitedPageRecord[];
  urlCounts: {
    discovered: number;
    accepted: number;
    rejected: number;
    tbd: number;
    visited: number;
    failed: number;
  };
  // Accepted canonical research targets are small in number (bounded by real research pages on
  // a casino site, not by technical/asset noise) and are included in full — never sampled.
  acceptedTargets: ReviewInputAcceptedTarget[];
  rejectedByRule: ReviewInputRuleGroupCount[];
  tbdByRule: ReviewInputRuleGroupCount[];
  rejectedSamples: ReviewInputRuleGroupSample[];
  tbdSamples: ReviewInputRuleGroupSample[];
  sourceFamilyCoverage: ReviewInputSourceFamilyCoverage[];
  // Path to the full, unbounded, full-provenance deterministic inventory (UrlInventoryDocument)
  // on disk. Never inlined here — this is how the reviewer/downstream consumer reconstructs the
  // complete discovered/accepted/rejected/tbd picture despite the bounded payload above.
  fullUrlInventoryPath: string;
  instructions: Record<string, string>;
}

// FIX-05: the complete deterministic URL inventory, unbounded, with full per-candidate
// provenance. Written alongside review-input.json (same run directory) but never copied into
// it. This is the evidence-of-record for reconciling discovered/accepted/rejected/tbd counts;
// review-input.json only carries grouped counts and bounded samples derived from this data.
export interface UrlInventoryDocument {
  schemaVersion: '1.0';
  runId: string;
  entryUrl: string;
  geo?: string;
  generatedAt: string;
  counts: {
    discovered: number;
    accepted: number;
    rejected: number;
    tbd: number;
  };
  accepted: UrlDecisionRecord[];
  rejected: UrlDecisionRecord[];
  tbd: UrlDecisionRecord[];
}

export interface DiscoveryReviewDocument {
  schemaVersion: '1.0';
  runId: string;
  entryUrl: string;
  geo?: string;
  generatedAt: string;
  discovered: DiscoveryReviewUrlRecord[];
  accepted: DiscoveryReviewUrlRecord[];
  rejected: DiscoveryReviewUrlRecord[];
  visited: PostRunReviewPageEvidence[];
  failed: Array<PostRunReviewPageEvidence & { failureReason?: PageFailureReason }>;
  blocked: Array<PostRunReviewPageEvidence & { failureReason: 'blocked_suspected' }>;
  interactiveCandidates: PostRunReviewInteractiveCandidate[];
  notes: string[];
}

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

// CF-02: one index record per eligible network response observed by PassiveNetworkObserver.
// Appended to <runDir>/network-evidence.jsonl; raw bodies live under <runDir>/network/. This is
// evidence attached to the visited document page that produced the traffic — it never causes an
// extra navigation and never changes the deterministic URL lifecycle (see url-rules.ts).
export type NetworkEvidenceOutcome = 'captured' | 'skipped' | 'timeout' | 'error';

export interface NetworkEvidenceRecord {
  schemaVersion: '1.0';
  observedOnPageUrl: string;
  requestUrl: string;
  requestMethod: string;
  resourceType: string;
  status: number;
  contentType?: string;
  capturedAt: string;
  bodyPath?: string;
  bodySha256?: string;
  bodyBytes?: number;
  outcome: NetworkEvidenceOutcome;
  reason?: string;
}

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
  // CD-N04: deterministic interaction-execution results for this page's trace candidates.
  // Absent (undefined) on any trace produced by a passive-only capture path; present whenever
  // the CD-N04 interaction-delta-profiler ran against the live page for this capture.
  interactionExecutions?: InteractionExecutionRecord[];
  lazyScrollPass?: LazyScrollPassResult;
}

// No deterministic access/block-page detector exists yet in this codebase; such pages are
// classified as 'failed' with reason 'blocked_suspected' until one is added (see FIX-02 ticket).
// FIX-07: 'page_capture_timeout' covers the whole capture/profiler step (navigation, settle,
// DOM/behavior profiling) blowing through its bounded per-page deadline. 'run_deadline_reached'
// covers an accepted URL that the run-level watchdog never attempted because the overall run
// deadline was already reached — a distinct terminal state from any operation that actually ran
// and failed, so downstream consumers can tell "we tried and it broke" from "we ran out of time".
// FIX-09: 'page_settle_timeout' no longer denotes a *failed* visit. Real-world SPAs (ongoing
// WebSocket/analytics traffic, animations) can keep mutating their DOM well past any bounded
// settle window even though navigation itself succeeded cleanly. A page whose settle-poll loop
// never converged is still captured and reported as status: 'visited' — the bounded settle
// routine (final URL + document readyState + rendered-DOM content-hash stability + absence of a
// visible loading indicator) is now best-effort, not a mandatory success gate. This value is
// retained in the union only for historical/on-disk compatibility with runs produced before
// FIX-09 (where it did appear on status:'failed' records); no current code path sets it as a
// failureReason. Whether a *current* capture's settle poll converged is now reported via the
// separate `settleStatus` field on VisitedPageRecord/PageSnapshotRecord instead, which is always
// present and distinguishes a clean settle from a best-effort/timeout capture even though both
// are status: 'visited'.
// CD-N07: a page that was never attempted because the no-progress watchdog fired before its
// turn — distinct from 'run_deadline_reached' (the overall run-time budget was exhausted) so a
// consumer can tell "we ran out of time" apart from "nothing was progressing and we gave up".
export type PageFailureReason =
  | 'http_client_error'
  | 'http_server_error'
  | 'navigation_exception'
  | 'blocked_suspected'
  | 'page_capture_timeout'
  | 'page_settle_timeout'
  | 'run_deadline_reached'
  | 'no_progress_watchdog';

// FIX-09: whether the bounded, best-effort settle-poll loop (see waitForPageSettle in
// page-capture.ts) actually converged before its budget ran out. 'settled' means the DOM was
// observed stable/terminal/loading-indicator-free for the required consecutive samples;
// 'timeout' means the budget was exhausted first and the HTML/trace were captured from the last
// sample taken anyway (best-effort) — a consumer that cares about snapshot trustworthiness
// should treat 'timeout' captures as lower-confidence, never as indistinguishable from 'settled'.
export type SettleStatus = 'settled' | 'timeout';

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
  // FIX-09: only meaningful when status === 'visited'. Absent on 'failed' records (a failed
  // visit never reached the settle-poll step, or reached it but is still reported failed for an
  // unrelated reason such as http_client_error captured before settling was attempted).
  settleStatus?: SettleStatus;
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
  // FIX-09: mirrors VisitedPageRecord.settleStatus for this same page so a page-snapshots.jsonl
  // row can be told apart as a best-effort/unsettled capture without cross-referencing
  // page-visits.jsonl.
  settleStatus?: SettleStatus;
  title?: string;
  htmlPath: string;
  tracePath: string;
  htmlSha256: string;
  capturedAt: string;
}

// One line per successfully captured page's passive-interactivity/behavior profile,
// appended immediately after that page's trace is produced.
export type PageBehaviorRecord = PagePassiveTrace;

// CD-N04: stable action classes a trace-derived candidate can be promoted into. A candidate that
// does not deterministically match one of these (e.g. bare `custom_pointer_control` noise with no
// further ARIA/semantic evidence) is never auto-executed — see classifyActionCandidate in
// interaction-delta-profiler.ts. None of these depend on a casino hostname or a specific
// framework's component naming.
export type InteractionActionClass =
  | 'accordion_or_disclosure'
  | 'tab'
  | 'modal_trigger'
  | 'dropdown_or_combobox'
  | 'payment_method_card'
  | 'load_more'
  | 'pagination'
  | 'lazy_scroll_surface'
  | 'iframe_interaction';

// CD-N04: which deterministic evidence a candidate's locator was resolved from, in the mandated
// preference order (stable_id first, dom_path_fallback last-resort only).
export type LocatorEvidenceStrategy =
  | 'stable_id'
  | 'aria_role_name'
  | 'aria_relationship'
  | 'semantic_bounded_text'
  | 'dom_path_fallback';

export interface LocatorEvidence {
  strategy: LocatorEvidenceStrategy;
  selector: string;
  role?: string;
  name?: string;
}

// CD-N04: terminal status of one executed interaction. `revealed_evidence` is the only status
// that means "new evidence was collected" — it is set solely from a measurable before/after
// delta, never from the mere existence of the trace candidate.
export type InteractionOutcome =
  | 'revealed_evidence'
  | 'state_changed_no_new_evidence'
  | 'no_effect'
  | 'blocked'
  | 'unsafe'
  | 'timeout';

export interface InteractionDelta {
  contentChanged: boolean;
  ariaExpandedBefore?: string;
  ariaExpandedAfter?: string;
  ariaSelectedBefore?: string;
  ariaSelectedAfter?: string;
  overlayAppeared: boolean;
  frameCountBefore: number;
  frameCountAfter: number;
  urlChanged: boolean;
  // Reserved for a future wiring of bounded network counters into the delta comparison; always
  // 0 until then (see interaction-delta-profiler.ts diffStates).
  networkActivityDelta: number;
}

export interface InteractionExecutionRecord {
  frameUrl: string;
  domPath: string;
  tag: string;
  role?: string;
  name?: string;
  actionClass: InteractionActionClass;
  locatorEvidence: LocatorEvidence;
  outcome: InteractionOutcome;
  // Present whenever an action actually ran (i.e. outcome is not the result of a pre-action
  // trial-action failure that never touched the page).
  delta?: InteractionDelta;
  durationMs: number;
  note?: string;
  // CD-N05: only populated when outcome === 'revealed_evidence'. The full post-action page HTML
  // (already fetched for content-hash diffing above; retained verbatim here instead of discarded)
  // so the corpus builder (page-content-pruner.ts) can recover the text that only exists after the
  // interaction ran — the pre-action `htmlPath` capture on VisitedPageRecord never contains it.
  // Debug-only data (trace.json / page-behavior.jsonl), never written into the retained compact
  // interactions.jsonl summary row.
  afterHtml?: string;
  // CD-N05: best-effort CSS selector for the specific subtree that was revealed/changed by this
  // interaction (preferring the element's aria-controls target when present, falling back to the
  // interacted element's own domPath) — where the corpus builder should look inside `afterHtml`
  // for the revealed content, rather than diffing the whole page.
  revealedContainerSelector?: string;
}

export interface LazyScrollPassResult {
  rounds: number;
  stableRounds: number;
  timedOut: boolean;
  newContentDetected: boolean;
}

// CD-N01: one line per successfully captured page that had at least one detected passive
// interactive candidate, appended immediately after that page's behavior trace is read back.
// CD-N04: candidates that were deterministically promoted to an InteractionActionClass and
// actually executed now carry their real InteractionOutcome label and actionClass; a candidate
// that was never eligible for automatic execution (excluded by class, or execution was capped)
// keeps the original 'detected_candidate_only' label — a trace candidate alone never becomes
// 'revealed_evidence' or any other executed-outcome label without a real recorded action.
export interface InteractionCandidateRow {
  tag: string;
  role?: string;
  name?: string;
  domPath: string;
  label: 'detected_candidate_only' | InteractionOutcome;
  actionClass?: InteractionActionClass;
}

export interface InteractionCandidateRecord {
  requestedUrl: string;
  finalUrl?: string;
  capturedAt: string;
  candidateCount: number;
  candidates: InteractionCandidateRow[];
}

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

// CD-N01: the run's user-facing folder name — `<casino-slug>-<geo>-<YYYY-MM-DD>-<HH-mm-ss>`
// (UTC) — is now the *only* on-disk identifier a human ever sees; `runId` (see makeRunId) stays
// an opaque value that appears solely inside this manifest for cross-referencing/telemetry, and
// is never itself used as a folder name.
export interface DiscoveryRunManifest {
  schemaVersion: '1.1';
  runId: string;
  runFolderName: string;
  casinoName: string;
  casinoSlug: string;
  entryUrl: string;
  allowedOrigin: string;
  // CD-N01: geo actually used for the folder name (already defaulted to the GEO_FALLBACK
  // constant when the caller supplied none) — distinct from the raw optional `geo` below, which
  // preserves "caller didn't specify a geo at all" for downstream consumers that care.
  geoSlug: string;
  geo?: string;
  startedAt: string;
  completedAt: string;
  browserMode: 'cdp';
  urlRulesVersion: string;
  interactionMode: 'passive_only';
  status: RunStatus;
  toolVersions: {
    playwright?: string;
    node: string;
  };
  counts: {
    discovered: number;
    accepted: number;
    rejected: number;
    tbd: number;
    visited: number;
    failed: number;
    // CD-N01: number of interaction-candidate records written to interactions.jsonl (one row
    // per successfully captured page that had at least one detected candidate), so
    // run-manifest.json/interactions.jsonl reconcile the same way counts.visited reconciles
    // against pages.jsonl.
    interactionRecords: number;
  };
  // CD-N01: the 7-item retained artifact contract. Every path here is inside the run folder
  // named `runFolderName` above and survives an ordinary successful run unconditionally.
  artifacts: {
    runManifest: string;
    urlInventory: string;
    pages: string;
    interactions: string;
    corpusDir: string;
    jsonDir: string;
    reviewHtml: string;
    // Present only when this run's raw diagnostics were kept on disk: `debugDir` when
    // `--debug-artifacts` was passed on an ordinary successful run, `debugZip` when the run
    // terminated partial/error (packaged unconditionally so a failure is always diagnosable).
    debugDir?: string;
    debugZip?: string;
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
  // CF-03: bumped 1.1 -> 1.2 for the addition of networkEvidenceIndexPath below.
  schemaVersion: '1.2';
  runId: string;
  entryUrl: string;
  geo?: string;
  artifactBuilderMode: 'llm_post_run_only';
  templateFiles: string[];
  visitedPages: VisitedPageRecord[];
  // CF-03: path to <runDir>/network-evidence.jsonl (CF-02's index of bounded same-origin
  // xhr/fetch response bodies observed while visiting accepted document pages), when that file
  // exists for this run. Never inlined here — the reviewer reads the index/body files from disk
  // by path, exactly like fullUrlInventoryPath below. Absent (undefined) when CF-02 produced no
  // eligible network traffic this run (backward-compatible with pre-CF-02 runs).
  networkEvidenceIndexPath?: string;
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

// CD-N07: every bounded operation stage that has a configured timeout budget in
// runtime-config.ts. A call site that abandons a bounded operation on timeout should log an
// event/typed record using one of these stage names, so timeout occurrences are queryable
// consistently across the whole pipeline instead of via free-text event names.
export type TimeoutStage =
  | 'navigation'
  | 'page_settle'
  | 'response_body_scan'
  | 'network_observer_flush'
  | 'source_family_discovery'
  | 'interaction_action'
  | 'controlled_scroll_round'
  | 'interaction_expansion'
  | 'page_processing'
  | 'llm_json_build'
  | 'no_progress_watchdog';

export interface TimeoutEventRecord {
  timestamp: string;
  stage: TimeoutStage;
  budgetMs: number;
  context?: Record<string, unknown>;
}

// CD-N07: reserved for CD-N06 (LLM JSON-build/fact-extraction adapter, not yet implemented in
// this repo). 'llm_timeout' is the terminal status a hung LLM CLI child process must be recorded
// with once that adapter exists — reserved here now so CD-N06 doesn't have to invent its own
// status enum for the timeout case.
export type LlmJsonBuildStatus = 'complete' | 'error' | 'llm_timeout';

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

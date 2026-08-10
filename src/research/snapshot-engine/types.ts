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

export interface VisitedPageRecord {
  requestedUrl: string;
  finalUrl?: string;
  status: 'visited' | 'failed';
  httpStatus?: number;
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

export interface SourceCoverageRecord {
  sourceFamily: SourceFamily;
  observed: boolean;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  tbdCount: number;
  errors: string[];
}

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
  counts: {
    discovered: number;
    accepted: number;
    rejected: number;
    tbd: number;
    visited: number;
    failed: number;
  };
  artifacts: {
    urlInventory: string;
    visitedPages: string;
    sourceCoverage: string;
    reviewInput: string;
    pagesDirectory: string;
  };
}

export type SourceFamily =
  | 'entry_url'
  | 'redirect_url'
  | 'robots_sitemap'
  | 'sitemap_url'
  | 'dom_href'
  | 'document_metadata'
  | 'form_action'
  | 'frame_url'
  | 'embedded_url'
  | 'data_attribute'
  | 'inline_event_url'
  | 'inline_script_url_token'
  | 'network_request'
  | 'network_response'
  | 'network_body_url_token'
  | 'performance_resource'
  | 'history_route'
  | 'storage_url_token'
  | 'manifest_url'
  | 'service_worker_url';

export interface CandidateProvenance {
  sourceFamily: SourceFamily;
  discoveredOn: string;
  sourceUrl?: string;
  label?: string;
  attribute?: string;
  resourceType?: string;
}

export interface RawUrlObservation {
  rawUrl: string;
  baseUrl: string;
  provenance: CandidateProvenance;
  observedAt: string;
}

export type TechnicalRejectReason =
  | 'INVALID_URL'
  | 'NON_HTTP_SCHEME'
  | 'OUT_OF_SCOPE_HOST'
  | 'ASSET_SCRIPT'
  | 'ASSET_FONT'
  | 'ASSET_STYLESHEET'
  | 'ASSET_IMAGE'
  | 'ASSET_MEDIA'
  | 'SOURCE_MAP'
  | 'BROWSER_INTERNAL'
  | 'DISCOVERY_SOURCE_DOCUMENT';

export interface TechnicalDecision {
  status: 'accepted' | 'rejected';
  url?: string;
  reason?: TechnicalRejectReason;
}

export interface TechnicalCandidate {
  url: string;
  sourceFamilies: SourceFamily[];
  labels: string[];
  discoveredOn: string[];
  observationCount: number;
}

export interface TechnicalRejectedCandidate {
  rawUrl: string;
  baseUrl: string;
  reason: TechnicalRejectReason;
  sourceFamily: SourceFamily;
  discoveredOn: string;
}

export interface UrlMapRunSummary {
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  startedAt: string;
  finishedAt: string;
  pagesAttempted: number;
  pagesVisited: number;
  navigationFailures: number;
  rawObservationCount: number;
  uniqueTechnicalCandidateCount: number;
  technicalRejectedCount: number;
  sourceFamilyObservationCounts: Record<string, number>;
  sourceErrors: Array<{ sourceFamily: SourceFamily; message: string }>;
  sitemapUrlObservationCount: number;
  usableSitemapUrlCount: number;
  recursiveFallbackTriggered: boolean;
  recursiveFallbackReason?: 'NO_USABLE_SITEMAP_URLS' | 'EXPLICIT_RECURSIVE_MODE';
  recursivePagesAttempted: number;
  stoppedByMaxPages: boolean;
}

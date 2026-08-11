export type SourceFamily =
  | 'entry_url'
  | 'dom_url_attribute'
  | 'document_metadata'
  | 'frame_form_url'
  | 'network_document'
  | 'network_source_url'
  | 'performance_resource'
  | 'inline_script_url_token'
  | 'external_script_url_token'
  | 'json_config_url_token'
  | 'history_route'
  | 'robots_sitemap'
  | 'sitemap_url';

export type SourceCoverageStatus = 'complete' | 'absent' | 'blocked' | 'unsupported' | 'error';

export interface CandidateProvenance {
  sourceFamily: SourceFamily;
  discoveredOn: string;
  sourceUrl?: string;
  resourceType?: string;
  attribute?: string;
  label?: string;
}

export interface RawUrlCandidate {
  rawUrl: string;
  baseUrl: string;
  provenance: CandidateProvenance;
  observedAt: string;
}

export interface SourceCoverageRecord {
  sourceFamily: SourceFamily;
  status: SourceCoverageStatus;
  candidateCount: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type UrlDecisionKind = 'accepted' | 'rejected' | 'tbd';

export interface UrlDecision {
  rawUrl: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  decision: UrlDecisionKind;
  ruleId: string;
  reason: string;
  provenance: CandidateProvenance[];
}

export interface DiscoveryResult {
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  rawCandidates: RawUrlCandidate[];
  sourceCoverage: SourceCoverageRecord[];
  decisions: UrlDecision[];
  accepted: UrlDecision[];
  rejected: UrlDecision[];
  tbd: UrlDecision[];
  technicalSourceUrls: string[];
  startedAt: string;
  finishedAt: string;
}

export interface RequestLike {
  url(): string;
  resourceType(): string;
  redirectedFrom?(): RequestLike | null;
}

export interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): RequestLike;
}

export interface APIResponseLike {
  ok(): boolean;
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
  body(): Promise<Buffer>;
  dispose?(): Promise<void>;
}

export interface APIRequestContextLike {
  get(url: string, options?: { timeout?: number; failOnStatusCode?: boolean; maxRedirects?: number }): Promise<APIResponseLike>;
}

export interface BrowserContextLike {
  request: APIRequestContextLike;
  addInitScript(script: string | { content?: string }): Promise<unknown>;
  on(event: 'request', handler: (request: RequestLike) => void): unknown;
  on(event: 'response', handler: (response: ResponseLike) => void): unknown;
  off?(event: 'request' | 'response', handler: (...args: any[]) => void): unknown;
}

export interface PageLike {
  url(): string;
  context(): BrowserContextLike;
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number }): Promise<ResponseLike | null>;
  evaluate<R, A = void>(pageFunction: ((arg: A) => R | Promise<R>) | string, arg?: A): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
}

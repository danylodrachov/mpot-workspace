export type SourceFamily =
  | 'entry_url'
  | 'dom_url_attribute'
  | 'document_metadata'
  | 'network_document'
  | 'network_source_url'
  | 'performance_resource'
  | 'inline_script_url_token'
  | 'history_route'
  | 'external_script_url_token'
  | 'json_config_url_token'
  | 'sitemap_page_url';

export interface CandidateProvenance {
  sourceFamily: SourceFamily;
  discoveredOn: string;
  sourceUrl?: string;
  resourceType?: string;
  label?: string;
}

export interface RawUrlCandidate {
  rawUrl: string;
  baseUrl: string;
  provenance: CandidateProvenance;
  observedAt: string;
}

export interface ObservedTechnicalSource {
  url: string;
  resourceType?: string;
  discoveredOn: string;
}

export interface TechnicalSourceError {
  url: string;
  code: string;
  message: string;
}

export interface SeedDiscoveryResult {
  entryUrl: string;
  finalEntryUrl: string;
  allowedHosts: string[];
  rawCandidates: RawUrlCandidate[];
  observedTechnicalSources: ObservedTechnicalSource[];
  technicalSourceErrors: TechnicalSourceError[];
}

export interface RequestLike {
  url(): string;
  resourceType(): string;
}

export interface NavigationResponseLike {
  status(): number;
  headers?(): Record<string, string>;
  body?(): Promise<Buffer>;
  url?(): string;
}

export interface ApiResponseLike {
  ok(): boolean;
  status(): number;
  headers(): Record<string, string>;
  url?(): string;
  body(): Promise<Buffer>;
}

export interface ApiRequestContextLike {
  get(url: string, options?: { timeout?: number; failOnStatusCode?: boolean; maxRedirects?: number }): Promise<ApiResponseLike>;
}

export interface PageLike {
  request: ApiRequestContextLike;
  url(): string;
  addInitScript(script: () => void): Promise<void>;
  on(event: 'request', listener: (request: RequestLike) => void): void;
  off?(event: 'request', listener: (request: RequestLike) => void): void;
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<NavigationResponseLike | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}

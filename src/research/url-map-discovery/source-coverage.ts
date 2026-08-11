import type { SourceCoverageRecord, SourceCoverageStatus, SourceFamily } from './types.ts';

export const CONFIGURED_SOURCE_FAMILIES: readonly SourceFamily[] = [
  'entry_url',
  'dom_url_attribute',
  'document_metadata',
  'frame_form_url',
  'network_document',
  'network_source_url',
  'performance_resource',
  'inline_script_url_token',
  'external_script_url_token',
  'json_config_url_token',
  'history_route',
  'robots_sitemap',
  'sitemap_url',
] as const;

export class SourceCoverageTracker {
  #records = new Map<SourceFamily, SourceCoverageRecord>();

  set(sourceFamily: SourceFamily, status: SourceCoverageStatus, candidateCount: number, details: Partial<SourceCoverageRecord> = {}): void {
    this.#records.set(sourceFamily, { sourceFamily, status, candidateCount, ...details });
  }

  addCount(sourceFamily: SourceFamily, count: number): void {
    const current = this.#records.get(sourceFamily);
    if (!current) this.set(sourceFamily, count > 0 ? 'complete' : 'absent', count);
    else current.candidateCount += count;
  }

  finalize(): SourceCoverageRecord[] {
    return CONFIGURED_SOURCE_FAMILIES.map(sourceFamily => this.#records.get(sourceFamily) ?? {
      sourceFamily,
      status: 'unsupported' as const,
      candidateCount: 0,
      errorCode: 'SOURCE_NOT_EXECUTED',
      errorMessage: 'Configured source family was not executed by this discovery run.',
    });
  }
}

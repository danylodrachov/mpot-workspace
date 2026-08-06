/**
 * Observation-backed provider seam (Issue 24).
 *
 * Browser agents (`url-map-recon`, `discovery-browser`) never invoke deterministic
 * TypeScript and deterministic TypeScript never invokes Playwright (ADR-001). The
 * handoff runs one way: an agent observes the live site and appends structured
 * `PageObservation` records to `page-observations.jsonl` in the run directory. This
 * module is the only thing that reads that file — it turns recorded observations into
 * the same provider functions stages 1-5 and 8-13 already accept from fixtures, so a
 * fixture-backed run and a live run are interchangeable behind the seam.
 *
 * An observation the agent could not obtain (`status !== 'present'`) is never
 * fabricated into content — it is surfaced with its `reason` and treated as "no
 * observation available", letting the calling stage fall back to its own blocked/empty
 * handling exactly as it would for a fixture with nothing recorded.
 */

import fs from 'node:fs';
import type { ExtractorInput, RecipeStepV1, SectionBehavior } from './url-map-recon/types.ts';
import type { PageObservation } from './url-map-recon/types.ts';
import type { InputProvider } from './stage-dispatcher.ts';
import type { PageObservationProvider } from './page-interactivity-profiler.ts';
import type { InteractionObservationProvider, InteractionRecord } from './interaction-delta-profiler.ts';
import type { ProductObservationProvider, RawProductItem } from './url-map-recon/product-collector.ts';

/** Reads `page-observations.jsonl`, skipping blank lines. Missing file reads as empty. */
export function readObservations(observationsPath: string): PageObservation[] {
  if (!fs.existsSync(observationsPath)) return [];
  return fs
    .readFileSync(observationsPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PageObservation);
}

/**
 * Stage 1-5 seam: converts a recorded observation for `step.extractorId` into the
 * `ExtractorInput` an extractor expects. A `blocked`/`absent` observation is passed
 * through as `sourceStatus` rather than synthesized content, so the deterministic
 * extractor records the same "could not reach this source" outcome it would for a
 * recorded-fixture run.
 */
export function createUrlInputProvider(observations: PageObservation[]): InputProvider {
  // First-seen observation per extractor id wins, matching the same first-seen
  // order the stage-dispatcher's recipe builder uses to decide which extractor
  // ids to request at all (Issue 27) — otherwise the step built from the first
  // observation could resolve content from a later, different one.
  const byExtractor = new Map<string, PageObservation>();
  for (const obs of observations) {
    if (!byExtractor.has(obs.extractor_id)) byExtractor.set(obs.extractor_id, obs);
  }

  return (step: RecipeStepV1): ExtractorInput => {
    const obs = byExtractor.get(step.extractorId);
    if (!obs) {
      return { pageUrl: step.pageUrl };
    }

    if (obs.status === 'blocked' || obs.status === 'absent') {
      return { pageUrl: obs.page_url, sourceStatus: obs.status, observationId: obs.observation_id };
    }
    if (obs.status === 'error' || obs.content === undefined) {
      return { pageUrl: obs.page_url, observationId: obs.observation_id };
    }

    const input: ExtractorInput = { pageUrl: obs.page_url, observationId: obs.observation_id };
    switch (obs.content_type) {
      case 'html':
        input.html = obs.content as string;
        break;
      case 'scripts':
        input.scripts = obs.content as string[];
        break;
      case 'json':
        input.json = obs.content as string;
        break;
      case 'text':
        input.text = obs.content as string;
        break;
      case 'candidates':
        input.candidates = obs.content as string[];
        break;
    }
    return input;
  };
}

/** Stage 8 seam: a `present` PAGE_BEHAVIOR_OBSERVATION_V1 observation per URL, parsed back into SectionBehavior. */
export function createPageObservationProvider(observations: PageObservation[]): PageObservationProvider {
  const byUrl = new Map<string, PageObservation>();
  for (const obs of observations) {
    if (obs.extractor_id === 'PAGE_BEHAVIOR_OBSERVATION_V1') byUrl.set(obs.page_url, obs);
  }

  return (url: string): SectionBehavior | null => {
    const obs = byUrl.get(url);
    if (!obs || obs.status !== 'present' || typeof obs.content !== 'string') return null;
    return JSON.parse(obs.content) as SectionBehavior;
  };
}

/** Stage 9 seam: a `present` INTERACTION_OBSERVATION_V1 observation per URL, parsed back into InteractionRecord. */
export function createInteractionObservationProvider(observations: PageObservation[]): InteractionObservationProvider {
  const byUrl = new Map<string, PageObservation>();
  for (const obs of observations) {
    if (obs.extractor_id === 'INTERACTION_OBSERVATION_V1') byUrl.set(obs.page_url, obs);
  }

  return (url: string): InteractionRecord | null => {
    const obs = byUrl.get(url);
    if (!obs || obs.status !== 'present' || typeof obs.content !== 'string') return null;
    return JSON.parse(obs.content) as InteractionRecord;
  };
}

/**
 * Stage 12 seam: a `present` PRODUCT_OBSERVATION_V1 observation per URL, whose content
 * is `{"section": ProductSection, "items": RawProductItem[]}` serialized as JSON text.
 */
export function createProductObservationProvider(observations: PageObservation[]): ProductObservationProvider {
  const byUrl = new Map<string, { section: string; items: RawProductItem[] }>();
  for (const obs of observations) {
    if (obs.extractor_id !== 'PRODUCT_OBSERVATION_V1' || obs.status !== 'present' || typeof obs.content !== 'string') {
      continue;
    }
    byUrl.set(obs.page_url, JSON.parse(obs.content) as { section: string; items: RawProductItem[] });
  }

  return (section, url) => {
    const entry = byUrl.get(url);
    if (!entry || entry.section !== section) return [];
    return entry.items;
  };
}

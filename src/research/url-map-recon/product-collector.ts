// Deterministic product collector — separated from URL/route discovery
// (url-map-recon owns URLs only; this module owns product name normalization).
//
// It may inspect raw source content internally (its inputs simulate the raw
// title/name arrays a browser_evaluate call would have already distilled),
// but it must persist ONLY normalized product lists — never raw DOM/JSON/
// script/response bodies. Output depth: slots -> slot names, live-casino ->
// category names only, sports -> sport names only. Never individual
// tables/games/matches/fixtures/teams/leagues/tournaments/event pages.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProductEntry, ProductSection, ProductSectionResult } from './types.ts';
import type { PageBehaviorProfile } from './types.ts';
import type { VisitPlanEntry } from '../relevance-validator.ts';
import { PAGE_BEHAVIOR_ARTIFACT } from '../discovery-types.ts';

const MAX_ITEMS = 500;
const MAX_TITLE_LENGTH = 120;

// Fixture-shaped names ("Team A vs Team B", "Team A @ Team B") indicate an
// individual match/event, not a category/product name — always excluded.
const FIXTURE_PATTERN = /\s+(vs\.?|v\.?|@)\s+/i;

export type RawProductItem = { name: string; url?: string | null };

function normalizeTitle(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function collectProducts(section: ProductSection, rawItems: RawProductItem[]): ProductSectionResult {
  if (rawItems.length === 0) {
    return { section, status: 'absent', reason: 'no items supplied' };
  }

  const seen = new Set<string>();
  const items: ProductEntry[] = [];

  for (const raw of rawItems) {
    if (items.length >= MAX_ITEMS) break;
    if (!raw || typeof raw.name !== 'string') continue;
    const title = normalizeTitle(raw.name);
    if (!title || title.length > MAX_TITLE_LENGTH) continue;
    if (FIXTURE_PATTERN.test(title)) continue; // individual event/fixture — excluded
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, url: raw.url ?? null });
  }

  if (items.length === 0) {
    return { section, status: 'absent', reason: 'all supplied items were filtered as fixtures or invalid' };
  }

  return { section, items };
}

const PRODUCT_SECTIONS: ProductSection[] = ['sports', 'live-casino', 'slots'];

/**
 * Injected provider for raw product titles observed for a section's page.
 * Supplies title-level data only — never per-game/table/event detail — so the
 * caller decides what counts as "observed" rather than this module inferring
 * it from the URL alone.
 */
export type ProductObservationProvider = (section: ProductSection, url: string) => RawProductItem[];

/**
 * Collect product candidates for every visit-plan-selected page whose section is a
 * product section (sports, live-casino, slots) and persist them as product-candidates.json.
 *
 * Refuses to run before behaviour instructions exist for the page (mirrors field
 * collection's ordering constraint) and never descends into individual game, table,
 * or event pages — only title-level entries are ever produced.
 *
 * @throws Error if page-behavior.json doesn't exist
 */
export async function collectAndPersistProductCandidates(
  pageBehaviorPath: string,
  visitPlanPath: string,
  outputPath: string,
  provider?: ProductObservationProvider,
): Promise<void> {
  if (!existsSync(pageBehaviorPath)) {
    throw new Error(
      `${PAGE_BEHAVIOR_ARTIFACT} not found at ${pageBehaviorPath}. ` +
      'Product collection cannot run before behaviour instructions exist.'
    );
  }

  const pageBehavior: PageBehaviorProfile = JSON.parse(readFileSync(pageBehaviorPath, 'utf-8'));

  let selectedUrls: Set<string> | null = null;
  if (existsSync(visitPlanPath)) {
    const visitPlan: VisitPlanEntry[] = JSON.parse(readFileSync(visitPlanPath, 'utf-8'));
    selectedUrls = new Set(visitPlan.filter((entry) => entry.selected).map((entry) => entry.canonicalUrl));
  }

  const results: ProductSectionResult[] = [];

  for (const productSection of PRODUCT_SECTIONS) {
    const sectionData = pageBehavior.sections?.[productSection as keyof typeof pageBehavior.sections] as any;
    if (!sectionData || 'status' in sectionData) {
      continue; // section absent/blocked — no candidates to collect
    }

    const url: string = sectionData.url;
    if (selectedUrls && !selectedUrls.has(url)) {
      continue; // page not in visit plan — no evidence
    }

    if (!provider) {
      results.push({ section: productSection, status: 'absent', reason: 'no observation provider supplied' });
      continue;
    }

    const rawItems = provider(productSection, url);
    results.push(collectProducts(productSection, rawItems));
  }

  writeFileSync(outputPath, JSON.stringify({ sections: results }, null, 2));
}

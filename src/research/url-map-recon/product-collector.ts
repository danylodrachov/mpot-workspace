// Deterministic product collector — separated from URL/route discovery
// (url-map-recon owns URLs only; this module owns product name normalization).
//
// It may inspect raw source content internally (its inputs simulate the raw
// title/name arrays a browser_evaluate call would have already distilled),
// but it must persist ONLY normalized product lists — never raw DOM/JSON/
// script/response bodies. Output depth: slots -> slot names, live-casino ->
// category names only, sports -> sport names only. Never individual
// tables/games/matches/fixtures/teams/leagues/tournaments/event pages.

import type { ProductEntry, ProductSection, ProductSectionResult } from './types.ts';

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

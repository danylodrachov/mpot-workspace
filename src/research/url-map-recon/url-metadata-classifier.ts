// URL metadata classification layer for url-map-recon.
//
// Replaces template-based classifications with URL metadata classification.
// Derives page class, mandatory flags, product category landing flags, and
// other metadata strictly from URL structure, with no network or browser I/O.
//
// Mandatory classes: cashier, deposit, withdrawal, bonuses, terms and conditions.

import type { UrlMapEntry } from './types.ts';
import { writeAtomicJSON } from '../artifact-writer.ts';
import path from 'node:path';
import fs from 'node:fs/promises';

// Mandatory page class indicators
const MANDATORY_INDICATORS: Record<string, RegExp> = {
  cashier: /(^|\/)cashier(\/|$)/i,
  deposit: /(^|\/)deposit(s)?(\/|$)/i,
  withdrawal: /(^|\/)withdraw(al)?(s)?(\/|$)/i,
  bonuses: /(^|\/)bonus(es)?(-terms|-rules)?(\/|$)/i,
  terms: /(^|\/)terms?(\/|$)/i,
  terms_and_conditions: /(^|\/)terms?[-_](and|&)[-_]conditions?(\/|$)/i,
};

// Product category landing pages
const PRODUCT_LANDING_INDICATORS: Record<string, RegExp> = {
  slots: /(^|\/)slots?(\/|$)/i,
  'live-casino': /(^|\/)live[-_]casino(\/|$)/i,
  sports: /(^|\/)sports?(\/|$)/i,
  'virtual-sports': /(^|\/)virtual[-_]sports(\/|$)/i,
  'horse-racing': /(^|\/)horse[-_]racing(\/|$)/i,
};

// Sport category landing pages
const SPORT_CATEGORIES = [
  'football',
  'soccer',
  'tennis',
  'basketball',
  'volleyball',
  'esports',
  'e-sports',
  'ufc',
  'ice-hockey',
  'table-tennis',
  'horse-racing',
  'cricket',
  'baseball',
  'boxing',
  'rugby',
  'handball',
];

export type ClassifiedEntry = UrlMapEntry & {
  routeTokens: string[];
  slugLabel?: string;
  pageClass?: string;
  isMandatory: boolean;
  isProductCategoryLanding: boolean;
  sourceConfidence: number;
  redirectStatus: string;
};

/**
 * Extract route tokens from a canonical URL.
 * Route tokens are the path segments (e.g., ['sports', 'football'] from /sports/football).
 */
function extractRouteTokens(canonicalUrl: string): string[] {
  try {
    const url = new URL(canonicalUrl);
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Determine the page class from URL metadata.
 * Returns the most specific mandatory class if found, or product/sport landing, or undefined.
 */
function determinePageClass(canonicalUrl: string, routeTokens: string[]): string | undefined {
  const pathname = canonicalUrl.split('?')[0].split('#')[0].toLowerCase();

  // Check mandatory indicators (in priority order)
  for (const [pageClass, re] of Object.entries(MANDATORY_INDICATORS)) {
    if (re.test(pathname)) {
      return pageClass;
    }
  }

  // Check product landing indicators
  for (const [pageClass, re] of Object.entries(PRODUCT_LANDING_INDICATORS)) {
    if (re.test(pathname)) {
      return pageClass;
    }
  }

  // Check if first token is a sport category
  if (routeTokens.length > 0 && SPORT_CATEGORIES.includes(routeTokens[0])) {
    if (routeTokens.length === 1) {
      return routeTokens[0]; // Sport category landing
    }
  }

  return undefined;
}

/**
 * Determine if a URL represents a mandatory page class.
 * Mandatory classes: cashier, deposit, withdrawal, bonuses, terms and conditions.
 */
function isMandatoryClass(pageClass: string | undefined): boolean {
  if (!pageClass) return false;
  return [
    'cashier',
    'deposit',
    'withdrawal',
    'bonuses',
    'bonus',
    'terms',
    'terms_and_conditions',
  ].includes(pageClass);
}

/**
 * Determine if a URL represents a product category landing page.
 */
function isProductLanding(pageClass: string | undefined): boolean {
  if (!pageClass) return false;
  return [
    'slots',
    'live-casino',
    'live_casino',
    'sports',
    'virtual-sports',
    'virtual_sports',
    'horse-racing',
    'horse_racing',
  ].includes(pageClass);
}

/**
 * Assign a source confidence score based on the entry source type.
 * Higher confidence for direct URL sources, lower for inferred ones.
 */
function assignSourceConfidence(source: string): number {
  const confidenceMap: Record<string, number> = {
    dom_anchor: 0.95,
    config_route: 0.98,
    bundle_footer: 0.90,
    bundle_seo: 0.92,
    bundle_other: 0.85,
    external: 0.60,
    robots_sitemap: 0.88,
    sitemap_index: 0.88,
    performance_resource: 0.70,
    network_request: 0.75,
    framework_manifest: 0.80,
    spa_route: 0.85,
    document_metadata: 0.80,
    frame_form: 0.75,
  };

  return confidenceMap[source] ?? 0.50;
}

/**
 * Determine redirect status from URL patterns.
 * Typically 'none' (direct) or 'possible' (might be redirected).
 */
function determineRedirectStatus(canonicalUrl: string): string {
  // If URL contains query params or uncommon patterns, might be a redirect
  if (canonicalUrl.includes('?') || canonicalUrl.includes('redirect') || canonicalUrl.includes('forward')) {
    return 'possible';
  }
  return 'none';
}

/**
 * Classify a single URL entry with metadata.
 * Pure function: no I/O, deterministic output for same input.
 */
export function classifyMetadata(entry: UrlMapEntry): ClassifiedEntry {
  const routeTokens = extractRouteTokens(entry.canonicalUrl);
  const pageClass = determinePageClass(entry.canonicalUrl, routeTokens);
  const isMandatory = isMandatoryClass(pageClass);
  const isProductCategoryLanding = isProductLanding(pageClass);
  const sourceConfidence = assignSourceConfidence(entry.source);
  const redirectStatus = determineRedirectStatus(entry.canonicalUrl);

  return {
    ...entry,
    routeTokens,
    slugLabel: entry.derivedLabel,
    pageClass,
    isMandatory,
    isProductCategoryLanding,
    sourceConfidence,
    redirectStatus,
  };
}

/**
 * Read clean-url-inventory.json, classify all entries, and write back.
 * Produces an updated clean-url-inventory.json with classification metadata.
 */
export async function classifyAndPersist(outputDir: string, inventory?: UrlMapEntry[]): Promise<void> {
  let entries: UrlMapEntry[];

  // If inventory not provided, read from file
  if (!inventory) {
    const inventoryPath = path.join(outputDir, 'clean-url-inventory.json');
    try {
      const data = await fs.readFile(inventoryPath, 'utf-8');
      entries = JSON.parse(data);
    } catch {
      entries = [];
    }
  } else {
    entries = inventory;
  }

  // Classify all entries
  const classified: ClassifiedEntry[] = entries.map(classifyMetadata);

  // Write back to clean-url-inventory.json
  const inventoryPath = path.join(outputDir, 'clean-url-inventory.json');
  await writeAtomicJSON(inventoryPath, classified);
}

// Deterministic URL cleaning / classification layer for url-map-recon.
//
// Encodes the "Keep / drop" prose rules that previously lived only in
// .claude/agents/url-map-recon.md into code, so recon output and recipe
// replay share one classification behavior. This does not change the
// behavior the agent already followed — it gives it a first code home
// (see sessions/week-30-2026/2026-07-24-discovery-pipeline-url-map-facts.md).
//
// Keep (same-origin): compliance/info pages (terms, privacy, licence,
// responsible-gaming, cookie, about, payment/limits, bonus/promo rules),
// product LANDING pages, help/support content pages. Approved external:
// licence authorities, payment-service domains.
//
// Drop: individual game/table/event/match/prematch pages, per-sport event
// roots beyond the landing segment, functional endpoints (login, register,
// deposit, withdraw, logout, phone-confirmation), assets, API endpoints,
// tracking/CDN hosts, fragment-only and non-http URLs.

import type { EntrySource, OriginStatus, UrlMapEntry } from './types.ts';
import { writeAtomicJSON, writeAppendOnlyJSONL } from '../artifact-writer.ts';
import path from 'node:path';

// Rule registry: each rule has a stable ID, version, priority, and scope
interface Rule {
  ruleId: string;
  ruleVersion: string;
  priority: number;
  proofScope: string;
}

// Functional endpoints that should be dropped (account interaction, not documents)
const FUNCTIONAL_ENDPOINT_TRASH: Array<{ re: RegExp; rule: Rule }> = [
  { re: /(^|\/)login(\/|$)/, rule: { ruleId: 'FUNCTIONAL_LOGIN', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)sign-?in(\/|$)/, rule: { ruleId: 'FUNCTIONAL_SIGNIN', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)register(\/|$)/, rule: { ruleId: 'FUNCTIONAL_REGISTER', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)sign-?up(\/|$)/, rule: { ruleId: 'FUNCTIONAL_SIGNUP', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)logout(\/|$)/, rule: { ruleId: 'FUNCTIONAL_LOGOUT', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)phone-confirmation(\/|$)/, rule: { ruleId: 'FUNCTIONAL_PHONE_CONFIRM', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
];

const ASSET_EXTENSION_RE =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|json|xml|txt|map)$/i;
const ASSET_RULE: Rule = { ruleId: 'ASSET_EXTENSION', ruleVersion: '1.0', priority: 11, proofScope: 'file_extension' };

const API_ENDPOINT_TRASH: Array<{ re: RegExp; rule: Rule }> = [
  { re: /(^|\/)api(\/|$)/, rule: { ruleId: 'API_ENDPOINT', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)graphql(\/|$)/, rule: { ruleId: 'API_GRAPHQL', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
  { re: /(^|\/)_next\/(static|data)(\/|$)/, rule: { ruleId: 'NEXT_JS_INTERNAL', ruleVersion: '1.0', priority: 10, proofScope: 'route_path' } },
];

const TRACKING_CDN_HOSTS: Array<{ re: RegExp; rule: Rule }> = [
  { re: /(^|\.)google-analytics\.com$/, rule: { ruleId: 'TRACKING_GOOGLE_ANALYTICS', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)googletagmanager\.com$/, rule: { ruleId: 'TRACKING_GOOGLE_TAG_MGR', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)doubleclick\.net$/, rule: { ruleId: 'TRACKING_DOUBLECLICK', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)facebook\.net$/, rule: { ruleId: 'TRACKING_FACEBOOK', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)hotjar\.com$/, rule: { ruleId: 'TRACKING_HOTJAR', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)cloudflare\.com$/, rule: { ruleId: 'TRACKING_CLOUDFLARE', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
  { re: /(^|\.)cdn\./, rule: { ruleId: 'TRACKING_CDN_PREFIX', ruleVersion: '1.0', priority: 12, proofScope: 'hostname' } },
];

const INDIVIDUAL_EVENT_TRASH: Array<{ re: RegExp; rule: Rule }> = [
  { re: /(^|\/)(game|table|match|event|prematch|fixture|tournament|league)\/[^/]+/, rule: { ruleId: 'INDIVIDUAL_EVENT_PAGE', ruleVersion: '1.0', priority: 8, proofScope: 'route_path' } },
  { re: /(^|\/)(games|tables|matches|events|tournaments|leagues)\/[a-z0-9-]+\/[a-z0-9-]+/, rule: { ruleId: 'INDIVIDUAL_EVENT_NESTED', ruleVersion: '1.0', priority: 8, proofScope: 'route_path' } },
];

const SPORT_CATEGORY_TOKENS = new Set([
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
]);

const PRODUCT_LANDING_TOKENS = new Set(['slots', 'live-casino', 'sports', 'virtual-sports', 'horse-racing']);

// Routes to KEEP per issue 95: bonus/promo/offer, payment/deposit/withdrawal/cashier, limits, terms/rules
const KEEP_ROUTES: Array<{ re: RegExp; rule: Rule }> = [
  // Bonus / promo / offer (with optional plural/terms/rules)
  { re: /(^|\/)bonus(es)?(-terms|-rules)?(\/|$)/, rule: { ruleId: 'KEEP_BONUS', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)promo(tion)?s?(-rules)?(\/|$)/, rule: { ruleId: 'KEEP_PROMO', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)offer(s)?(\/|$)/, rule: { ruleId: 'KEEP_OFFER', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  // Payment / deposit / withdrawal / cashier (payment methods & transaction pages)
  { re: /(^|\/)payments?((-method)?s?)?(\/|$)/, rule: { ruleId: 'KEEP_PAYMENT', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)deposits?(\/|$)/, rule: { ruleId: 'KEEP_DEPOSIT', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)withdraw(al)?s?(\/|$)/, rule: { ruleId: 'KEEP_WITHDRAWAL', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)cashier(s)?(\/|$)/, rule: { ruleId: 'KEEP_CASHIER', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  // Limits (standalone or with specific prefix)
  { re: /(^|\/)limits?(\/|$)/, rule: { ruleId: 'KEEP_LIMITS', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)(deposit|withdrawal|loss|bet|time)[-_]?limits?(\/|$)/, rule: { ruleId: 'KEEP_LIMITS_PREFIXED', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  // Terms and Rules (standalone, or with and-conditions, or and-rules, or combined)
  { re: /(^|\/)terms?(\/|$)/, rule: { ruleId: 'KEEP_TERMS', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)terms?[-_](and|&)[-_]conditions?(\/|$)/, rule: { ruleId: 'KEEP_TERMS_CONDITIONS', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)terms?[-_](and|&)[-_]rules?(\/|$)/, rule: { ruleId: 'KEEP_TERMS_RULES', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
  { re: /(^|\/)rules?(\/|$)/, rule: { ruleId: 'KEEP_RULES', ruleVersion: '1.0', priority: 1, proofScope: 'route_path' } },
];

// Routes to TRASH (remove) per issue 95
const TRASH_ROUTES: Array<{ re: RegExp; rule: Rule }> = [
  // Account data routes
  { re: /(^|\/)account(\/|$)/, rule: { ruleId: 'TRASH_ACCOUNT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)my-account(\/|$)/, rule: { ruleId: 'TRASH_MY_ACCOUNT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)profile(\/|$)/, rule: { ruleId: 'TRASH_PROFILE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)my-profile(\/|$)/, rule: { ruleId: 'TRASH_MY_PROFILE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)settings(\/|$)/, rule: { ruleId: 'TRASH_SETTINGS', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)my-settings(\/|$)/, rule: { ruleId: 'TRASH_MY_SETTINGS', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)personal-?data(\/|$)/, rule: { ruleId: 'TRASH_PERSONAL_DATA', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // KYC / identity verification
  { re: /(^|\/)kyc(\/|$)/, rule: { ruleId: 'TRASH_KYC', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)verification(\/|$)/, rule: { ruleId: 'TRASH_VERIFICATION', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)identity[-_]verification(\/|$)/, rule: { ruleId: 'TRASH_IDENTITY_VERIFICATION', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Responsible gambling / self-exclusion
  { re: /(^|\/)responsible[-_](gambling|gaming)(\/|$)/, rule: { ruleId: 'TRASH_RESPONSIBLE_GAMBLING', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)self[-_]?exclu/, rule: { ruleId: 'TRASH_SELF_EXCLUSION', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Support / help
  { re: /(^|\/)support(\/|$)/, rule: { ruleId: 'TRASH_SUPPORT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)help(\/|$)/, rule: { ruleId: 'TRASH_HELP', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)customer[-_]support(\/|$)/, rule: { ruleId: 'TRASH_CUSTOMER_SUPPORT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)help[-_]center(\/|$)/, rule: { ruleId: 'TRASH_HELP_CENTER', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Privacy / cookie policy
  { re: /(^|\/)privacy(-policy)?(\/|$)/, rule: { ruleId: 'TRASH_PRIVACY', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)cookie(-policy)?(\/|$)/, rule: { ruleId: 'TRASH_COOKIE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)cookies(\/|$)/, rule: { ruleId: 'TRASH_COOKIES', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Legal / compliance (drop detailed legal pages)
  { re: /(^|\/)licen[cs]e(\/|$)/, rule: { ruleId: 'TRASH_LICENSE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)licence(\/|$)/, rule: { ruleId: 'TRASH_LICENCE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)aml[-_]policy(\/|$)/, rule: { ruleId: 'TRASH_AML_POLICY', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)kyc[-_]policy(\/|$)/, rule: { ruleId: 'TRASH_KYC_POLICY', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)dispute[-_]resolution(\/|$)/, rule: { ruleId: 'TRASH_DISPUTE_RESOLUTION', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)disputes(\/|$)/, rule: { ruleId: 'TRASH_DISPUTES', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Corporate / editorial
  { re: /(^|\/)corporate(\/|$)/, rule: { ruleId: 'TRASH_CORPORATE', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)editorial(\/|$)/, rule: { ruleId: 'TRASH_EDITORIAL', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)about([-_]us)?(\/|$)/, rule: { ruleId: 'TRASH_ABOUT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Lobby / instant / crash
  { re: /(^|\/)lobby(\/|$)/, rule: { ruleId: 'TRASH_LOBBY', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)instant[-_]games(\/|$)/, rule: { ruleId: 'TRASH_INSTANT_GAMES', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)instant(\/|$)/, rule: { ruleId: 'TRASH_INSTANT', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)crash(\/|$)/, rule: { ruleId: 'TRASH_CRASH', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  // Transaction history
  { re: /(^|\/)transaction(s)?(-history)?(\/|$)/, rule: { ruleId: 'TRASH_TRANSACTION', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
  { re: /(^|\/)history(\/|$)/, rule: { ruleId: 'TRASH_HISTORY', ruleVersion: '1.0', priority: 7, proofScope: 'route_path' } },
];

export type CleanResult = {
  keep: boolean;
  reason: string;
  url: string;
  ruleId: string;
  ruleVersion: string;
  priority: number;
  proofScope: string;
};

export type UrlDecisionRow = {
  rawUrl: string;
  canonicalUrl: string;
  keep: boolean;
  reason: string;
  source: EntrySource;
  ruleId: string;
  ruleVersion: string;
  priority: number;
  proofScope: string;
  researchableFields?: Record<string, string>;
};

function toURL(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** Normalize a path for matching: lowercase, collapse slashes, decode, handle underscores. */
function normalizePathForMatching(pathname: string): string {
  // Lowercase
  let norm = pathname.toLowerCase();
  // Decode URL-encoded characters
  try {
    norm = decodeURIComponent(norm);
  } catch {
    // If decoding fails, use as-is
  }
  // Treat underscores as hyphens for matching (but preserve in output)
  norm = norm.replace(/_/g, '-');
  // Collapse repeated slashes
  norm = norm.replace(/\/+/g, '/');
  return norm;
}

/** Classify one absolute URL against the keep/drop rules. Deterministic, no I/O. */
export function classifyUrl(
  rawUrl: string,
  opts: { origin: string; approvedExternalHosts?: RegExp[] } = { origin: '' },
): CleanResult {
  const url = toURL(rawUrl);
  if (!url) return { keep: false, reason: 'not_a_url', url: rawUrl, ruleId: 'INVALID_URL', ruleVersion: '1.0', priority: 99, proofScope: 'url_format' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { keep: false, reason: 'non_http_protocol', url: rawUrl, ruleId: 'NON_HTTP_PROTOCOL', ruleVersion: '1.0', priority: 99, proofScope: 'protocol' };
  }
  if (!url.pathname || url.pathname === '/') {
    // homepage — not useful as a document-map entry on its own
    if (!url.search && !url.hash) return { keep: false, reason: 'root_only', url: url.toString(), ruleId: 'ROOT_ONLY', ruleVersion: '1.0', priority: 99, proofScope: 'path_segment' };
  }
  if (url.hash && url.pathname === '/' && !url.search) {
    return { keep: false, reason: 'fragment_only', url: url.toString(), ruleId: 'FRAGMENT_ONLY', ruleVersion: '1.0', priority: 99, proofScope: 'url_fragment' };
  }

  const sameOrigin = opts.origin ? url.origin === opts.origin : true;
  if (!sameOrigin) {
    const approved = (opts.approvedExternalHosts ?? []).some((re) => re.test(url.hostname));
    if (!approved) return { keep: false, reason: 'external_not_approved', url: url.toString(), ruleId: 'EXTERNAL_NOT_APPROVED', ruleVersion: '1.0', priority: 13, proofScope: 'origin' };
    for (const trackingEntry of TRACKING_CDN_HOSTS) {
      if (trackingEntry.re.test(url.hostname)) {
        return { keep: false, reason: 'tracking_cdn_host', url: url.toString(), ...trackingEntry.rule };
      }
    }
    return { keep: true, reason: 'external_approved', url: url.toString(), ruleId: 'EXTERNAL_APPROVED', ruleVersion: '1.0', priority: 0, proofScope: 'origin' };
  }

  // Check tracking/CDN hosts for same-origin
  for (const trackingEntry of TRACKING_CDN_HOSTS) {
    if (trackingEntry.re.test(url.hostname)) {
      return { keep: false, reason: 'tracking_cdn_host', url: url.toString(), ...trackingEntry.rule };
    }
  }

  // Build canonical: lowercase, trailing-slash-stripped path, no query/hash, collapse repeated slashes
  const canonicalPath = url.pathname.toLowerCase().replace(/\/+/g, '/').replace(/\/+$/, '').replace(/^\//, '');
  const canonical = canonicalPath ? `${url.origin}/${canonicalPath}` : `${url.origin}/`;

  if (!canonicalPath) return { keep: false, reason: 'root_only', url: canonical, ruleId: 'ROOT_ONLY', ruleVersion: '1.0', priority: 99, proofScope: 'path_segment' };

  // Normalized path for matching (underscores→hyphens, collapsed slashes, decoded)
  const matchPath = normalizePathForMatching(url.pathname);

  if (ASSET_EXTENSION_RE.test(matchPath)) return { keep: false, reason: 'asset', url: canonical, ...ASSET_RULE };

  for (const apiEntry of API_ENDPOINT_TRASH) {
    if (apiEntry.re.test(matchPath)) {
      return { keep: false, reason: 'api_endpoint', url: canonical, ...apiEntry.rule };
    }
  }

  for (const funcEntry of FUNCTIONAL_ENDPOINT_TRASH) {
    if (funcEntry.re.test(matchPath)) {
      return { keep: false, reason: 'functional_endpoint', url: canonical, ...funcEntry.rule };
    }
  }

  for (const eventEntry of INDIVIDUAL_EVENT_TRASH) {
    if (eventEntry.re.test(matchPath)) {
      return { keep: false, reason: 'individual_event_page', url: canonical, ...eventEntry.rule };
    }
  }

  // PRECEDENCE: trash beats everything, including nested keep terms
  for (const trashEntry of TRASH_ROUTES) {
    if (trashEntry.re.test(matchPath)) {
      return { keep: false, reason: 'trash_route', url: canonical, ...trashEntry.rule };
    }
  }

  // Check keep routes
  for (const keepEntry of KEEP_ROUTES) {
    if (keepEntry.re.test(matchPath)) {
      return { keep: true, reason: 'keep_route', url: canonical, ...keepEntry.rule };
    }
  }

  const segments = canonicalPath.split('/').filter(Boolean);

  // per-sport category root: keep only the landing segment, drop deeper (event) paths
  if (segments.length > 0 && SPORT_CATEGORY_TOKENS.has(segments[0])) {
    if (segments.length === 1) return { keep: true, reason: 'sport_category_landing', url: canonical, ruleId: 'SPORT_CATEGORY_LANDING', ruleVersion: '1.0', priority: 2, proofScope: 'route_path' };
    return { keep: false, reason: 'individual_sport_event', url: canonical, ruleId: 'INDIVIDUAL_SPORT_EVENT', ruleVersion: '1.0', priority: 8, proofScope: 'route_path' };
  }

  if (segments.length > 0 && PRODUCT_LANDING_TOKENS.has(segments[0])) {
    if (segments.length === 1) return { keep: true, reason: 'product_landing', url: canonical, ruleId: 'PRODUCT_LANDING', ruleVersion: '1.0', priority: 2, proofScope: 'route_path' };
    return { keep: false, reason: 'individual_product_page', url: canonical, ruleId: 'INDIVIDUAL_PRODUCT_PAGE', ruleVersion: '1.0', priority: 8, proofScope: 'route_path' };
  }

  // casino nav noise: unclassified single-segment casino/sports lobby-style paths
  if (/^(casino|sports)(\/(lobby|instant-games|promo))?$/.test(canonicalPath)) {
    return { keep: false, reason: 'casino_nav_noise', url: canonical, ruleId: 'CASINO_NAV_NOISE', ruleVersion: '1.0', priority: 6, proofScope: 'route_path' };
  }

  // Retain unknown/unclassified URLs (issue 07: unknown-purpose fixtures are kept)
  return { keep: true, reason: 'unclassified', url: canonical, ruleId: 'UNCLASSIFIED', ruleVersion: '1.0', priority: 99, proofScope: 'default_keep' };
}

function matchesAny(path: string, families: Array<{ re: RegExp }>): boolean {
  return families.some((entry) => entry.re.test(path));
}

/** Classify + dedupe a batch of candidate URLs, producing UrlMapEntry[] for the given source. */
export function cleanAndCanonicalize(
  candidates: string[],
  opts: { origin: string; source: EntrySource; approvedExternalHosts?: RegExp[] },
): UrlMapEntry[] {
  const seen = new Set<string>();
  const entries: UrlMapEntry[] = [];
  for (const raw of candidates) {
    const result = classifyUrl(raw, opts);
    if (!result.keep) continue;
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const originStatus: OriginStatus = result.reason === 'external_approved' ? 'external_approved' : 'official_same_origin';
    entries.push({ canonicalUrl: result.url, originStatus, source: opts.source });
  }
  return entries;
}

/**
 * Classify a batch of candidate URLs and persist decision artifacts.
 * Writes three files atomically:
 * - clean-url-inventory.json: array of kept UrlMapEntry objects
 * - deterministic-rejected-urls.json: array of rejected UrlMapEntry objects
 * - url-clean-decisions.jsonl: append-only decision log with one row per raw candidate
 */
export async function cleanAndPersist(
  outputDir: string,
  candidates: string[],
  opts: { origin: string; source: EntrySource; approvedExternalHosts?: RegExp[] },
): Promise<void> {
  const keptEntries: UrlMapEntry[] = [];
  const rejectedEntries: UrlMapEntry[] = [];
  const decisionRows: UrlDecisionRow[] = [];
  const seenKept = new Set<string>();
  const seenRejected = new Set<string>();

  // Default researchable fields - will be extended in future when field-requirements.json is available
  const defaultResearchableFields = {
    'product:title': 'not_applicable_by_deterministic_rule',
    'product:category': 'not_applicable_by_deterministic_rule',
    'sports:event_name': 'not_applicable_by_deterministic_rule',
    'sports:league': 'not_applicable_by_deterministic_rule',
    'compliance:terms_present': 'not_applicable_by_deterministic_rule',
    'compliance:privacy_present': 'not_applicable_by_deterministic_rule',
  };

  for (const rawUrl of candidates) {
    const result = classifyUrl(rawUrl, opts);
    const originStatus: OriginStatus = result.reason === 'external_approved' ? 'external_approved' : 'official_same_origin';

    // Create decision row
    const decisionRow: UrlDecisionRow = {
      rawUrl,
      canonicalUrl: result.url,
      keep: result.keep,
      reason: result.reason,
      source: opts.source,
      ruleId: result.ruleId,
      ruleVersion: result.ruleVersion,
      priority: result.priority,
      proofScope: result.proofScope,
    };

    // For hard drops, include researchable fields
    if (!result.keep) {
      decisionRow.researchableFields = defaultResearchableFields;
    }

    decisionRows.push(decisionRow);

    // Accumulate kept/rejected entries (deduplicated by canonical URL)
    if (result.keep) {
      if (!seenKept.has(result.url)) {
        seenKept.add(result.url);
        keptEntries.push({ canonicalUrl: result.url, originStatus, source: opts.source });
      }
    } else {
      if (!seenRejected.has(result.url)) {
        seenRejected.add(result.url);
        rejectedEntries.push({ canonicalUrl: result.url, originStatus, source: opts.source });
      }
    }
  }

  // Write artifacts atomically
  const inventoryPath = path.join(outputDir, 'clean-url-inventory.json');
  const rejectedPath = path.join(outputDir, 'deterministic-rejected-urls.json');
  const decisionsPath = path.join(outputDir, 'url-clean-decisions.jsonl');

  await Promise.all([
    writeAtomicJSON(inventoryPath, keptEntries),
    writeAtomicJSON(rejectedPath, rejectedEntries),
    // Write JSONL decision rows one by one
    (async () => {
      for (const row of decisionRows) {
        await writeAppendOnlyJSONL(decisionsPath, row);
      }
    })(),
  ]);
}

/** Derive a label strictly from the URL slug — never from page content. */
export function deriveLabelFromSlug(rawUrl: string): string | undefined {
  const url = toURL(rawUrl);
  if (!url) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;
  const last = segments[segments.length - 1];
  const words = last.replace(/[-_]+/g, ' ').trim();
  if (!words || /^[0-9]+$/.test(words)) return undefined;
  return words.toLowerCase();
}

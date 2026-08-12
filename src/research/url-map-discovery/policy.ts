import type { CandidateProvenance, RawUrlCandidate } from '../url-map/types.ts';

export type UrlDecision = 'accepted' | 'rejected' | 'tbd';

export interface UrlRuleDecision {
  rawUrl: string;
  baseUrl: string;
  canonicalUrl: string | null;
  navigationUrl: string | null;
  decision: UrlDecision;
  ruleId: string;
  reason: string;
  provenance: CandidateProvenance[];
}

const TRACKING_QUERY_KEYS = new Set([
  'gclid', 'fbclid', 'msclkid', 'yclid', '_ga', '_gl', 'ref', 'referrer',
]);
const ROUTE_STATE_QUERY_KEYS = new Set(['bt-path']);

const TECHNICAL_EXT_RE = /\.(?:m?js|cjs|css|map|json|xml|txt|webmanifest|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp3|m4a|wav|ogg|mp4|m4v|webm|avi|mov|pdf|zip|gz|br)(?:$|[?#])/i;
const LOCALE_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

const TBD_SEGMENTS = new Set([
  'login', 'signin', 'sign-in', 'register', 'registration', 'signup', 'sign-up', 'logout',
  'status', 'health', 'healthcheck',
]);

const PRIVATE_SEGMENTS = new Set([
  'account', 'accounts', 'my-account', 'profile', 'wallet', 'transaction', 'transactions', 'history',
  'settings', 'security', 'kyc', 'verification', 'verify', 'personal', 'responsible-gaming',
  'responsible', 'self-exclusion', 'selfexclusion', 'privacy', 'privacy-policy', 'cookie', 'cookies',
  'cookie-policy', 'support', 'help', 'aml', 'aml-kyc-policy', 'aml_kyc_policy', 'dispute-resolution-policy',
  'personal-data-privacy', 'affiliate', 'affiliates', 'partner', 'partners', 'career', 'careers',
  'press', 'corporate', 'about', 'contact', 'contacts', 'news', 'blog',
]);

const PROMO_SEGMENTS = new Set([
  'promo', 'promos', 'promotion', 'promotions', 'bonus', 'bonuses', 'offer', 'offers',
  'cashback', 'free-spins', 'freespins',
]);
const PAYMENT_SEGMENTS = new Set([
  'payment', 'payments', 'payment-methods', 'deposit', 'deposits', 'withdraw', 'withdrawal', 'withdrawals',
  'cashier', 'recharge', 'deduce', 'banking',
]);
const LIMIT_SEGMENTS = new Set(['bet-limits', 'deposit-limits', 'loss-limits', 'time-limits']);
const TERMS_SEGMENTS = new Set([
  'terms', 'terms-and-conditions', 'conditions', 'rules', 'rule', 'bonus-terms', 'bonus-rules',
  'betting-rules', 'bets-rules', 'casino-rules', 'sports-rules', 'live-casino-rules',
]);
const APP_SEGMENTS = new Set(['app', 'apps', 'mobile', 'download', 'downloads']);
const PROGRAM_SEGMENTS = new Set(['vip', 'vip-club', 'loyalty', 'loyalty-program', 'rewards', 'rewards-program']);
const SLOT_SEGMENTS = new Set(['slot', 'slots']);
const LIVE_CASINO_SEGMENTS = new Set(['live-casino', 'livecasino']);
const SPORTS_ROOT_SEGMENTS = new Set(['sport', 'sports', 'sportsbook', 'line', 'live-betting', 'livebetting']);
const SPORT_CATEGORY_SEGMENTS = new Set([
  'football', 'soccer', 'tennis', 'basketball', 'ice-hockey', 'hockey', 'volleyball', 'handball',
  'baseball', 'american-football', 'rugby', 'cricket', 'table-tennis', 'badminton', 'darts', 'snooker',
  'boxing', 'mma', 'futsal', 'water-polo', 'horse-racing', 'esports', 'e-sports',
]);
const APPROVED_GAMES_CATEGORY_SEGMENTS = new Set([
  'slots', 'slot', 'live', 'live-casino', 'livecasino', 'popular', 'new', 'table-games', 'table',
  'game-shows', 'gameshows', 'jackpots', 'virtual-sports', 'virtualsports',
]);

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/g, '') || '/';
}

function splitLocale(pathname: string): { locale: string | null; segments: string[] } {
  const raw = pathname.split('/').filter(Boolean);
  if (raw.length && LOCALE_RE.test(raw[0])) return { locale: raw[0], segments: raw.slice(1) };
  return { locale: null, segments: raw };
}

function hasAny(segments: readonly string[], values: ReadonlySet<string>): boolean {
  return segments.some(segment => values.has(segment));
}

function hasCashierHash(url: URL): boolean {
  return /(?:deposit|withdraw|cashier|payment|recharge|deduce)/i.test(url.hash);
}

function canonicalizeUrl(rawUrl: string, baseUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;

  url.hostname = url.hostname.toLowerCase();
  url.pathname = normalizePath(url.pathname);

  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('utm_') || TRACKING_QUERY_KEYS.has(normalized) || ROUTE_STATE_QUERY_KEYS.has(normalized)) {
      url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
    const keyOrder = ak.localeCompare(bk);
    return keyOrder !== 0 ? keyOrder : av.localeCompare(bv);
  });
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);

  if (!hasCashierHash(url)) url.hash = '';
  return url;
}

function categoryUrl(base: URL, locale: string | null, segments: readonly string[]): URL {
  const normalized = new URL(base.toString());
  normalized.pathname = `/${[...(locale ? [locale] : []), ...segments].join('/')}`;
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}

function decision(
  candidate: RawUrlCandidate,
  provenance: CandidateProvenance[],
  canonical: URL | null,
  result: UrlDecision,
  ruleId: string,
  reason: string,
  navigation: URL | null = canonical,
): UrlRuleDecision {
  return {
    rawUrl: candidate.rawUrl,
    baseUrl: candidate.baseUrl,
    canonicalUrl: canonical?.toString() ?? null,
    navigationUrl: navigation?.toString() ?? null,
    decision: result,
    ruleId,
    reason,
    provenance,
  };
}

/**
 * Closed-world deterministic URL policy for the URL-map stage.
 *
 * accepted = explicitly approved public research document/category route
 * rejected = non-research document/private/item/unclassified route
 * tbd      = technical/auth/resource class retained as factual discovery evidence but never browsed as a page
 */
export function decideUrl(
  candidate: RawUrlCandidate,
  allowedHosts: ReadonlySet<string>,
  mergedProvenance: CandidateProvenance[] = [candidate.provenance],
): UrlRuleDecision {
  const canonical = canonicalizeUrl(candidate.rawUrl, candidate.baseUrl);
  if (!canonical) {
    return decision(candidate, mergedProvenance, null, 'rejected', 'URLR_REJECT_MALFORMED', 'URL cannot be resolved as HTTP(S).');
  }

  if (!allowedHosts.has(canonical.hostname.toLowerCase())) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_EXTERNAL_ORIGIN', 'URL is outside the configured allowed-host scope.');
  }

  const pathname = canonical.pathname.toLowerCase();
  const { locale, segments } = splitLocale(pathname);
  const first = segments[0] ?? '';
  const second = segments[1] ?? '';

  if (
    TECHNICAL_EXT_RE.test(`${canonical.pathname}${canonical.search}`) ||
    ['api', 'graphql', 'ajax', 'socket', 'sockets', 'ws', 'websocket', 'assets', 'static', 'cdn'].includes(first) ||
    pathname.includes('/api/') || pathname.includes('/graphql')
  ) {
    return decision(candidate, mergedProvenance, canonical, 'tbd', 'URLR_TBD_TECHNICAL_SOURCE', 'Technical/API/resource URL is evidence only and is not a document crawl target.');
  }

  if (hasAny(segments, TBD_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'tbd', 'URLR_TBD_AUTH_OR_STATUS', 'Auth/status route remains a non-visitable TBD class under the current URL rules.');
  }

  // Root and locale-only landing are navigation/lobby surfaces, not research pages.
  if (segments.length === 0) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_NAVIGATION_LANDING', 'Generic site landing/navigation page is outside the research URL map.');
  }

  // Payment routes may legitimately contain profile-like hash state; evaluate them before generic account rejection.
  if (hasCashierHash(canonical) || hasAny(segments, PAYMENT_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_PAYMENTS', 'Deposit/withdrawal/payment research route.');
  }

  if (hasAny(segments, PRIVATE_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_PRIVATE_OR_IRRELEVANT', 'Private account/support/compliance/corporate route is outside research-page scope.');
  }

  if (hasAny(segments, PROMO_SEGMENTS) || first.startsWith('offers-')) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_PROMOTIONS', 'Bonus/promotion/public offer research route.');
  }
  if (hasAny(segments, LIMIT_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_LIMITS', 'Allowed limits research route.');
  }
  if (hasAny(segments, TERMS_SEGMENTS) || /(?:terms|rules|conditions)/i.test(pathname)) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_TERMS_RULES', 'Terms/rules/conditions research route.');
  }
  if (hasAny(segments, APP_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_APP_MOBILE', 'Public app/mobile information route.');
  }
  if (hasAny(segments, PROGRAM_SEGMENTS)) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_PUBLIC_PROGRAM', 'Public VIP/loyalty/rewards route.');
  }

  // Casino product roots and approved category aliases.
  if (first === 'casino' && segments.length === 1) {
    return decision(candidate, mergedProvenance, canonical, 'accepted', 'URLR_KEEP_CASINO_PRODUCT_ROOT', 'Casino product root used to expose approved product categories.');
  }
  if (first === 'casino' && (SLOT_SEGMENTS.has(second) || second === 'live' || LIVE_CASINO_SEGMENTS.has(second) || second === 'virtual-sports' || second === 'virtualsports')) {
    const normalized = categoryUrl(canonical, locale, ['casino', second]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_CASINO_CATEGORY', 'Approved casino product-category landing normalized to its category root.', normalized);
  }
  if (SLOT_SEGMENTS.has(first) || LIVE_CASINO_SEGMENTS.has(first) || first === 'virtual-sports' || first === 'virtualsports') {
    const normalized = categoryUrl(canonical, locale, [first]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_CASINO_CATEGORY', 'Approved casino product-category landing normalized to its category root.', normalized);
  }
  if (first === 'games' && second === 'category' && segments.length >= 3 && APPROVED_GAMES_CATEGORY_SEGMENTS.has(segments[2])) {
    const normalized = categoryUrl(canonical, locale, ['games', 'category', segments[2]]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_GAMES_CATEGORY', 'Approved games category landing normalized to its category root.', normalized);
  }
  if (first === 'games' && segments.length >= 2 && APPROVED_GAMES_CATEGORY_SEGMENTS.has(second)) {
    const normalized = categoryUrl(canonical, locale, ['games', second]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_GAMES_CATEGORY', 'Approved games category landing normalized to its category root.', normalized);
  }

  // Sports product root is useful for category-rail discovery. Known sport categories are canonicalized;
  // unknown second-level slugs remain non-visitable so leagues/competitions do not become visits.
  if (SPORTS_ROOT_SEGMENTS.has(first) && segments.length === 1) {
    const normalized = categoryUrl(canonical, locale, [first]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_SPORTS_PRODUCT_ROOT', 'Sports product root used to expose canonical sport categories.', normalized);
  }
  if (SPORTS_ROOT_SEGMENTS.has(first) && SPORT_CATEGORY_SEGMENTS.has(second)) {
    const normalized = categoryUrl(canonical, locale, [first, second]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_SPORTS_CATEGORY', 'Nested sports route normalized to its canonical sport category.', normalized);
  }
  if (SPORT_CATEGORY_SEGMENTS.has(first)) {
    const normalized = categoryUrl(canonical, locale, [first]);
    return decision(candidate, mergedProvenance, normalized, 'accepted', 'URLR_KEEP_SPORTS_CATEGORY', 'Nested sports route normalized to its canonical sport category.', normalized);
  }

  // Explicit live/prematch filters are never standalone stored category targets.
  if (first === 'live' || first === 'prematch') {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_SPORTS_FILTER', 'Live/prematch filter is not a canonical category landing.');
  }

  if (
    first === 'game' || first === 'play' || (first === 'casino' && second === 'game') ||
    (first === 'games' && segments.length >= 2 && !APPROVED_GAMES_CATEGORY_SEGMENTS.has(second))
  ) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_INDIVIDUAL_GAME', 'Individual/unknown game route is not a research-page target.');
  }

  if (SPORTS_ROOT_SEGMENTS.has(first) && segments.length >= 2) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_SPORTS_EVENT_OR_LEAGUE', 'Unknown/deep sports league, competition, event, or match route is not a research-page target.');
  }

  if (/\/(?:404|not-found|notfound|error)(?:\/|$)/i.test(pathname)) {
    return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_ERROR_ROUTE', 'Known error/not-found route.');
  }

  return decision(candidate, mergedProvenance, canonical, 'rejected', 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN', 'Same-origin route does not match an explicitly approved research route class.');
}

export function canonicalCandidateKey(candidate: RawUrlCandidate): string | null {
  return canonicalizeUrl(candidate.rawUrl, candidate.baseUrl)?.toString() ?? null;
}

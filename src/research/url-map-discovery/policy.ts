import type { CandidateProvenance, UrlDecision, UrlDecisionKind } from './types.ts';

const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const ASSET_EXT = /\.(?:m?js|cjs|css|map|json|xml|txt|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|vue|tsx?|jsx?|svelte)(?:$|[?#])/i;
const TECHNICAL_PATH = /(?:^|\/)(?:assets?|static|dist|build|chunks?|fonts?|images?|img|icons?|favicons?|node_modules|src)(?:\/|$)/i;
const API_PATH = /(?:^|\/)(?:api|graphql|socket\.io|engine\.io|health|status)(?:\/|$)/i;
const ACCOUNT_PATH = /(?:^|\/)(?:my-account|account|profile|settings|security|kyc|verification|personal-data)(?:\/|$)/i;
const CORPORATE_PATH = /(?:^|\/)(?:about(?:-company)?|contacts?|affiliates?|careers?|news|blog|press|partners?|for-partners)(?:\/|$)/i;
const SUPPORT_COMPLIANCE_PATH = /(?:^|\/)(?:support|help|aml[-_]kyc[-_]policy|dispute[-_]resolution[-_]policy|personal[-_]data[-_]privacy)(?:\/|$)/i;
const EXPLICIT_REMOVE = /(?:^|\/)(?:transaction-history|responsible-gam(?:ing|bling)|self-exclusion(?:-long)?|privacy(?:-policy)?|cookie-policy)(?:\/|$)/i;
const LOBBY_REMOVE = /(?:^|\/)(?:casino\/(?:lobby|instant-games)|sports\/lobby)(?:\/|$)/i;
const INDIVIDUAL_GAME = /(?:^|\/)(?:game|games\/play|casino\/game)(?:\/[^/]+){1,}(?:\/|$)/i;
const SPORTS_DETAIL = /(?:^|\/)(?:match|event|events|league|leagues|tournament|tournaments|competition|competitions|fixture|fixtures)(?:\/|$)/i;
const LOGIN_TBD = /(?:^|\/)(?:login|register|registration|logout|signin|signup)(?:\/|$)/i;

const PROMO_SEGMENTS = new Set(['bonus', 'bonuses', 'promo', 'promotions', 'offers', 'offer']);
const PAYMENT_SEGMENTS = new Set(['deposit', 'withdraw', 'withdrawal', 'payment-methods', 'payments', 'cashier', 'recharge', 'deduce']);
const LIMIT_SEGMENTS = new Set(['bet-limits', 'deposit-limits', 'loss-limits', 'time-limits']);
const RULE_SEGMENTS = new Set(['terms-and-conditions', 'bonus-terms', 'rules', 'sports-rules', 'bets-rules', 'casino-rules', 'live-casino-rules', 'games-rules', 'betting-bonus-conditions', 'casino-bonus-terms']);
const SPORT_ROOTS = new Set(['sport', 'sports', 'line', 'horse-racing', 'football', 'tennis', 'basketball']);
const CASINO_CATEGORY_MARKERS = new Set(['slots', 'live-casino', 'live', 'virtual-sports', 'virtual-games', 'popular']);

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizePathForMatch(pathname: string): { path: string; segments: string[]; locale?: string } {
  let path = safeDecode(pathname).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/_/g, '-').toLowerCase();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const rawSegments = path.split('/').filter(Boolean);
  let locale: string | undefined;
  if (rawSegments[0] && LOCALE_SEGMENT.test(rawSegments[0])) locale = rawSegments.shift();
  // Common CMS wrappers do not change route meaning. They are ignored for matching only.
  while (rawSegments[0] && ['page', 'pages', 'information', 'info'].includes(rawSegments[0])) rawSegments.shift();
  return { path: `/${rawSegments.join('/')}`, segments: rawSegments, locale };
}

function canonicalizeUrl(url: URL): string {
  const out = new URL(url.toString());
  out.hash = '';
  out.pathname = out.pathname.replace(/\/{2,}/g, '/');
  if (out.pathname.length > 1) out.pathname = out.pathname.replace(/\/+$/, '');
  return out.toString();
}

function canonicalizeSportsFilter(url: URL, segments: string[]): string | undefined {
  if (!segments.length) return undefined;
  const rootIndex = segments.findIndex(s => SPORT_ROOTS.has(s));
  if (rootIndex < 0) return undefined;
  const root = segments[rootIndex];
  // A generic sports live/prematch filter is the same research landing.
  const later = segments.slice(rootIndex + 1);
  const hasOnlyFilter = later.length > 0 && later.every(s => ['live', 'prematch', 'pre-match'].includes(s));
  const btPath = url.searchParams.get('bt-path')?.toLowerCase() ?? '';
  const queryIsLiveFilter = /(?:^|\/)(?:live-section|prematch)(?:\/|$)/.test(btPath);
  if (!hasOnlyFilter && !queryIsLiveFilter) return undefined;

  const originalSegments = url.pathname.split('/').filter(Boolean);
  const localePrefix = originalSegments[0] && LOCALE_SEGMENT.test(originalSegments[0]) ? `/${originalSegments[0]}` : '';
  const result = new URL(url.origin + `${localePrefix}/${root}`);
  return canonicalizeUrl(result);
}

function decision(kind: UrlDecisionKind, rawUrl: string, resolvedUrl: string | undefined, canonicalUrl: string | undefined, ruleId: string, reason: string, provenance: CandidateProvenance[]): UrlDecision {
  return { rawUrl, resolvedUrl, canonicalUrl, decision: kind, ruleId, reason, provenance };
}

export function decideDocumentUrl(rawUrl: string, baseUrl: string, allowedHosts: ReadonlySet<string>, provenance: CandidateProvenance[] = []): UrlDecision {
  let url: URL;
  try { url = new URL(rawUrl, baseUrl); } catch {
    return decision('rejected', rawUrl, undefined, undefined, 'URLR_REJECT_MALFORMED', 'URL cannot be resolved.', provenance);
  }

  if (['mailto:', 'tel:'].includes(url.protocol)) {
    return decision('tbd', rawUrl, url.toString(), undefined, 'URLR_TBD_CONTACT_SCHEME', 'mailto/tel URL classes are explicitly TBD and are never navigation candidates.', provenance);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return decision('rejected', rawUrl, url.toString(), undefined, 'URLR_REJECT_NON_HTTP', 'Unsupported non-HTTP scheme is not eligible for browser document navigation.', provenance);
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    return decision('rejected', rawUrl, url.toString(), undefined, 'URLR_REJECT_OUT_OF_SCOPE_HOST', 'URL is outside configured navigation host scope.', provenance);
  }

  const resolved = canonicalizeUrl(url);
  const { path, segments } = normalizePathForMatch(url.pathname);

  // Explicit URL Rules removals always win.
  if (path === '/' || segments.length === 0) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_ROOT', 'Root/landing navigation page is explicitly removed.', provenance);
  if (ACCOUNT_PATH.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_ACCOUNT_UI', 'Account UI is explicitly removed.', provenance);
  if (EXPLICIT_REMOVE.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_EXPLICIT_TRASH', 'Route is explicitly removed by URL rules.', provenance);
  if (SUPPORT_COMPLIANCE_PATH.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_SUPPORT_COMPLIANCE', 'Support/compliance route is explicitly removed.', provenance);
  if (CORPORATE_PATH.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_CORPORATE', 'Corporate/editorial route is explicitly removed.', provenance);
  if (LOBBY_REMOVE.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_LOBBY', 'Navigation/lobby route is explicitly removed.', provenance);
  if (INDIVIDUAL_GAME.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_INDIVIDUAL_GAME', 'Individual games are never visited.', provenance);
  if (SPORTS_DETAIL.test(path)) return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_SPORTS_DETAIL', 'Event/league/tournament detail routes are never visited.', provenance);

  // Current URL Rules leave these technical/auth classes TBD. Never promote them to document visits.
  if (LOGIN_TBD.test(path)) return decision('tbd', rawUrl, resolved, undefined, 'URLR_TBD_AUTH_ROUTE', 'Login/register/logout classes are TBD and cannot be visited by default.', provenance);
  if (ASSET_EXT.test(url.pathname) || TECHNICAL_PATH.test(path)) return decision('tbd', rawUrl, resolved, undefined, 'URLR_TBD_TECHNICAL_SOURCE', 'Asset/source URL is a technical source, not a document route.', provenance);
  if (API_PATH.test(path)) return decision('tbd', rawUrl, resolved, undefined, 'URLR_TBD_API_JSON', 'API/JSON/health endpoint classes are TBD and cannot be visited by default.', provenance);

  const sportsCanonical = canonicalizeSportsFilter(url, segments);
  if (sportsCanonical) return decision('accepted', rawUrl, resolved, sportsCanonical, 'URLR_KEEP_SPORT_CATEGORY_CANONICALIZED', 'Sports live/prematch filter normalized to its root category landing.', provenance);

  if (segments.some(s => PROMO_SEGMENTS.has(s) || /^offers?-/.test(s))) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_PROMOTION', 'Bonus/promotion/offer route is explicitly research-relevant.', provenance);
  }
  if (segments.some(s => PAYMENT_SEGMENTS.has(s))) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_PAYMENT', 'Deposit/withdrawal/payment information route is research-relevant.', provenance);
  }
  if (segments.some(s => LIMIT_SEGMENTS.has(s))) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_LIMITS', 'Allowed limits route is research-relevant.', provenance);
  }
  if (segments.some(s => RULE_SEGMENTS.has(s))) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_RULES_TERMS', 'Terms/rules route is research-relevant.', provenance);
  }

  const categoryIndex = segments.findIndex(s => s === 'category');
  if (categoryIndex >= 0 && segments[categoryIndex + 1] && !SPORTS_DETAIL.test(path)) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_PRODUCT_CATEGORY', 'Canonical product category landing is research-relevant.', provenance);
  }
  if (segments.some(s => CASINO_CATEGORY_MARKERS.has(s)) && segments.some(s => ['casino', 'games'].includes(s))) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_CASINO_CATEGORY', 'Casino product category landing is research-relevant.', provenance);
  }
  if (segments.length === 1 && SPORT_ROOTS.has(segments[0])) {
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_SPORT_CATEGORY', 'Sports/category landing is research-relevant.', provenance);
  }
  if (segments.length === 2 && SPORT_ROOTS.has(segments[0]) && !['live', 'prematch', 'pre-match'].includes(segments[1])) {
    // Canonical sport category shapes like /sport/football; detail nouns were rejected above.
    return decision('accepted', rawUrl, resolved, resolved, 'URLR_KEEP_SPORT_CATEGORY', 'Canonical sport category landing is research-relevant.', provenance);
  }

  return decision('rejected', rawUrl, resolved, undefined, 'URLR_REJECT_UNMATCHED_SAME_ORIGIN', 'Same-origin route does not match an explicitly approved research document class.', provenance);
}

export function isTechnicalSourceUrl(rawUrl: string, baseUrl: string, allowedHosts: ReadonlySet<string>): boolean {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase())) return false;
    const { path } = normalizePathForMatch(url.pathname);
    return ASSET_EXT.test(url.pathname) || TECHNICAL_PATH.test(path) || API_PATH.test(path);
  } catch { return false; }
}

import type { CandidateProvenance, UrlDecisionRecord } from './types.ts';

export const URL_RULES_VERSION = 'url-rules-2026-08-11-coverage-fix-v2';

const DOCUMENT_KEEP_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'URLR_KEEP_BONUS', re: /^\/(?:bonuses|promo|offers(?:-[^/]+)?|promotions(?:\/[^/]+){0,2})\/?$/i, reason: 'Bonus/promotion document route (promotions is a deterministic alias of this class).' },
  { id: 'URLR_KEEP_PAYMENT', re: /^\/(?:deposit|withdraw|payment-methods|payments)\/?$/i, reason: 'Payment information route.' },
  { id: 'URLR_KEEP_LIMITS', re: /^\/(?:bet-limits|deposit-limits|loss-limits|time-limits)\/?$/i, reason: 'Limits information route.' },
  { id: 'URLR_KEEP_RULES', re: /^\/(?:terms-and-conditions(?:-[^/]+)?|bonus-terms|rules|sports-rules|casino-rules|live-casino-rules)\/?$/i, reason: 'Rules/terms route.' },
  // FIX-04: public VIP/loyalty program landing. Only the bare top-level alias is a public
  // landing; anything nested one level deeper (reward history, account-scoped VIP status, etc.)
  // is excluded by URLR_DROP_ACCOUNT_UI/history rules before this pattern would ever apply.
  { id: 'URLR_KEEP_LOYALTY_PROGRAM', re: /^\/(?:vip|vip-club|loyalty|loyalty-program|rewards|rewards-program)\/?$/i, reason: 'Public VIP/loyalty program landing route.' },
];

const DROP_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'URLR_DROP_ROOT', re: /^\/$/, reason: 'Navigation/home page.' },
  { id: 'URLR_DROP_GENERIC_LOBBY', re: /^\/(?:casino\/lobby|casino\/instant-games|sports\/lobby)\/?$/i, reason: 'Generic lobby explicitly excluded.' },
  { id: 'URLR_DROP_TRANSACTION_HISTORY', re: /(?:^|\/)transaction-history(?:\/|$)/i, reason: 'Transaction history explicitly excluded.' },
  { id: 'URLR_DROP_RESPONSIBLE_GAMING', re: /(?:^|\/)(?:responsible-gaming|responsible-gambling|self-exclusion(?:-[^/]+)?)(?:\/|$)/i, reason: 'Responsible-gaming/self-exclusion route explicitly excluded.' },
  { id: 'URLR_DROP_PRIVACY_COOKIE', re: /(?:^|\/)(?:privacy-policy|privacy|cookie-policy)(?:\/|$)/i, reason: 'Privacy/cookie route explicitly excluded.' },
  { id: 'URLR_DROP_ACCOUNT_UI', re: /(?:^|\/)(?:my-account|account)(?:\/|$)|(?:^|\/)(?:kyc|personal-data|settings|security)(?:\/|$)/i, reason: 'Account UI explicitly excluded.' },
  { id: 'URLR_DROP_SUPPORT_COMPLIANCE', re: /(?:^|\/)(?:support|aml_kyc_policy|aml-kyc-policy|dispute-resolution-policy|personal-data-privacy)(?:\/|$)/i, reason: 'Support/compliance route explicitly excluded.' },
  { id: 'URLR_DROP_CORPORATE', re: /(?:^|\/)(?:about|about-company|about_company|contacts?|press(?:_contacts)?|affiliates?|careers?|news|blog|partners?|for-partners)(?:\/|$)/i, reason: 'Corporate route explicitly excluded.' },
  { id: 'URLR_DROP_INDIVIDUAL_GAME_EVENT', re: /(?:^|\/)(?:game|games|event|events|match|matches|tournament|tournaments|league|leagues|competition|competitions)(?:\/[^/]+)+\/?$/i, reason: 'Individual game/event/tournament/league/competition route.' },
  { id: 'URLR_DROP_NESTED_CASINO_CATEGORY', re: /^\/casino\/(?:slots|live-casino|virtual-sports)\/.+/i, reason: 'Nested casino category route; keep only canonical category landing.' },
];

// Generic route-segment vocabulary for individual game-launch targets (not a rail/sub-category
// label). Used to keep the live-casino sub-category rail generic: any single nested segment
// under /casino/live-casino/<segment> is treated as a rail entry (Popular, Blackjack, Roulette,
// Baccarat, Game Shows, Poker, ...) UNLESS it names a game-launch mechanism itself, in which case
// it is left to fall through to URLR_DROP_NESTED_CASINO_CATEGORY (and deeper-nested paths such as
// /casino/live-casino/game/<slug> or /casino/live-casino/provider-game/<slug> always fall through
// regardless of this list, since they are not a single segment).
const LIVE_CASINO_GAME_ROUTE_SEGMENTS = new Set([
  'game', 'games', 'play', 'launch', 'demo', 'demo-game', 'provider', 'provider-game', 'table',
]);

// Generic closed vocabulary of real-world sport names. Used to keep /sport/<category> root
// acceptance generic: a category segment must actually name a sport (not a competition, league,
// or tournament slug such as "uefa-champions-league") to canonicalize as a category root. This is
// not hostname-specific — it is the same closed set of sport names for every casino site.
const SPORT_CATEGORY_ROOTS = new Set([
  'football', 'basketball', 'tennis', 'ice-hockey', 'baseball', 'american-football', 'boxing',
  'cricket', 'esports', 'golf', 'handball', 'mma', 'rugby', 'snooker', 'table-tennis',
  'volleyball', 'motorsport', 'darts', 'cycling', 'horse-racing', 'futsal', 'badminton',
  'water-polo', 'rugby-league', 'rugby-union', 'formula-1', 'winter-sports',
]);

const TBD_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'URLR_TBD_API', re: /(?:^|\/)(?:api|graphql|rest)(?:\/|$)|\.(?:json|xml)(?:$|\?)/i, reason: 'API/JSON endpoint classification is TBD.' },
  { id: 'URLR_TBD_ASSET', re: /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|br)(?:$|\?)/i, reason: 'Asset/bundle URL classification is TBD.' },
  { id: 'URLR_TBD_AUTH', re: /(?:^|\/)(?:login|log-in|signin|sign-in|register|registration|signup|sign-up|logout|log-out)(?:\/|$)/i, reason: 'Login/register/logout classification is TBD.' },
  { id: 'URLR_TBD_HEALTH', re: /(?:^|\/)(?:health|healthz|status|ping)(?:\/|$)/i, reason: 'Health/status endpoint classification is TBD.' },
];

const SPORT_FILTER_SEGMENTS = new Set(['live', 'prematch', 'pre-match']);
const RESERVED_NON_SPORT_ROOTS = new Set([
  'casino', 'sports', 'support', 'account', 'my-account', 'api', 'graphql', 'login', 'register',
  'logout', 'promo', 'bonuses', 'offers', 'deposit', 'withdraw', 'payments', 'payment-methods',
  'terms-and-conditions', 'rules', 'privacy', 'privacy-policy', 'cookie-policy',
]);

function normalizePath(pathname: string): string {
  let value = pathname.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

// Strips a single leading locale segment (e.g. /en/, /en-GB/) so that route
// classification is locale-agnostic. Applied purely for matching/canonical
// purposes; the original URL is always preserved in the decision record.
const LOCALE_PREFIX_RE = /^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/i;

function stripLocalePrefix(path: string): string {
  const match = path.match(LOCALE_PREFIX_RE);
  if (!match) return path;
  const rest = path.slice(match[0].length);
  return rest === '' ? '/' : rest;
}

// FIX-03: exposes the same locale segment stripLocalePrefix() consumes internally, so callers
// outside this module (crawler.ts's route-identity/alias-merge logic) can tell which resolved
// URL among several locale aliases actually carries a given locale, without reimplementing
// locale-prefix parsing.
export function extractLocale(pathname: string): string | undefined {
  const match = pathname.match(LOCALE_PREFIX_RE);
  if (!match) return undefined;
  return match[0].slice(1).toLowerCase();
}

// Product categories real casino sites expose either nested under /casino/<x> or as a bare
// top-level route (e.g. /casino/live-casino and /live-casino both mean the same landing page).
// Both shapes canonicalize to the /casino/<x> form.
function canonicalProductCategory(path: string, url: URL): { url: URL; ruleId: string; reason: string } | undefined {
  const casinoNested = path.match(/^\/casino\/(slots|live-casino|virtual-sports)$/i);
  const casinoBare = path.match(/^\/(slots|live-casino|virtual-sports)$/i);
  // FIX-04: /games/<category> is a generic alias of the same product-category landing (e.g.
  // /games/slots === /casino/slots). Only the closed approved-category vocabulary canonicalizes
  // here; /games/<unknown-slug> is left unclassified and falls through to the individual
  // game/event drop rule below, so it is never blindly accepted as a category.
  const gamesAlias = path.match(/^\/games\/(slots|live-casino|virtual-sports)$/i);
  if (casinoNested || casinoBare || gamesAlias) {
    const category = (casinoNested ?? casinoBare ?? gamesAlias)![1]!.toLowerCase();
    const out = new URL(url.href);
    out.pathname = `/casino/${category}`;
    out.search = '';
    out.hash = '';
    return { url: out, ruleId: 'URLR_KEEP_CASINO_CATEGORY', reason: 'Canonical casino product-category landing.' };
  }

  if (/^\/horse-racing$/i.test(path)) {
    const out = new URL(url.href);
    out.pathname = path;
    out.hash = '';
    return { url: out, ruleId: 'URLR_KEEP_SPORT_CATEGORY', reason: 'Canonical sports category landing.' };
  }

  // /casino/live-casino/<segment> — the live-casino landing page's sub-category rail (Popular,
  // Blackjack, Roulette, Baccarat, Game Shows, Poker, ...). Exactly one nested segment names a
  // rail entry; anything deeper (e.g. /casino/live-casino/game/<slug>) is an individual game/table
  // launch route and falls through to URLR_DROP_NESTED_CASINO_CATEGORY below. A single segment
  // that itself names a game-launch mechanism (see LIVE_CASINO_GAME_ROUTE_SEGMENTS) is also left
  // to fall through, so individual game pages are never mistaken for rail categories.
  const liveCasinoRail = path.match(/^\/casino\/live-casino\/([^/]+)$/i);
  if (liveCasinoRail) {
    const segment = liveCasinoRail[1]!;
    if (!LIVE_CASINO_GAME_ROUTE_SEGMENTS.has(segment.toLowerCase())) {
      const out = new URL(url.href);
      out.pathname = `/casino/live-casino/${segment}`;
      out.search = '';
      out.hash = '';
      return {
        url: out,
        ruleId: 'URLR_KEEP_LIVE_CASINO_SUBCATEGORY',
        reason: 'Live-casino landing page sub-category rail entry.',
      };
    }
  }

  // /sport/<category>[/<nested...>] — a real casino site's sports category root, possibly
  // followed by league/event navigation depth that must collapse to the category root. Only a
  // recognized sport name (SPORT_CATEGORY_ROOTS) canonicalizes here; competition/tournament/league
  // slugs (e.g. /sport/uefa-champions-league) are not sport category roots and are left
  // unclassified so they are never visited as if they were a category landing page.
  const sportMatch = path.match(/^\/sport\/([^/]+)(?:\/.*)?$/i);
  if (sportMatch && SPORT_CATEGORY_ROOTS.has(sportMatch[1]!.toLowerCase())) {
    const category = sportMatch[1]!;
    const isRootOnly = path.toLowerCase() === `/sport/${category.toLowerCase()}`;
    const out = new URL(url.href);
    out.pathname = `/sport/${category}`;
    out.search = '';
    out.hash = '';
    return {
      url: out,
      ruleId: isRootOnly ? 'URLR_KEEP_SPORT_CATEGORY' : 'URLR_KEEP_SPORT_CATEGORY_NORMALIZED',
      reason: isRootOnly
        ? 'Canonical sports category landing.'
        : 'Nested sports route (league/event/tournament depth) normalized to canonical category root.',
    };
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 2 && SPORT_FILTER_SEGMENTS.has(segments[1]!.toLowerCase())) {
    const root = segments[0]!.toLowerCase();
    if (!RESERVED_NON_SPORT_ROOTS.has(root)) {
      const out = new URL(url.href);
      out.pathname = `/${segments[0]}`;
      out.search = '';
      out.hash = '';
      return {
        url: out,
        ruleId: 'URLR_KEEP_SPORT_CATEGORY_NORMALIZED',
        reason: 'Sports live/prematch filter normalized to canonical root category.',
      };
    }
  }
  return undefined;
}

export function decideUrl(
  rawUrl: string,
  baseUrl: string,
  allowedHostname: string,
  provenance: CandidateProvenance[],
): UrlDecisionRecord {
  let resolved: URL;
  try {
    resolved = new URL(rawUrl.replace(/\\\//g, '/'), baseUrl);
  } catch {
    return {
      rawUrl,
      decision: 'tbd',
      ruleId: 'URLR_TBD_UNPARSEABLE',
      reason: 'URL-shaped token could not be parsed.',
      provenance,
    };
  }

  if (!['http:', 'https:'].includes(resolved.protocol)) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      decision: 'tbd',
      ruleId: 'URLR_TBD_NON_HTTP_SCHEME',
      reason: 'mailto/tel/deep-link/non-HTTP scheme classification is TBD.',
      provenance,
    };
  }

  const candidateHost = resolved.hostname.toLowerCase().replace(/^www\./, '');
  const scopeHost = allowedHostname.toLowerCase().replace(/^www\./, '');
  const inDomainScope = candidateHost === scopeHost || candidateHost.endsWith(`.${scopeHost}`);
  if (!inDomainScope) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      canonicalUrl: resolved.href,
      decision: 'rejected',
      ruleId: 'URLR_REJECT_EXTERNAL_DOMAIN',
      reason: 'External domains are recorded but never visited.',
      provenance,
    };
  }

  resolved.pathname = normalizePath(resolved.pathname);
  const routePath = stripLocalePrefix(resolved.pathname);
  const locale = extractLocale(resolved.pathname);

  if (resolved.hash) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      canonicalUrl: resolved.href,
      decision: 'tbd',
      ruleId: 'URLR_TBD_HASH_VARIANT',
      reason: 'Hash-route/query duplicate classification is TBD.',
      provenance,
    };
  }

  if (resolved.search) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      canonicalUrl: resolved.href,
      decision: 'tbd',
      ruleId: 'URLR_TBD_QUERY_VARIANT',
      reason: 'Query/hash duplicate classification is TBD.',
      provenance,
    };
  }

  const product = canonicalProductCategory(routePath, resolved);
  if (product) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      canonicalUrl: product.url.href,
      normalizedFrom: product.url.href !== resolved.href ? resolved.href : undefined,
      decision: 'accepted',
      ruleId: product.ruleId,
      reason: product.reason,
      locale,
      provenance,
    };
  }

  for (const rule of DOCUMENT_KEEP_PATTERNS) {
    if (rule.re.test(routePath)) {
      // FIX-03: canonical route identity is locale-agnostic (built from routePath, the
      // locale-stripped path) so /payments and /en/payments resolve to the same canonicalUrl
      // and merge into one accepted target downstream. resolvedUrl still preserves the real
      // localized URL as the actual navigation target candidate.
      const canonical = new URL(resolved.href);
      canonical.pathname = routePath;
      canonical.search = '';
      canonical.hash = '';
      return {
        rawUrl,
        resolvedUrl: resolved.href,
        canonicalUrl: canonical.href,
        normalizedFrom: canonical.href !== resolved.href ? resolved.href : undefined,
        decision: 'accepted',
        ruleId: rule.id,
        reason: rule.reason,
        locale,
        provenance,
      };
    }
  }

  for (const rule of DROP_PATTERNS) {
    if (rule.re.test(routePath)) {
      return {
        rawUrl,
        resolvedUrl: resolved.href,
        canonicalUrl: resolved.href,
        decision: 'rejected',
        ruleId: rule.id,
        reason: rule.reason,
        provenance,
      };
    }
  }

  for (const rule of TBD_PATTERNS) {
    if (rule.re.test(routePath)) {
      return {
        rawUrl,
        resolvedUrl: resolved.href,
        canonicalUrl: resolved.href,
        decision: 'tbd',
        ruleId: rule.id,
        reason: rule.reason,
        provenance,
      };
    }
  }

  return {
    rawUrl,
    resolvedUrl: resolved.href,
    canonicalUrl: resolved.href,
    decision: 'rejected',
    ruleId: 'URLR_REJECT_UNCLASSIFIED_SAME_ORIGIN',
    reason: 'Same-domain route is not covered by any approved keep, drop, or TBD rule; unclassified routes are not visited.',
    provenance,
  };
}

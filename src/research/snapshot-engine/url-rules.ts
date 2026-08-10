import type { CandidateProvenance, UrlDecisionRecord } from './types.ts';

export const URL_RULES_VERSION = 'url-rules-2026-08-10-passive-crawl-v1';

const DOCUMENT_KEEP_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'URLR_KEEP_BONUS', re: /^\/(?:bonuses|promo|offers(?:-[^/]+)?)\/?$/i, reason: 'Bonus/promotion document route.' },
  { id: 'URLR_KEEP_PAYMENT', re: /^\/(?:deposit|withdraw|payment-methods|payments)\/?$/i, reason: 'Payment information route.' },
  { id: 'URLR_KEEP_LIMITS', re: /^\/(?:bet-limits|deposit-limits|loss-limits|time-limits)\/?$/i, reason: 'Limits information route.' },
  { id: 'URLR_KEEP_RULES', re: /^\/(?:terms-and-conditions(?:-[^/]+)?|bonus-terms|rules|sports-rules|casino-rules|live-casino-rules)\/?$/i, reason: 'Rules/terms route.' },
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

function canonicalProductCategory(url: URL): { url: URL; ruleId: string; reason: string } | undefined {
  const path = normalizePath(url.pathname);
  if (/^\/casino\/(?:slots|live-casino|virtual-sports)$/i.test(path)) {
    const out = new URL(url.href);
    out.pathname = path;
    out.hash = '';
    return { url: out, ruleId: 'URLR_KEEP_CASINO_CATEGORY', reason: 'Canonical casino product-category landing.' };
  }

  if (/^\/horse-racing$/i.test(path)) {
    const out = new URL(url.href);
    out.pathname = path;
    out.hash = '';
    return { url: out, ruleId: 'URLR_KEEP_SPORT_CATEGORY', reason: 'Canonical sports category landing.' };
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

  const product = canonicalProductCategory(resolved);
  if (product) {
    return {
      rawUrl,
      resolvedUrl: resolved.href,
      canonicalUrl: product.url.href,
      normalizedFrom: product.url.href !== resolved.href ? resolved.href : undefined,
      decision: 'accepted',
      ruleId: product.ruleId,
      reason: product.reason,
      provenance,
    };
  }

  for (const rule of DOCUMENT_KEEP_PATTERNS) {
    if (rule.re.test(resolved.pathname)) {
      return {
        rawUrl,
        resolvedUrl: resolved.href,
        canonicalUrl: resolved.href,
        decision: 'accepted',
        ruleId: rule.id,
        reason: rule.reason,
        provenance,
      };
    }
  }

  for (const rule of DROP_PATTERNS) {
    if (rule.re.test(resolved.pathname)) {
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
    if (rule.re.test(resolved.pathname)) {
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
    decision: 'accepted',
    ruleId: 'URLR_KEEP_UNMATCHED_SAME_ORIGIN',
    reason: 'Same-domain route is not covered by an approved hard-drop rule; retain for complete deterministic visit coverage.',
    provenance,
  };
}

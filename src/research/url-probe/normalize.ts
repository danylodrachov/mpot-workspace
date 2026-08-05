export type UrlEntry = {
  url: string;
  [key: string]: unknown;
};

export type NormalizedUrl = {
  origin: string;
  locale: string | null;
  segments: string[];
};

// --- Trash rule families (checked first, in this order) ---

const ACCOUNT_ROOT_TRASH: RegExp[] = [/^(my-)?account(\/|$)/, /^profile(\/|$)/];

const ACCOUNT_FUNCTIONAL_TRASH: RegExp[] = [
  /(^|\/)kyc(\/|$)/,
  /(^|\/)personal-data(\/|$)/,
  /(^|\/)settings(\/|$)/,
  /(^|\/)security(\/|$)/,
  /(^|\/)sport-settings(\/|$)/,
  /(^|\/)information(\/|$)/,
  /(^|\/)direct-feed(\/|$)/,
  /(^|\/)favorites?(\/|$)/,
  /(^|\/)top-express(\/|$)/,
  /(^|\/)transaction-history(\/|$)/,
];

const RESPONSIBLE_GAMBLING_TRASH: RegExp[] = [
  /(^|\/)responsible-gaming(\/|$)/,
  /(^|\/)responsible-gambling(\/|$)/,
  /(^|\/)self-exclusion(-[a-z0-9-]+)?(\/|$)/,
];

const SUPPORT_COMPLIANCE_PRIVACY_TRASH: RegExp[] = [
  /(^|\/)support(\/|$)/,
  /(^|\/)help(\/|$)/,
  /(^|\/)aml-kyc-policy(\/|$)/,
  /(^|\/)dispute-resolution(-policy)?(\/|$)/,
  /(^|\/)personal-data-privacy(\/|$)/,
  /(^|\/)privacy-policy(\/|$)/,
  /(^|\/)privacy(\/|$)/,
  /(^|\/)cookie-policy(\/|$)/,
  /(^|\/)cookies?(-policy)?(\/|$)/,
];

const CORPORATE_EDITORIAL_TRASH: RegExp[] = [
  /(^|\/)about(-company)?(\/|$)/,
  /(^|\/)company(\/|$)/,
  /(^|\/)contacts?(\/|$)/,
  /(^|\/)affiliates?(\/|$)/,
  /(^|\/)careers?(\/|$)/,
  /(^|\/)jobs?(\/|$)/,
  /(^|\/)news(\/|$)/,
  /(^|\/)blog(\/|$)/,
  /(^|\/)press(-contacts)?(\/|$)/,
  /(^|\/)media(\/|$)/,
  /(^|\/)for-partners(\/|$)/,
  /(^|\/)partners(\/|$)/,
  /(^|\/)corporate-information(\/|$)/,
];

const PRODUCT_NAV_NOISE_TRASH: RegExp[] = [
  /(^|\/)(casino|sports)\/lobby(\/|$)/,
  /(^|\/)instant-games(\/|$)/,
  /(^|\/)crash-games(\/|$)/,
];

const TRASH_FAMILIES: RegExp[][] = [
  ACCOUNT_ROOT_TRASH,
  ACCOUNT_FUNCTIONAL_TRASH,
  RESPONSIBLE_GAMBLING_TRASH,
  SUPPORT_COMPLIANCE_PRIVACY_TRASH,
  CORPORATE_EDITORIAL_TRASH,
  PRODUCT_NAV_NOISE_TRASH,
];

// --- Sport-category tokens (subject to canonicalization) ---

const SPORT_CATEGORY_TOKENS = new Set([
  "football",
  "tennis",
  "basketball",
  "volleyball",
  "esports",
  "e-sports",
  "ufc",
  "ice-hockey",
  "table-tennis",
  "horse-racing",
  "virtual-sports",
]);

// --- Explicit keep rule families ---

const BONUSES_KEEP: RegExp[] = [
  /(^|\/)bonuses?(\/|$)/,
  /(^|\/)bonus-terms(\/|$)/,
  /(^|\/)promos?(\/|$)/,
  /(^|\/)promotions?(\/|$)/,
  /(^|\/)offers?(-[a-z]{2})?(\/|$)/,
];

const PAYMENTS_KEEP: RegExp[] = [
  /(^|\/)deposit(\/|$)/,
  /(^|\/)withdrawal?(\/|$)/,
  /(^|\/)payments?(-methods?)?(\/|$)/,
  /(^|\/)payment-methods?(\/|$)/,
  /(^|\/)cashier(\/|$)/,
];

const LIMITS_KEEP: RegExp[] = [
  /(^|\/)bet-limits(\/|$)/,
  /(^|\/)deposit-limits(\/|$)/,
  /(^|\/)loss-limits(\/|$)/,
  /(^|\/)time-limits(\/|$)/,
];

const TERMS_RULES_KEEP: RegExp[] = [
  /(^|\/)terms(-and-conditions)?(-[a-z]{2})?(\/|$)/,
  /(^|\/)bonus-terms(\/|$)/,
  /(^|\/)rules(\/|$)/,
  /(^|\/)games?-rules(\/|$)/,
  /(^|\/)sports-rules(\/|$)/,
  /(^|\/)casino-rules(\/|$)/,
  /(^|\/)live-casino-rules(\/|$)/,
];

const PRODUCT_CATEGORY_LANDINGS_KEEP: RegExp[] = [
  /(^|\/)slots(\/|$)/,
  /(^|\/)live-casino(\/|$)/,
  /(^|\/)virtual-sports(\/|$)/,
  /(^|\/)horse-racing(\/|$)/,
];

const KEEP_FAMILIES: RegExp[][] = [
  BONUSES_KEEP,
  PAYMENTS_KEEP,
  LIMITS_KEEP,
  TERMS_RULES_KEEP,
  PRODUCT_CATEGORY_LANDINGS_KEEP,
];

function normalize(rawUrl: string): NormalizedUrl {
  const parsed = new URL(rawUrl);
  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // leave as-is if not decodable
  }
  pathname = pathname.toLowerCase().replace(/_/g, "-").replace(/\/{2,}/g, "/");
  pathname = pathname.replace(/\/+$/, "");

  const rawSegments = pathname.split("/").filter(Boolean);
  const localeMatch =
    rawSegments.length > 0 && /^[a-z]{2}(-[a-z]{2})?$/.test(rawSegments[0])
      ? rawSegments[0]
      : null;
  const segments = localeMatch ? rawSegments.slice(1) : rawSegments;

  return { origin: parsed.origin, locale: localeMatch, segments };
}

function reconstruct(origin: string, locale: string | null, segments: string[]): string {
  const localePart = locale ? `/${locale}` : "";
  const pathPart = segments.length > 0 ? `/${segments.join("/")}` : "/";
  return `${origin}${localePart}${pathPart}`;
}

function matchesAny(path: string, families: RegExp[]): boolean {
  return families.some((re) => re.test(path));
}

export type CanonicalizeResult = {
  keep: boolean;
  url: string;
};

export function canonicalizeUrl(rawUrl: string): CanonicalizeResult {
  const { origin, locale, segments } = normalize(rawUrl);
  const path = segments.join("/");

  if (segments.length === 0) {
    return { keep: false, url: reconstruct(origin, locale, segments) };
  }

  for (const family of TRASH_FAMILIES) {
    if (matchesAny(path, family)) {
      return { keep: false, url: reconstruct(origin, locale, segments) };
    }
  }

  const sportIndex = segments.findIndex((segment) => SPORT_CATEGORY_TOKENS.has(segment));
  if (sportIndex !== -1) {
    const canonicalSegments = segments.slice(0, sportIndex + 1);
    return { keep: true, url: reconstruct(origin, locale, canonicalSegments) };
  }

  for (const family of KEEP_FAMILIES) {
    if (matchesAny(path, family)) {
      return { keep: true, url: reconstruct(origin, locale, segments) };
    }
  }

  return { keep: true, url: reconstruct(origin, locale, segments) };
}

export function canonicalizeUrlEntries<T extends UrlEntry>(entries: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const entry of entries) {
    const { keep, url } = canonicalizeUrl(entry.url);
    if (!keep) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push({ ...entry, url });
  }

  return result;
}

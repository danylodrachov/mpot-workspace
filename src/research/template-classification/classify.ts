// Deterministic research-template classification.
//
// Input is limited to already-cleaned URL-map metadata (canonicalUrl, optional
// derivedLabel/labelSource, originStatus, source). No page content, browser, network,
// bundle, sitemap, or navigation signal is used.

export const CATEGORY_IDS = [
  "casinos",
  "casino_bonuses",
  "cashback_offers",
  "free_spins",
  "loyalty_programs",
  "vip_casino_programs",
  "betting",
  "vip_betting_programs",
  "deposits",
  "withdrawals",
  "casino_games",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export const ROLES = ["primary", "supporting"] as const;
export type Role = (typeof ROLES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type Classification = {
  category: CategoryId;
  role: Role;
  confidence: Confidence;
  reason: string;
};

export type UrlMapEntry = {
  canonicalUrl: string;
  derivedLabel?: string | null;
  labelSource?: "url_slug";
  originStatus: "official_same_origin" | "external_approved";
  source: "dom_anchor" | "config_route" | "bundle_footer" | "bundle_seo" | "bundle_other" | "external";
  [key: string]: unknown;
};

export type ClassifiedUrlMapEntry = UrlMapEntry & { classifications: Classification[] };

function pathOf(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).pathname.toLowerCase();
  } catch {
    return canonicalUrl.toLowerCase();
  }
}

function labelAsPath(entry: UrlMapEntry): string | null {
  const label = entry.derivedLabel;
  if (!label) return null;
  return `/${label.toLowerCase().trim().replace(/\s+/g, "-")}`;
}

function matches(entry: UrlMapEntry, pattern: RegExp): boolean {
  if (pattern.test(pathOf(entry.canonicalUrl))) return true;
  const labelPath = labelAsPath(entry);
  return labelPath !== null && pattern.test(labelPath);
}

type Rule = {
  category: CategoryId;
  pattern: RegExp;
  role: Role;
  confidence: Confidence;
  reason: string;
};

// Explicit-only families are checked first and, when matched, exclude the generic
// promo/offer fallback for the same URL (a generic offers page must not also imply
// cashback/free-spins/loyalty/VIP).
const RULES: Rule[] = [
  // cashback_offers — explicit only
  {
    category: "cashback_offers",
    pattern: /(^|\/)(cashback|rebate|refund-offer|casino-cashback|live-casino-cashback|sportsbook-cashback)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a cashback/rebate offer.",
  },

  // free_spins — explicit only
  {
    category: "free_spins",
    pattern: /(^|\/)(free-spins?|awarded-spins?|no-deposit-spins?|deposit-spins?|wheel-spin|tournament-spins?)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a free-spin mechanic.",
  },

  // loyalty_programs — explicit only
  {
    category: "loyalty_programs",
    pattern: /(^|\/)(loyalty|rewards?|reward-points|points-exchange|club|gamification|player-level)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a loyalty/rewards program.",
  },

  // vip_casino_programs — explicit casino VIP only, sportsbook excluded below
  {
    category: "vip_casino_programs",
    pattern: /(^|\/)(casino-vip|casino-tier|casino-status|vip-club|vip)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a casino VIP/tier/status program.",
  },

  // vip_betting_programs — explicit sportsbook VIP only
  {
    category: "vip_betting_programs",
    pattern: /(^|\/)(sportsbook-vip|betting-vip|sports-loyalty|sportsbook-tier|betting-status)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a sportsbook VIP/tier/status program.",
  },

  // casino_games
  {
    category: "casino_games",
    pattern: /(^|\/)(slots?|live-casino|virtual-games?|game-providers?|game-catalogues?)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route is a retained casino catalogue or category landing.",
  },

  // betting
  {
    category: "betting",
    pattern: /(^|\/)(sports?|sportsbook|betting-rules|bet-limits|sports-welcome|bet-builder|live-betting|live-streaming)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route is a sportsbook landing, rule, limit, or betting-feature page.",
  },

  // deposits — informational only
  {
    category: "deposits",
    pattern: /(^|\/)(deposit-methods?|deposit-limits?|deposit-fees?|deposit-conditions?|cashier)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route is an informational deposit route (methods/limits/fees/conditions).",
  },

  // withdrawals — informational only
  {
    category: "withdrawals",
    pattern:
      /(^|\/)(withdrawal-methods?|withdrawal-limits?|withdrawal-fees?|withdrawal-commission|processing-times?|same-method|pending-withdrawals?|deposit-turnover|kyc)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route is an informational withdrawal route (methods/limits/fees/processing/verification).",
  },

  // casino_bonuses — explicit bonus terms first (high), generic promo/offer as fallback (handled separately)
  {
    category: "casino_bonuses",
    pattern:
      /(^|\/)(casino-bonus(es)?|welcome-package|welcome-bonus|first-deposit-bonus|second-deposit-bonus|reload-bonus|wagering|rollover)(\/|$)/,
    role: "primary",
    confidence: "high",
    reason: "The route explicitly names a casino bonus, welcome package, or wagering/rollover rule.",
  },

  // casinos — never a fallback, only explicit identity/licence/app pages
  {
    category: "casinos",
    pattern: /(^|\/)(about|company|app|mobile-app|download-app|lobby)(\/|$)/,
    role: "primary",
    confidence: "medium",
    reason: "The route is a company, licence, or app-related page that can attest general casino identity.",
  },
];

// Generic promo/offer pages map only to casino_bonuses, and only when nothing more
// specific already matched.
const GENERIC_PROMO_PATTERN = /(^|\/)(promos?|promotions?|offers?)(\/|$)/;

const EXTERNAL_LICENCE_PATTERN = /(licen[cs]e|licensing|regulator)/;

function isExplicitCategoryMatch(entry: UrlMapEntry, category: CategoryId): boolean {
  return RULES.some((rule) => rule.category === category && matches(entry, rule.pattern));
}

export function classifyEntry(entry: UrlMapEntry): Classification[] {
  const classifications: Classification[] = [];

  for (const rule of RULES) {
    if (matches(entry, rule.pattern)) {
      classifications.push({
        category: rule.category,
        role: rule.role,
        confidence: rule.confidence,
        reason: rule.reason,
      });
    }
  }

  // Official external licence link → supporting casinos, even when originStatus already
  // triggered the casinos rule above via a different path.
  if (
    entry.originStatus === "external_approved" &&
    matches(entry, EXTERNAL_LICENCE_PATTERN) &&
    !classifications.some((c) => c.category === "casinos")
  ) {
    classifications.push({
      category: "casinos",
      role: "supporting",
      confidence: "medium",
      reason: "External approved licence/regulator link supports casino identity.",
    });
  }

  // Generic promo/offers fallback: only when no explicit category already matched.
  const hasExplicitBonusAdjacentMatch = CATEGORY_IDS.some(
    (category) =>
      category !== "casino_bonuses" &&
      category !== "casinos" &&
      isExplicitCategoryMatch(entry, category),
  );
  if (
    matches(entry, GENERIC_PROMO_PATTERN) &&
    !classifications.some((c) => c.category === "casino_bonuses") &&
    !hasExplicitBonusAdjacentMatch
  ) {
    classifications.push({
      category: "casino_bonuses",
      role: "primary",
      confidence: "medium",
      reason: "A generic promotion/offers page may only map to casino_bonuses without a more explicit concept.",
    });
  }

  return classifications;
}

export function classifyUrlMap<T extends UrlMapEntry>(
  entries: T[],
): (T & { classifications: Classification[] })[] {
  return entries.map((entry) => ({ ...entry, classifications: classifyEntry(entry) }));
}

export function isValidClassification(value: unknown): value is Classification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== 4) return false;
  return (
    typeof v.category === "string" &&
    (CATEGORY_IDS as readonly string[]).includes(v.category) &&
    typeof v.role === "string" &&
    (ROLES as readonly string[]).includes(v.role) &&
    typeof v.confidence === "string" &&
    (CONFIDENCES as readonly string[]).includes(v.confidence) &&
    typeof v.reason === "string" &&
    v.reason.length > 0
  );
}

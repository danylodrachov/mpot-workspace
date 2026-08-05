// Deterministic, read-only data shaping for the discovery review artifact.
// Pure functions only — no I/O, no rendering. The reviewer applies this logic
// against document-url-map.json, sports.json, live-casino.json, slots.json,
// extraction-recipe.json, page-behavior.json, and url-source-coverage.json.

import { CATEGORY_IDS, ROLES, CONFIDENCES, type CategoryId, type Classification } from "../template-classification/classify.ts";

export { CATEGORY_IDS };

export type UrlMapEntryLike = {
  canonicalUrl: string;
  derivedLabel?: string | null;
  originStatus: "official_same_origin" | "external_approved";
  source: string;
  classifications: unknown;
};

export type MalformedReason =
  | "classifications_not_array"
  | "unknown_category"
  | "invalid_role"
  | "invalid_confidence"
  | "missing_reason";

export type MalformedEntry = {
  entry: UrlMapEntryLike;
  reasons: MalformedReason[];
};

function isKnownCategory(value: unknown): value is CategoryId {
  return typeof value === "string" && (CATEGORY_IDS as readonly string[]).includes(value);
}

export function findMalformedReasons(entry: UrlMapEntryLike): MalformedReason[] {
  const reasons: MalformedReason[] = [];
  if (!Array.isArray(entry.classifications)) {
    reasons.push("classifications_not_array");
    return reasons;
  }
  for (const c of entry.classifications as unknown[]) {
    const v = (c ?? {}) as Record<string, unknown>;
    if (!isKnownCategory(v.category)) reasons.push("unknown_category");
    if (typeof v.role !== "string" || !(ROLES as readonly string[]).includes(v.role)) {
      reasons.push("invalid_role");
    }
    if (typeof v.confidence !== "string" || !(CONFIDENCES as readonly string[]).includes(v.confidence)) {
      reasons.push("invalid_confidence");
    }
    if (typeof v.reason !== "string" || v.reason.length === 0) reasons.push("missing_reason");
  }
  return reasons;
}

export function partitionMalformed<T extends UrlMapEntryLike>(
  entries: T[],
): { valid: (T & { classifications: Classification[] })[]; malformed: MalformedEntry[] } {
  const valid: (T & { classifications: Classification[] })[] = [];
  const malformed: MalformedEntry[] = [];
  for (const entry of entries) {
    const reasons = findMalformedReasons(entry);
    if (reasons.length > 0) {
      malformed.push({ entry, reasons });
    } else {
      valid.push(entry as T & { classifications: Classification[] });
    }
  }
  return { valid, malformed };
}

const ROLE_ORDER: Record<string, number> = { primary: 0, supporting: 1 };
const CONFIDENCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export type MappedPageRow<T extends UrlMapEntryLike> = {
  entry: T;
  classification: Classification;
};

export function mappedPagesForCategory<T extends UrlMapEntryLike & { classifications: Classification[] }>(
  entries: T[],
  category: CategoryId,
): MappedPageRow<T>[] {
  const rows: MappedPageRow<T>[] = [];
  for (const entry of entries) {
    for (const classification of entry.classifications) {
      if (classification.category === category) {
        rows.push({ entry, classification });
      }
    }
  }
  return rows.sort((a, b) => {
    const roleDiff = ROLE_ORDER[a.classification.role] - ROLE_ORDER[b.classification.role];
    if (roleDiff !== 0) return roleDiff;
    const confDiff = CONFIDENCE_ORDER[a.classification.confidence] - CONFIDENCE_ORDER[b.classification.confidence];
    if (confDiff !== 0) return confDiff;
    const labelA = a.entry.derivedLabel ?? "";
    const labelB = b.entry.derivedLabel ?? "";
    if (labelA !== labelB) return labelA.localeCompare(labelB);
    return a.entry.canonicalUrl.localeCompare(b.entry.canonicalUrl);
  });
}

export type CategorySection = {
  category: CategoryId;
  status: "mapped" | "not_found";
  rows: MappedPageRow<UrlMapEntryLike & { classifications: Classification[] }>[];
};

export function buildCategorySections<T extends UrlMapEntryLike & { classifications: Classification[] }>(
  entries: T[],
): CategorySection[] {
  return CATEGORY_IDS.map((category) => {
    const rows = mappedPagesForCategory(entries, category);
    return { category, status: rows.length > 0 ? "mapped" : "not_found", rows } as CategorySection;
  });
}

export function headerCounts<T extends UrlMapEntryLike>(entries: T[]): {
  totalDiscovered: number;
  classifiedCount: number;
  unclassifiedCount: number;
  mappedCategoryCount: number;
  missingCategoryCount: number;
} {
  const { valid } = partitionMalformed(entries);
  const classifiedCount = valid.filter((e) => (e.classifications as Classification[]).length > 0).length;
  const unclassifiedCount = entries.length - classifiedCount;
  const sections = buildCategorySections(valid);
  const mappedCategoryCount = sections.filter((s) => s.status === "mapped").length;
  const missingCategoryCount = sections.length - mappedCategoryCount;
  return {
    totalDiscovered: entries.length,
    classifiedCount,
    unclassifiedCount,
    mappedCategoryCount,
    missingCategoryCount,
  };
}

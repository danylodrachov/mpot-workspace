// FIX-05: deterministic, generic error/soft-404 page classification. Nothing here is scoped to
// a specific hostname/casino brand — every pattern below is a generic web-platform convention
// (terminal /404, /not-found, etc., and generic English error-page copy markers). A run that
// needs to recognize a genuinely bespoke error route for one target should extend the versioned
// pattern list below (bumping ERROR_PAGE_RULES_VERSION), never hardcode a one-off check at a
// crawler call site.
export const ERROR_PAGE_RULES_VERSION = 'error-page-rules-2026-08-11-v1';

// Tier 1 (highest-priority signal): the final URL's path terminates in a recognized generic
// error-route segment. "Terminates" is deliberate — /404 nested anywhere as the LAST path
// segment (e.g. /en/404, /support/404) still counts, but a route that merely contains "404" as
// part of a longer, non-terminal segment (e.g. /article/404-reasons-to-play) does not.
const ERROR_ROUTE_PATTERNS: RegExp[] = [
  /\/404\/?$/i,
  /\/not-found\/?$/i,
  /\/page-not-found\/?$/i,
  /\/error\/404\/?$/i,
  /\/error-404\/?$/i,
];

export function isErrorRoutePath(pathname: string): boolean {
  return ERROR_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

// Tier 3 (soft-error heuristic): generic English error-page copy markers only — never a brand's
// literal error-page title/markup. Deliberately conservative: a single marker (e.g. the word
// "error" appearing somewhere in a legitimate page) is never enough on its own; both an
// independent title-level AND a body-level marker must agree before a page is even considered
// `suspected_error_page` (see detectSoftErrorSignals below).
const ERROR_TITLE_MARKERS: RegExp[] = [/\b404\b/i, /not found/i, /page (?:not|isn't) found/i, /^error(?:\s|$)/i];
const ERROR_BODY_MARKERS: RegExp[] = [
  /\b404\b/i,
  /page (?:you(?:'re| are) looking for|you requested) (?:could not|couldn't|can(?:not|'t)) be found/i,
  /this page (?:does not|doesn't) exist/i,
  /\bpage not found\b/i,
];

export interface SoftErrorHeuristicInput {
  title?: string;
  html: string;
}

export interface SoftErrorHeuristicResult {
  suspected: boolean;
  signals: string[];
}

// Only ever called for a page that already kept its requested route (tier 1 did not match) and
// already returned a non-error HTTP status (tier 2 did not match) — this is exclusively the
// "content looks wrong despite a clean URL/status" case. Requires at least two independent
// generic markers (one title-level, one body-level) to agree before flagging
// `suspected_error_page`; a lone marker never forces any classification by itself.
export function detectSoftErrorSignals(input: SoftErrorHeuristicInput): SoftErrorHeuristicResult {
  const signals: string[] = [];
  const title = (input.title ?? '').trim();
  if (title.length > 0 && title.length < 80 && ERROR_TITLE_MARKERS.some((pattern) => pattern.test(title))) {
    signals.push(`title_matches_generic_error_marker:${title}`);
  }

  // Bounded sample — a soft-error page's own error copy is always near the top of the rendered
  // document; scanning the whole HTML body would be both wasteful and more prone to false
  // positives from unrelated footer/legal copy further down the page.
  const bodySample = input.html.slice(0, 20000);
  const bodyMatch = ERROR_BODY_MARKERS.find((pattern) => pattern.test(bodySample));
  if (bodyMatch) {
    signals.push(`body_matches_generic_error_marker:${bodyMatch.source}`);
  }

  return { suspected: signals.length >= 2, signals };
}

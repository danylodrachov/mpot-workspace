// Shared contracts for the url-map-recon pipeline (ADR-001).
//
// Core invariant: everything the LLM recon agent produces or consumes here is
// URL-shaped data (absolute URLs, route paths, source ids, counts, booleans,
// statuses, errors) — never DOM text, textContent/innerText, alt/title text,
// JSON bodies, script bodies, or product names. See README-codebase / ADR-001.

export const SOURCE_FAMILIES = [
  'dom_url_attributes',
  'document_metadata',
  'frame_form',
  'network_request',
  'performance_resource',
  'inline_script',
  'same_origin_script',
  'json_endpoint',
  'framework_manifest',
  'robots_sitemap',
  'sitemap_index',
  'spa_route',
  'locale_variant',
  'menu_injected',
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export const COVERAGE_STATUSES = ['present', 'absent', 'blocked', 'unsupported', 'error'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** {output_dir}/url-source-coverage.json — one entry per source family, always. */
export type SourceCoverageEntry = { sourceFamily: SourceFamily; status: CoverageStatus; note?: string };
export type SourceCoverage = SourceCoverageEntry[];

export function emptyCoverage(): SourceCoverage {
  return SOURCE_FAMILIES.map((sourceFamily) => ({ sourceFamily, status: 'unsupported' as CoverageStatus }));
}

// --- Entry / origin contract (document-url-map.json entries) -------------

export const ENTRY_SOURCES = [
  'dom_anchor',
  'config_route',
  'bundle_footer',
  'bundle_seo',
  'bundle_other',
  'external',
  'robots_sitemap',
  'sitemap_index',
  'performance_resource',
  'network_request',
  'framework_manifest',
  'spa_route',
  'document_metadata',
  'frame_form',
] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const ORIGIN_STATUSES = ['official_same_origin', 'external_approved'] as const;
export type OriginStatus = (typeof ORIGIN_STATUSES)[number];

export type LabelSource = 'url_slug';

export type UrlMapEntry = {
  canonicalUrl: string;
  derivedLabel?: string;
  labelSource?: LabelSource;
  originStatus: OriginStatus;
  source: EntrySource;
};

// Note: template-category classification (mapping URLs to research-template
// categories) is explicitly out of scope for this session — do not add a
// `classifications` field or a classification module here.

// --- Declarative extraction recipe (extraction-recipe.json) --------------

export const EXTRACTOR_IDS = [
  'DOM_URL_ATTRIBUTES_V1',
  'DOCUMENT_METADATA_URLS_V1',
  'FRAME_FORM_URLS_V1',
  'NETWORK_REQUEST_URLS_V1',
  'PERFORMANCE_RESOURCE_URLS_V1',
  'INLINE_SCRIPT_URL_TOKENS_V1',
  'SAME_ORIGIN_SCRIPT_URL_TOKENS_V1',
  'JSON_ENDPOINT_URL_TOKENS_V1',
  'FRAMEWORK_MANIFEST_URL_TOKENS_V1',
  'ROBOTS_SITEMAP_URLS_V1',
  'SITEMAP_URLS_V1',
  'SPA_ROUTE_URL_TOKENS_V1',
  'INTERACTION_NAVIGATION_URLS_V1',
] as const;
export type ExtractorId = (typeof EXTRACTOR_IDS)[number];

export type RecipeStepV1 = {
  extractorId: ExtractorId;
  pageUrl: string;
  source: EntrySource;
  params?: Record<string, unknown>;
  resultType: 'url_list';
};

export type RecipeV1 = {
  version: 1;
  casinoId: string;
  recordedAt: string;
  steps: RecipeStepV1[];
};

// --- Extractor input/output ------------------------------------------------
//
// Extractors are pure TS functions. In production they run inside the page via
// browser_evaluate; offline/in-repo they take an already-supplied text/array
// snapshot. The return type structurally cannot carry the raw input back out —
// only `urls`, `status`, and `error`.

export type ExtractorInput = {
  pageUrl: string;
  params?: Record<string, unknown>;
  /** raw HTML snapshot supplied by the caller (never echoed back) */
  html?: string;
  /** script bodies supplied by the caller (never echoed back) */
  scripts?: string[];
  /** JSON/config text supplied by the caller (never echoed back) */
  json?: string;
  /** plain text supplied by the caller, e.g. robots.txt / sitemap.xml body */
  text?: string;
  /** pre-resolved candidate URL/path strings (e.g. Performance API entries) */
  candidates?: string[];
};

export type ExtractorStatus = 'ok' | 'empty' | 'error';

export type ExtractorResult = {
  status: ExtractorStatus;
  urls: string[];
  rejectedCount: number;
  error?: string;
};

export type ExtractorFn = (input: ExtractorInput) => ExtractorResult;

// --- Product collection -----------------------------------------------------

export type ProductSection = 'sports' | 'live-casino' | 'slots';

export type ProductEntry = { title: string; url: string | null };

export type ProductSectionResult =
  | { section: ProductSection; items: ProductEntry[] }
  | { section: ProductSection; status: 'human_required' | 'blocked' | 'absent'; reason: string };

// --- Page behavior profiling -----------------------------------------------

export const BEHAVIOR_SECTIONS = ['landing', 'sports', 'live-casino', 'slots', 'cashier', 'promotions'] as const;
export type BehaviorSection = (typeof BEHAVIOR_SECTIONS)[number];

export type GateType = 'age_verification' | 'cookie_consent' | 'geo_block' | 'login_required' | 'marketing_popup';
export type GateTrigger = 'immediate' | 'after_age_gate' | 'after_cookie_gate' | 'on_interaction' | 'on_scroll';

export type Gate = {
  type: GateType;
  trigger: GateTrigger;
  dismiss: string; // CSS selector or interaction path
};

export type RenderingType = 'static_html' | 'js_loaded' | 'modal' | 'partial_dynamic';
export type LoadIndicator = 'spinner' | 'skeleton' | 'placeholder' | 'none';
export type ContentStructure = 'list' | 'grid' | 'tabs' | 'accordion' | 'carousel' | 'custom';
export type CollectionType = 'static_list' | 'pagination' | 'load_more' | 'infinite_scroll' | 'per_click' | 'unknown';

export type InteractiveElement = {
  type: 'tab' | 'dropdown' | 'filter' | 'accordion' | 'sort' | 'pagination' | 'load_more' | 'button';
  selector: string;
  effect: string;
  count?: number; // for tabs, dropdowns, etc.
};

export type Collection = {
  type: CollectionType;
  visible_count: number;
  total_count?: number; // if indicated on page
};

export type SectionBehavior = {
  nav_path?: string[]; // click paths to navigate to this section
  url: string;
  rendering: RenderingType;
  load_indicator?: LoadIndicator;
  content_structure: ContentStructure;
  interactive_elements?: InteractiveElement[];
  collection: Collection;
  collector_items?: number; // counts from deterministic product collector
  notes?: string;
};

export type BehaviorSectionResult =
  | SectionBehavior
  | { status: 'human_required' | 'blocked' | 'absent'; reason: string };

export type PageBehaviorProfile = {
  casino_id: string;
  geo: string;
  locale: string;
  profiled_at: string;
  landing?: {
    url: string;
    gates?: Gate[];
  };
  sections?: Partial<Record<BehaviorSection, BehaviorSectionResult>>;
};

import type { TechnicalDecision, TechnicalRejectReason } from './types.ts';

const SCRIPT_EXT = /\.(?:js|mjs|cjs)(?:$|[?#])/i;
const SOURCE_MAP_EXT = /\.map(?:$|[?#])/i;
const FONT_EXT = /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i;
const STYLE_EXT = /\.(?:css|scss|sass|less)(?:$|[?#])/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)(?:$|[?#])/i;
const MEDIA_EXT = /\.(?:mp4|m4v|webm|mov|avi|mpe?g|mp3|m4a|wav|ogg|oga|ogv|flac|aac)(?:$|[?#])/i;
const BROWSER_INTERNAL_SCHEMES = /^(?:about|chrome|chrome-extension|devtools|edge|moz-extension):/i;

const TRACKING_QUERY_KEYS = new Set([
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  '_ga',
  '_gl',
  'mc_cid',
  'mc_eid',
]);

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

export function hostInScope(hostname: string, allowedHosts: Iterable<string>): boolean {
  const candidate = normalizeHostname(hostname);
  for (const rawAllowed of allowedHosts) {
    const allowed = normalizeHostname(rawAllowed);
    if (!allowed) continue;
    if (candidate === allowed) return true;
    if (candidate.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function rejectAsset(url: URL): TechnicalRejectReason | undefined {
  const value = `${url.pathname}${url.search}`;
  if (SOURCE_MAP_EXT.test(value)) return 'SOURCE_MAP';
  if (SCRIPT_EXT.test(value)) return 'ASSET_SCRIPT';
  if (FONT_EXT.test(value)) return 'ASSET_FONT';
  if (STYLE_EXT.test(value)) return 'ASSET_STYLESHEET';
  if (IMAGE_EXT.test(value)) return 'ASSET_IMAGE';
  if (MEDIA_EXT.test(value)) return 'ASSET_MEDIA';
  return undefined;
}

function canonicalize(url: URL): string {
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower)) {
      url.searchParams.delete(key);
    }
  }

  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk),
  );
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);

  // Preserve hash-routed application states such as #!/player/profile-deposit and #/cashier.
  // Plain document anchors are not distinct pages and are removed.
  if (url.hash && !/^#!?\//.test(url.hash)) url.hash = '';

  return url.href;
}

export function technicalFilter(
  rawUrl: string,
  baseUrl: string,
  allowedHosts: Iterable<string>,
): TechnicalDecision {
  const raw = rawUrl.trim().replace(/^['"`]|['"`]$/g, '').replace(/\\\//g, '/');
  if (!raw) return { status: 'rejected', reason: 'INVALID_URL' };
  if (BROWSER_INTERNAL_SCHEMES.test(raw)) return { status: 'rejected', reason: 'BROWSER_INTERNAL' };

  let parsed: URL;
  try {
    parsed = new URL(raw, baseUrl);
  } catch {
    return { status: 'rejected', reason: 'INVALID_URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'rejected', reason: 'NON_HTTP_SCHEME' };
  }

  if (!hostInScope(parsed.hostname, allowedHosts)) {
    return { status: 'rejected', reason: 'OUT_OF_SCOPE_HOST' };
  }

  const assetReason = rejectAsset(parsed);
  if (assetReason) return { status: 'rejected', reason: assetReason };

  return { status: 'accepted', url: canonicalize(parsed) };
}

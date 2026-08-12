const NON_NAVIGATION_EXT_RE = /\.(?:css|m?js|cjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mpe?g|mov|avi|mp3|wav|ogg|wasm)(?:$|[?#])/i;
const SOURCE_CODE_EXT_RE = /\.(?:vue|tsx?|jsx?|scss|sass|less)(?:$|[?#])/i;
const TECHNICAL_PATH_RE = /(?:^|\/)(?:assets?|static|node_modules|src|dist|build|_next|_nuxt|cdn-cgi)(?:\/|$)/i;
const API_PATH_RE = /(?:^|\/)(?:api|graphql)(?:\/|$)/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CODE_PATH_RE = /(?:\(\?:|\(\?=|\(\?!|=>|;\s*function\b|\.test\(|\[[^/]*\]|\{[^/]*\}|\\[dDsSwWbB]|\^|\|)/;
const ROUTE_TEMPLATE_SEGMENT_RE = /(?:^|\/)(?::[A-Za-z_][A-Za-z0-9_]*[+*?]?|\*[A-Za-z0-9_-]*|\[[^/]+\]|\{[^/]+\})(?:\/|$)/;

export type NavigationRejectReason =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'external_host'
  | 'resource_file'
  | 'source_code_file'
  | 'technical_path'
  | 'api_path'
  | 'code_syntax'
  | 'route_template'
  | 'control_character'
  | 'empty_token';

export interface NavigationUrlCheckOptions {
  allowedHosts?: ReadonlySet<string>;
  strictScriptSyntax?: boolean;
  rejectTechnicalPaths?: boolean;
  rejectApiPaths?: boolean;
}

export interface NavigationUrlCheckResult {
  ok: boolean;
  url: string | null;
  reason: NavigationRejectReason | null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cleanUrlToken(value: string): string {
  return value
    .replace(/\\\//g, '/')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[),.;]+$/g, '')
    .trim();
}

export function isObviousNonDocumentResource(url: URL): boolean {
  return NON_NAVIGATION_EXT_RE.test(url.pathname) || SOURCE_CODE_EXT_RE.test(url.pathname);
}

export function checkResolvedNavigationUrl(
  value: string | URL,
  options: NavigationUrlCheckOptions = {},
): NavigationUrlCheckResult {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    return { ok: false, url: null, reason: 'invalid_url' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, url: null, reason: 'unsupported_scheme' };
  }

  if (options.allowedHosts && !options.allowedHosts.has(url.hostname.toLowerCase())) {
    return { ok: false, url: url.toString(), reason: 'external_host' };
  }

  if (NON_NAVIGATION_EXT_RE.test(url.pathname)) {
    return { ok: false, url: url.toString(), reason: 'resource_file' };
  }
  if (SOURCE_CODE_EXT_RE.test(url.pathname)) {
    return { ok: false, url: url.toString(), reason: 'source_code_file' };
  }

  const decodedPath = safeDecode(url.pathname);
  if (CONTROL_RE.test(decodedPath)) {
    return { ok: false, url: url.toString(), reason: 'control_character' };
  }
  if (ROUTE_TEMPLATE_SEGMENT_RE.test(decodedPath)) {
    return { ok: false, url: url.toString(), reason: 'route_template' };
  }
  if (options.strictScriptSyntax && CODE_PATH_RE.test(decodedPath)) {
    return { ok: false, url: url.toString(), reason: 'code_syntax' };
  }
  if (options.rejectTechnicalPaths && TECHNICAL_PATH_RE.test(decodedPath)) {
    return { ok: false, url: url.toString(), reason: 'technical_path' };
  }
  if (options.rejectApiPaths && API_PATH_RE.test(decodedPath)) {
    return { ok: false, url: url.toString(), reason: 'api_path' };
  }

  return { ok: true, url: url.toString(), reason: null };
}

export function resolveNavigationToken(
  token: string,
  baseUrl: string,
  options: NavigationUrlCheckOptions = {},
): NavigationUrlCheckResult {
  const normalized = cleanUrlToken(token);
  if (!normalized) return { ok: false, url: null, reason: 'empty_token' };
  if (CONTROL_RE.test(normalized)) return { ok: false, url: null, reason: 'control_character' };

  let resolved: URL;
  try {
    const base = new URL(baseUrl);
    if (/^https?:\/\//i.test(normalized)) {
      resolved = new URL(normalized);
    } else if (normalized.startsWith('//')) {
      resolved = new URL(`${base.protocol}${normalized}`);
    } else if (normalized.startsWith('/')) {
      resolved = new URL(normalized, base.origin);
    } else {
      resolved = new URL(`/${normalized.replace(/^\.\//, '').replace(/^\.\.\//, '')}`, base.origin);
    }
  } catch {
    return { ok: false, url: null, reason: 'invalid_url' };
  }

  return checkResolvedNavigationUrl(resolved, options);
}

export function isPlausibleScriptRouteToken(token: string): boolean {
  const normalized = cleanUrlToken(token);
  if (!normalized || CONTROL_RE.test(normalized)) return false;

  // Script discovery is fallback discovery. Require an actual URL/path shape instead of
  // accepting arbitrary JavaScript punctuation that happens to contain a slash.
  if (
    !/^https?:\/\//i.test(normalized) &&
    !normalized.startsWith('//') &&
    !/^\/(?:[A-Za-z0-9%]|$)/.test(normalized) &&
    !/^(?:\.\.?\/)?[A-Za-z0-9%][A-Za-z0-9%._~-]*\/[A-Za-z0-9%]/.test(normalized)
  ) {
    return false;
  }

  const pathish = safeDecode(normalized.split(/[?#]/, 1)[0] ?? normalized);
  if (CODE_PATH_RE.test(pathish) || ROUTE_TEMPLATE_SEGMENT_RE.test(pathish)) return false;
  if (SOURCE_CODE_EXT_RE.test(pathish) || NON_NAVIGATION_EXT_RE.test(pathish)) return false;
  return true;
}

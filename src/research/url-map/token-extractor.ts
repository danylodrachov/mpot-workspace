const ABSOLUTE_URL_RE = /https?:\\?\/\\?\/[A-Za-z0-9._~%:-]+(?:[/?#][^\s"'`<>\\)]*)?/gi;
const PROTOCOL_RELATIVE_RE = /(?<!:)\/\/[A-Za-z0-9._~%-]+(?:[/?#][^\s"'`<>\\)]*)?/g;
const ROOT_ROUTE_RE = /(?:^|["'`(,:=\s])((?:\\\/|\/)(?!\/)[A-Za-z0-9@._~%!$&'()*+,;=:/?#[\]-]{1,500})/g;
const RELATIVE_ROUTE_RE = /(?:^|["'`(,:=\s])((?:\.\.\/|\.\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9@._~%!$&'()*+,;=:/?#[\]-]{1,500})/g;

function cleanToken(value: string): string {
  return value
    .replace(/\\\//g, '/')
    .replace(/[),.;]+$/g, '')
    .trim();
}

export function extractUrlLikeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(ABSOLUTE_URL_RE)) out.add(cleanToken(match[0]));
  for (const match of text.matchAll(PROTOCOL_RELATIVE_RE)) out.add(cleanToken(match[0]));
  for (const match of text.matchAll(ROOT_ROUTE_RE)) out.add(cleanToken(match[1]));
  for (const match of text.matchAll(RELATIVE_ROUTE_RE)) out.add(cleanToken(match[1]));
  return [...out].filter(Boolean);
}

export function resolveCasinoRouteToken(
  token: string,
  entryUrl: string,
  allowedHosts: ReadonlySet<string>,
): string | null {
  const normalized = cleanToken(token);
  const entry = new URL(entryUrl);

  let resolved: URL;
  try {
    if (/^https?:\/\//i.test(normalized)) {
      resolved = new URL(normalized);
    } else if (normalized.startsWith('//')) {
      resolved = new URL(`${entry.protocol}${normalized}`);
    } else if (normalized.startsWith('/')) {
      resolved = new URL(normalized, entry.origin);
    } else {
      resolved = new URL(`/${normalized.replace(/^\.\//, '').replace(/^\.\.\//, '')}`, entry.origin);
    }
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(resolved.protocol)) return null;
  if (!allowedHosts.has(resolved.hostname.toLowerCase())) return null;
  return resolved.toString();
}

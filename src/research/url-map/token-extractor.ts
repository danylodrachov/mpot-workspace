import {
  cleanUrlToken,
  isPlausibleScriptRouteToken,
  resolveNavigationToken,
} from './navigation-url.ts';

const ABSOLUTE_URL_RE = /https?:\\?\/\\?\/[A-Za-z0-9._~%:-]+(?:[/?#][^\s"'`<>\\)]*)?/gi;
const PROTOCOL_RELATIVE_RE = /(?<!:)\/\/[A-Za-z0-9._~%-]+(?:[/?#][^\s"'`<>\\)]*)?/g;

// Root routes must begin with a path character. This intentionally excludes regex/code
// fragments such as /-(, /;(?![, /(?:Once and /[A-Z]/ that polluted URL discovery.
const ROOT_ROUTE_RE = /(?:^|["'`(,:=\s])((?:\\\/|\/)(?!\/)[A-Za-z0-9%][A-Za-z0-9@._~%!$&'+,;=:/?#[\]-]{0,500})/g;
const RELATIVE_ROUTE_RE = /(?:^|["'`(,:=\s])((?:\.\.\/|\.\/)?[A-Za-z0-9%][A-Za-z0-9%._~-]*\/[A-Za-z0-9@._~%!$&'+,;=:/?#[\]-]{1,500})/g;

export function extractUrlLikeTokens(text: string): string[] {
  const out = new Set<string>();
  const add = (value: string): void => {
    const cleaned = cleanUrlToken(value);
    if (isPlausibleScriptRouteToken(cleaned)) out.add(cleaned);
  };

  for (const match of text.matchAll(ABSOLUTE_URL_RE)) add(match[0]);
  for (const match of text.matchAll(PROTOCOL_RELATIVE_RE)) add(match[0]);
  for (const match of text.matchAll(ROOT_ROUTE_RE)) add(match[1]);
  for (const match of text.matchAll(RELATIVE_ROUTE_RE)) add(match[1]);
  return [...out];
}

export function resolveCasinoRouteToken(
  token: string,
  entryUrl: string,
  allowedHosts: ReadonlySet<string>,
): string | null {
  if (!isPlausibleScriptRouteToken(token)) return null;
  const result = resolveNavigationToken(token, entryUrl, {
    allowedHosts,
    strictScriptSyntax: true,
    rejectTechnicalPaths: true,
    rejectApiPaths: true,
  });
  return result.ok ? result.url : null;
}

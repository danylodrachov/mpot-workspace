const ABSOLUTE_URL_RE = /https?:\\?\/\\?\/[A-Za-z0-9._~%\-]+(?::\d{1,5})?(?:[/?#][^\s"'`<>\\)]*)?/g;
const ROUTE_RE = /(?:^|["'`(=,:\s])((?:\\?\/){1,2}[A-Za-z0-9._~%+@\-][A-Za-z0-9._~%!$&()*+,;=:@\-\\/]*(?:\?[^\s"'`<>\\)]*)?(?:#[^\s"'`<>\\)]*)?)/gm;
const FILE_EXT_RE = /\.(?:m?js|cjs|css|map|vue|tsx?|jsx?|svelte|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)(?:$|[?#])/i;
const TEMPLATE_RE = /\$\{|<%|\{\{|\?\.|=>/;

function decodeJsEscapes(value: string): string {
  return value
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\x2[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function trimPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, '');
}

export function looksLikeDocumentRouteToken(value: string): boolean {
  if (!value || value.length > 2048) return false;
  if (TEMPLATE_RE.test(value)) return false;
  if (/^(?:data|blob|javascript|mailto|tel):/i.test(value)) return false;
  if (FILE_EXT_RE.test(value)) return false;
  if (/\/(?:src|node_modules|assets?|static|dist|build|chunks?|fonts?|images?|img|icons?|favicons?)(?:\/|$)/i.test(value)) return false;
  if (/^https?:\/\/(?:www\.)?w3\.org\//i.test(value)) return false;
  if (/^\/(?:engine\.io|socket\.io)(?:\/|$)/i.test(value)) return false;
  if (/[,{}<>]$/.test(value)) return false;
  return /^(?:https?:\/\/|\/)/i.test(value);
}

export function extractUrlTokens(text: string, limit = 5000): string[] {
  if (!text) return [];
  const decoded = decodeJsEscapes(text);
  const out = new Set<string>();
  const add = (raw: string) => {
    if (out.size >= limit) return;
    const token = trimPunctuation(decodeJsEscapes(raw));
    if (looksLikeDocumentRouteToken(token)) out.add(token);
  };

  for (const match of decoded.matchAll(ABSOLUTE_URL_RE)) add(match[0]);
  for (const match of decoded.matchAll(ROUTE_RE)) add(match[1]);
  return [...out];
}

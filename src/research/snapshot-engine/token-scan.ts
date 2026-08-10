export interface UrlTokenScanOptions {
  maxTokens?: number;
  maxTokenLength?: number;
}

export function scanUrlTokens(text: string, options: UrlTokenScanOptions = {}): string[] {
  const maxTokens = options.maxTokens ?? 20_000;
  const maxTokenLength = options.maxTokenLength ?? 1024;
  const out = new Set<string>();

  const push = (value: string) => {
    if (out.size >= maxTokens) return;
    const normalized = value
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();
    if (!normalized || normalized.length > maxTokenLength) return;
    out.add(normalized);
  };

  const absolute = /https?:\\?\/\\?\/[^\s"'<>`\\]+/gi;
  for (const match of text.matchAll(absolute)) {
    push(match[0]);
    if (out.size >= maxTokens) break;
  }

  if (out.size < maxTokens) {
    const rootPath = /["'`]((?:\\?\/)[A-Za-z0-9][^"'`<>\s]{0,1023})["'`]/g;
    for (const match of text.matchAll(rootPath)) {
      push(match[1] ?? '');
      if (out.size >= maxTokens) break;
    }
  }

  return [...out];
}

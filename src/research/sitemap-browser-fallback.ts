import type { PageLike } from './url-map/types.ts';

export interface SitemapDocumentFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

export interface SitemapBrowserFetchOptions {
  timeoutMs: number;
}

export type SitemapBrowserFetcher = (
  url: string,
  options: SitemapBrowserFetchOptions,
) => Promise<SitemapDocumentFetchResult>;

type SitemapNavigationPage = Pick<PageLike, 'goto' | 'url' | 'evaluate'> & {
  close?: () => Promise<void>;
};

type ContextCapablePage = SitemapNavigationPage & {
  context?: () => {
    newPage(): Promise<SitemapNavigationPage>;
  };
};

function headerValue(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/**
 * Deterministic access-gate detector used only to decide whether an API-level
 * sitemap/robots fetch should be retried as a real Chromium navigation.
 */
export function isSitemapAccessGateResponse(response: SitemapDocumentFetchResult): boolean {
  if ([401, 403, 429].includes(response.status)) return true;

  const server = headerValue(response.headers, 'server') ?? '';
  const hasCloudflareHeader = /cloudflare/i.test(server) || Boolean(headerValue(response.headers, 'cf-ray'));
  if (response.status >= 500 && response.status <= 599 && hasCloudflareHeader) return true;

  const contentType = headerValue(response.headers, 'content-type') ?? '';
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return false;

  const sample = response.body.subarray(0, 50_000).toString('utf8');
  return (
    /\/cdn-cgi\/challenge-platform\//i.test(sample) ||
    /\bcf-chl-/i.test(sample) ||
    /\bjust a moment\b/i.test(sample) ||
    /checking (?:your )?browser/i.test(sample) ||
    /performing security verification/i.test(sample) ||
    /verify (?:that )?you are human/i.test(sample) ||
    /enable javascript and cookies to continue/i.test(sample)
  );
}

/**
 * Browser-backed fetcher that stays in the existing BrowserContext. In a real
 * Playwright Page it uses a temporary page so sitemap acquisition cannot
 * overwrite the discovery page's current document. Minimal PageLike test
 * doubles without context() fall back to the supplied page.
 */
export function createBrowserSitemapFetcher(page: ContextCapablePage): SitemapBrowserFetcher {
  return async (url, options) => {
    const context = page.context?.();
    const navigationPage = context ? await context.newPage() : page;
    const ownsNavigationPage = navigationPage !== page;

    try {
      const response = await navigationPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      });
      if (!response) throw new Error(`Browser sitemap navigation returned no response: ${url}`);

      const headers = response.headers?.() ?? {};
      let body: Buffer;
      if (response.body) {
        body = await response.body();
      } else {
        const rendered = await navigationPage.evaluate(() =>
          document.documentElement?.outerHTML ?? document.body?.textContent ?? '',
        );
        body = Buffer.from(rendered, 'utf8');
      }

      return {
        status: response.status(),
        headers,
        body,
        finalUrl: response.url?.() || navigationPage.url() || url,
      };
    } finally {
      if (ownsNavigationPage) await navigationPage.close?.();
    }
  };
}

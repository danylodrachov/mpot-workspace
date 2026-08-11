import type { PageLike, RawUrlCandidate } from './types.ts';

function now(): string { return new Date().toISOString(); }

export async function extractPageCandidates(page: PageLike, limit = 5000): Promise<RawUrlCandidate[]> {
  const visitedUrl = page.url();
  const observedAt = now();
  const result = await page.evaluate<any, { limit: number }>(({ limit }) => {
    const scan = (text: string, scanLimit: number): string[] => {
      if (!text) return [];
      const normalized = String(text)
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\x2[fF]/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
      const out = new Set<string>();
      const abs = /https?:\/\/[A-Za-z0-9._~%\-]+(?::\d{1,5})?(?:[/?#][^\s"'`<>\\)]*)?/g;
      const route = /(?:^|["'`(=,:\s])(\/[A-Za-z0-9._~%+@\-][A-Za-z0-9._~%!$&()*+,;=:@\-/]*(?:\?[^\s"'`<>\\)]*)?(?:#[^\s"'`<>\\)]*)?)/gm;
      const bad = /\.(?:m?js|cjs|css|map|vue|tsx?|jsx?|svelte|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot)(?:$|[?#])/i;
      const add = (candidate: string) => {
        const value = String(candidate || '').replace(/[),.;:]+$/g, '');
        if (!value || value.length > 2048 || bad.test(value) || /\$\{|<%|\{\{|\?\.|=>/.test(value)) return;
        if (/\/(?:src|node_modules|assets?|static|dist|build|chunks?|fonts?|images?|img|icons?|favicons?)(?:\/|$)/i.test(value)) return;
        if (/^\/(?:engine\.io|socket\.io)(?:\/|$)/i.test(value)) return;
        out.add(value);
      };
      for (const match of normalized.matchAll(abs)) { add(match[0]); if (out.size >= scanLimit) break; }
      if (out.size < scanLimit) for (const match of normalized.matchAll(route)) { add(match[1]); if (out.size >= scanLimit) break; }
      return [...out];
    };
    const rows: Array<{ value: string; family: string; attribute?: string; label?: string; sourceUrl?: string }> = [];
    const push = (value: unknown, family: string, attribute?: string, label?: string, sourceUrl?: string) => {
      if (typeof value !== 'string' || !value.trim() || rows.length >= limit) return;
      rows.push({ value: value.trim(), family, attribute, label, sourceUrl });
    };

    const attrs = ['href', 'src', 'action', 'formaction', 'poster', 'data-href', 'data-url', 'routerlink'];
    for (const el of document.querySelectorAll('*')) {
      for (const attribute of attrs) {
        if (el.hasAttribute(attribute)) {
          const tag = el.tagName.toLowerCase();
          const value = el.getAttribute(attribute);
          const isMeta = tag === 'link' || tag === 'meta';
          const isFrameForm = ['form', 'iframe', 'frame', 'area', 'button', 'input'].includes(tag);
          push(value, isMeta ? 'document_metadata' : isFrameForm ? 'frame_form_url' : 'dom_url_attribute', attribute, tag);
        }
      }
    }

    for (const meta of document.querySelectorAll('meta[http-equiv="refresh"]')) {
      const content = meta.getAttribute('content') || '';
      const match = content.match(/(?:^|;)\s*url\s*=\s*(.+)$/i);
      if (match) push(match[1].replace(/^['"]|['"]$/g, ''), 'document_metadata', 'content', 'meta-refresh');
    }

    // Scan inline script/config text in-page and return URL/path tokens only.
    for (const script of document.querySelectorAll('script:not([src])')) {
      const tokens = scan(script.textContent || '', Math.min(1000, limit - rows.length));
      const scriptType = script instanceof HTMLScriptElement ? script.type : '';
      for (const token of tokens) push(token, 'inline_script_url_token', undefined, scriptType || 'inline-script');
      if (rows.length >= limit) break;
    }

    // History API instrumentation is installed before navigation by installHistoryInstrumentation().
    const historyRows = Array.isArray((window as any).__MPOT_HISTORY_URLS__) ? (window as any).__MPOT_HISTORY_URLS__ : [];
    for (const item of historyRows) push(item.url, 'history_route', undefined, item.kind || 'history');

    const perf = performance.getEntriesByType('resource');
    for (const item of perf) push((item as PerformanceResourceTiming).name, 'performance_resource', undefined, (item as PerformanceResourceTiming).initiatorType);

    return rows;
  }, { limit });

  return result.map((row: any) => ({
    rawUrl: row.value,
    baseUrl: visitedUrl,
    provenance: {
      sourceFamily: row.family,
      discoveredOn: visitedUrl,
      sourceUrl: row.sourceUrl ?? visitedUrl,
      attribute: row.attribute,
      label: row.label,
    },
    observedAt,
  }));
}

export async function installHistoryInstrumentation(page: PageLike): Promise<void> {
  const script = `(() => {
    if (window.__MPOT_HISTORY_INSTALLED__) return;
    Object.defineProperty(window, '__MPOT_HISTORY_INSTALLED__', { value: true, configurable: false });
    Object.defineProperty(window, '__MPOT_HISTORY_URLS__', { value: [], writable: false, configurable: false });
    const capture = (kind, url) => {
      if (url === undefined || url === null) return;
      try {
        const absolute = new URL(String(url), location.href).href;
        window.__MPOT_HISTORY_URLS__.push({ kind, url: absolute });
      } catch {}
    };
    for (const kind of ['pushState', 'replaceState']) {
      const original = history[kind];
      history[kind] = function(state, title, url) {
        capture(kind, url);
        return original.apply(this, arguments);
      };
    }
    addEventListener('hashchange', () => capture('hashchange', location.href));
    addEventListener('popstate', () => capture('popstate', location.href));
  })();`;
  await page.context().addInitScript({ content: script });
}

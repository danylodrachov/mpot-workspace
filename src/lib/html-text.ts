import { convert } from 'html-to-text';

function stripTagsCrude(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  if (!html) return '';
  try {
    const out = convert(html, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }],
    });
    if (out.trim()) return out;
  } catch (e) {
    console.warn(`htmlToText: lib failed — ${(e as Error).message}`);
  }
  try {
    const crude = stripTagsCrude(html);
    if (crude.trim()) return crude;
  } catch { /* fall through */ }
  return `⚠ HTML-FALLBACK: ${html}`;
}

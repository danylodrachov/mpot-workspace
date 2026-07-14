import { htmlToText } from './html-text.ts';
import { topPost } from './quote-strip.ts';

/**
 * Unicode noise out, content intact: zero-width/BOM chars dropped, exotic spaces -> plain
 * space, smart punctuation -> ASCII, emoji/pictographs dropped. Accented letters and
 * currency signs are content — untouched.
 */
export function stripNoise(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');
}

export function normalizeBody({ body, mimeType }: { body: string; mimeType?: string }): string {
  if (!body) return '';
  const isHtml = mimeType === 'text/html' || /<\w[^>]*>/.test(body);
  const plain = isHtml ? htmlToText(body) : body;
  return stripNoise(topPost(plain));
}

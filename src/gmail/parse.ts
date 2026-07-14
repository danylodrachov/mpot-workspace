import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

interface GmailParsed {
  textPlain?: string;
  textHtml?: string;
  attachments?: Array<{
    filename?: string;
    mimeType?: string;
    size?: number;
    attachmentId?: string;
  }>;
}

const parseMsg = _require('gmail-api-parse-message') as (msg: unknown) => GmailParsed;

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
}

function stripHtml(html: string): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ',
  };
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => entities[m.toLowerCase()] ?? entities[m] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractText(rawMsg: unknown): string {
  const parsed = parseMsg(rawMsg);
  if (parsed.textPlain?.trim()) return parsed.textPlain.trim();
  if (parsed.textHtml) return stripHtml(parsed.textHtml);
  return '';
}

export function extractAttachments(rawMsg: unknown): GmailAttachment[] {
  const parsed = parseMsg(rawMsg);
  return (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? '',
    mimeType: a.mimeType ?? '',
    size: a.size ?? 0,
    ...(a.attachmentId ? { attachmentId: a.attachmentId } : {}),
  }));
}

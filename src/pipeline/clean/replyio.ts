import { htmlToText } from '../../lib/html-text.ts';
import { stripNoise } from '../../lib/body-normalize.ts';
import { CleanThread, type CleanThread as CleanThreadType } from './schema.ts';

/** Sender domains that are US (outbound), never the outlet/contact. Config value, not hardcode. */
const OWN_DOMAINS = ['marketing-pot.com'];

function domainOf(address: string): string {
  const m = address.match(/@([^@>\s]+)/);
  return m ? m[1].toLowerCase() : '';
}

function deriveIsOutbound(from: string): boolean {
  const domain = domainOf(from);
  if (!domain) return false;
  return OWN_DOMAINS.some((own) => domain === own || domain.endsWith(`.${own}`));
}

/** Drop signature/tracking image tags (e.g. googleusercontent.com/mail-sig/...) before text conversion. */
function stripTrackingImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => (/googleusercontent\.com\/mail-sig/i.test(tag) ? '' : tag));
}

/** Drop the trailing reply.io unsubscribe-footer line, line by line so surrounding text survives. */
function stripUnsubscribeFooter(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/unsubscribe/i.test(line) && !/discontinue receiving/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * reply.io body clean: HTML -> text, strip tracking images + unsubscribe footer.
 * Deliberately does NOT run topPost/quote-strip — reply.io returns only the thread's
 * latest record, so the conversation history exists ONLY inside the quoted chain (issue #09).
 */
function replyioBody(rawBody: string): string {
  if (!rawBody) return '';
  const withoutTrackingImages = stripTrackingImages(rawBody);
  const isHtml = /<\w[^>]*>/.test(withoutTrackingImages);
  const plain = isHtml ? htmlToText(withoutTrackingImages) : withoutTrackingImages;
  return stripUnsubscribeFooter(stripNoise(plain));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function cleanReplyio(raw: unknown): CleanThreadType {
  const item = raw as Record<string, unknown>;
  const rawInner = (item['raw'] as Record<string, unknown> | undefined) ?? {};
  const contact = (rawInner['contact'] as Record<string, unknown> | undefined) ?? {};
  const sequence = rawInner['sequence'] as Record<string, unknown> | undefined;
  const category = rawInner['category'] as Record<string, unknown> | undefined;

  const from = String(item['from'] ?? item['email'] ?? '');

  return CleanThread.parse({
    id: item['id'],
    subject: item['subject'] ?? '',
    lastActivityDate: str(rawInner['lastActivityDate']),
    sequence: str(sequence?.['name']),
    category: str(category?.['name']),
    contact: {
      name: str(contact['fullName']),
      email: str(contact['email']),
      company: str(contact['companyName']),
      title: str(contact['title']),
    },
    messages: [{
      date: String(item['date'] ?? ''),
      from,
      isOutbound: deriveIsOutbound(from),
      body: replyioBody(String(item['body'] ?? '')),
      attachments: [],
    }],
  });
}

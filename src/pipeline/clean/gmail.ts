import { normalizeBody } from '../../lib/body-normalize.ts';
import { CleanThread, type CleanThread as CleanThreadType } from './schema.ts';
import type { GmailThreadFile } from '../../gmail/fetch.ts';

export function cleanGmail(raw: GmailThreadFile): CleanThreadType {
  const messages = raw.messages.map((msg) => ({
    date: msg.date,
    from: msg.from,
    isOutbound: msg.isOutbound,
    body: normalizeBody({ body: msg.text }),
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
  }));

  const subject =
    raw.messages.find((m) => m.subject)?.subject ?? '(no subject)';

  return CleanThread.parse({
    id: raw.threadId,
    subject,
    sequence: null,
    messages,
  });
}

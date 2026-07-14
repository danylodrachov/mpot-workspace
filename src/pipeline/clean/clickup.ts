import { normalizeBody } from '../../lib/body-normalize.ts';
import { CleanTask, type CleanTask as CleanTaskType } from './schema.ts';

export function cleanClickup(raw: unknown): CleanTaskType {
  const item = raw as Record<string, unknown>;
  const rawInner = item['raw'] as Record<string, unknown> | undefined;

  const description = String(rawInner?.['description'] ?? item['description'] ?? '');
  const comments = Array.isArray(item['comments'])
    ? (item['comments'] as Array<Record<string, unknown>>)
        .map((c) => String(c['comment_text'] ?? ''))
        .filter(Boolean)
        .join('\n\n')
    : '';
  const combined = [description, comments].filter(Boolean).join('\n\n');

  return CleanTask.parse({
    id: item['id'],
    name: item['name'],
    board: item['board'],
    status: item['status'],
    body: normalizeBody({ body: combined }),
  });
}

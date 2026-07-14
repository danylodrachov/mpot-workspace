import { z } from 'zod';

export const CleanAttachment = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

export const CleanMessage = z.object({
  date: z.string(),
  from: z.string(),
  isOutbound: z.boolean(),
  body: z.string(),
  attachments: z.array(CleanAttachment),
});

export const CleanContact = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
});

export const CleanThread = z.object({
  id: z.string(),
  subject: z.string(),
  // Campaign name (raw.sequence.name) — presence drives label:"outreach" (issue 05).
  sequence: z.string().nullable(),
  // recency source for the issue-06 sweep; same value the registry key (issue 01) uses.
  lastActivityDate: z.string().nullable().optional(),
  // reply.io's own tag (Interested / Forwarded / ...) — free tone signal for the write pass.
  category: z.string().nullable().optional(),
  // drives draft addressing + the issue-05 find-or-create match (email, then Media domain).
  contact: CleanContact.nullable().optional(),
  messages: z.array(CleanMessage),
});

export const CleanTask = z.object({
  id: z.string(),
  name: z.string(),
  board: z.string(),
  status: z.string(),
  body: z.string(),
});

export type CleanThread = z.infer<typeof CleanThread>;
export type CleanTask = z.infer<typeof CleanTask>;
export type CleanMessage = z.infer<typeof CleanMessage>;
export type CleanContact = z.infer<typeof CleanContact>;

/**
 * outbound.ts — reply.io step-targeted enrolment via contact-links/bulk (ADR 0036/0041).
 *
 * Sole write path for both boards. Two ops:
 *   enrol    → fresh contact at stepId (removeFromExisting:false)
 *   re_enrol → re-target finished contact (removeFromExisting:true + startStepId)
 *
 * Loop guard: ≤2 runs/step (caller tracks runCountForStep; this module enforces the cap).
 * Fetcher is injectable so the test stubs the single HTTP boundary; native fetch is the default.
 */
import 'dotenv/config';

const BASE = 'https://api.reply.io/v3';
const REPLYIO_TIMEOUT_MS = 20_000;
export const LOOP_GUARD_MAX = 2;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface CustomField {
  key: string;
  value: string;
}

/** The exact body sent to POST /v3/sequences/{id}/contact-links/bulk. */
export interface BulkEnrolBody {
  contacts: Array<{ id: number; customFields?: CustomField[] }>;
  startStepId: number;
  removeFromExisting: boolean;
}

/** Build the contact-links/bulk request body without making any network call. */
export function buildBulkEnrolBody(
  contactId: number,
  stepId: number,
  removeFromExisting: boolean,
  customFields?: CustomField[],
): BulkEnrolBody {
  const contact: { id: number; customFields?: CustomField[] } = { id: contactId };
  if (customFields && customFields.length > 0) contact.customFields = customFields;
  return { contacts: [contact], startStepId: stepId, removeFromExisting };
}

export interface EnrolArgs {
  apiKey: string;
  sequenceId: number;
  contactId: number;
  stepId: number;
  /** true for re_enrol (re-target finished contact); false for fresh enrol. */
  removeFromExisting: boolean;
  /** Caller-managed counter for this contact+step pair. Enforced ≤ LOOP_GUARD_MAX. */
  runCountForStep: number;
  customFields?: CustomField[];
  fetcher?: Fetcher;
}

export type EnrolResult =
  | { outcome: 'enrolled'; responseBody: unknown }
  | { outcome: 'loop_guard' }
  | { outcome: 'already_in_sequence' };

/** Enrol or re-enrol a contact at a sequence step. Returns loop_guard if the cap is hit. */
export async function enrolContact(args: EnrolArgs): Promise<EnrolResult> {
  if (args.runCountForStep >= LOOP_GUARD_MAX) {
    return { outcome: 'loop_guard' };
  }

  const doFetch = args.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' };
  const body = buildBulkEnrolBody(
    args.contactId,
    args.stepId,
    args.removeFromExisting,
    args.customFields,
  );

  const res = await doFetch(`${BASE}/sequences/${args.sequenceId}/contact-links/bulk`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REPLYIO_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `POST /sequences/${args.sequenceId}/contact-links/bulk -> ${res.status} ${await res.text()}`,
    );
  }

  const responseBody = (await res.json()) as unknown;

  // Detect per-item contactAlreadyInSequence (ADR 0036)
  const items = (responseBody as { items?: Array<{ status?: string }> }).items ?? [];
  if (items.length > 0 && items[0]?.status === 'contactAlreadyInSequence') {
    return { outcome: 'already_in_sequence' };
  }

  return { outcome: 'enrolled', responseBody };
}

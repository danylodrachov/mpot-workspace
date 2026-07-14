const OOO_PATTERN = /\b(out of office|on vacation|away from|fuera de la oficina)\b/i;
const MACHINE_SENDER_PATTERN = /\b(mailer-daemon|postmaster)@/i;
const UNSUBSCRIBE_PATTERN =
  /\b(unsubscribe(d)?\s*(confirmation|successful|complete)|you (have been|are) (successfully )?unsubscribed)\b/i;

export function isMachineMail(headers: Record<string, string>): boolean {
  try {
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
    );
    if (lower['auto-submitted'] && lower['auto-submitted'] !== 'no') return true;
    if (lower['precedence'] === 'bulk' || lower['precedence'] === 'list') return true;
    if (Object.keys(lower).some((k) => k.startsWith('list-'))) return true;
    if (lower['return-path'] === '<>' || lower['return-path'] === '') return true;
    if (lower['subject'] && OOO_PATTERN.test(lower['subject'])) return true;
    if (lower['from'] && MACHINE_SENDER_PATTERN.test(lower['from'])) return true;
    if (lower['subject'] && UNSUBSCRIBE_PATTERN.test(lower['subject'])) return true;
    return false;
  } catch {
    return false;
  }
}

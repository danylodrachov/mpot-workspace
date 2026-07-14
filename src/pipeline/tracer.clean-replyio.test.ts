/**
 * Black-box acceptance test for issue #09 — reply.io clean schema for agent reading.
 * Locked BEFORE the implementation (Ralph gate 1). Asserts external behaviour only:
 * raw reply.io blob -> cleanReplyio() -> cleaned thread record.
 *
 * Acceptance criteria (issue #09):
 *  1. Cleaned record carries lastActivityDate, sequence name, category name, full contact
 *     block — and contains NO raw key, no numeric contact/sequence ids, no bodyPreview.
 *  2. Donor record -> isOutbound: false; a daniel@marketing-pot.com record -> isOutbound: true.
 *  3. body has no googleusercontent URL and no unsubscribe footer, while a phrase from inside
 *     the quoted chain (the original outreach line) is still present.
 *  4. Existing gmail clean tests still pass with the extended schema (checked by full `npm run test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixDir = fileURLToPath(new URL('./__fixtures__/tracer', import.meta.url));

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixDir, name), 'utf8'));
}

test('tracer.clean-replyio: donor record carries lastActivityDate/sequence/category/contact; drops raw+numeric ids+bodyPreview; isOutbound false', async () => {
  const { cleanReplyio } = await import('./clean/replyio.ts');

  const donor = readFixture('okb-reply.raw.json');
  const cleaned = cleanReplyio(donor) as unknown as Record<string, unknown>;

  assert.equal(cleaned['lastActivityDate'], '2026-06-23T09:15:00Z', 'lastActivityDate carried from raw.lastActivityDate');
  assert.equal(cleaned['sequence'], 'Guest Post Outreach — Q3', 'sequence carries raw.sequence.name');
  assert.equal(cleaned['category'], 'Interested', 'category carries raw.category.name');
  assert.deepEqual(
    cleaned['contact'],
    {
      name: 'María González',
      email: 'maria.gonzalez@vidatechblog.com',
      company: 'VidaTech Blog',
      title: 'Editora',
    },
    'full contact block carried from raw.contact',
  );

  assert.equal('raw' in cleaned, false, 'no raw mirror key');

  const serialized = JSON.stringify(cleaned);
  assert.doesNotMatch(serialized, /bodyPreview/, 'no bodyPreview leak');
  assert.doesNotMatch(serialized, /5550199/, 'no numeric contact id leak');
  assert.doesNotMatch(serialized, /420042/, 'no numeric sequence id leak');
  assert.doesNotMatch(serialized, /700077/, 'no numeric category id leak');
  assert.doesNotMatch(serialized, /483253/, 'no ownerId leak');

  const messages = cleaned['messages'] as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1, 'one message');
  assert.equal(messages[0]['isOutbound'], false, 'donor (external sender) isOutbound false');

  const body = messages[0]['body'] as string;
  assert.match(body, /Daniel escribió|explorar una colaboración/, 'quoted/forwarded chain retained in donor body');
});

test('tracer.clean-replyio: own-domain sender (daniel@marketing-pot.com) derives isOutbound true — not hardcoded to the donor fixture', async () => {
  const { cleanReplyio } = await import('./clean/replyio.ts');

  const ownSender = {
    source: 'replyio',
    id: '9999001',
    subject: 'Re: Follow up — draft timeline',
    body: '<p>Sure, sending the draft over today.</p>',
    from: 'daniel@marketing-pot.com',
    date: '2026-06-25T10:00:00Z',
    email: 'daniel@marketing-pot.com',
    name: 'Daniel',
    company: 'Marketing Pot',
    raw: {
      id: 8888001,
      channel: 'email',
      isRead: true,
      subject: 'Re: Follow up — draft timeline',
      bodyPreview: 'Sure, sending the draft over today.',
      lastActivityDate: '2026-06-25T10:00:00Z',
      contact: {
        id: 7000700,
        ownerId: 483253,
        fullName: 'Daniel',
        email: 'daniel@marketing-pot.com',
        companyName: 'Marketing Pot',
        title: 'Partnership Manager',
      },
      sequence: { id: 9000900, name: '[RunMedia] Test Sequence' },
      category: { id: 8000800, name: 'Sent' },
      status: { state: 'ok' },
    },
  };

  const cleaned = cleanReplyio(ownSender) as unknown as Record<string, unknown>;
  const messages = cleaned['messages'] as Array<Record<string, unknown>>;

  assert.equal(messages[0]['isOutbound'], true, 'own-domain sender (marketing-pot.com) derives isOutbound true');
});

test('tracer.clean-replyio: strips tracking signature-image URL and unsubscribe footer while KEEPING the quoted/forwarded chain (real production-shaped record)', async () => {
  const { cleanReplyio } = await import('./clean/replyio.ts');

  // Modeled directly on data/2026-06-25/inputs/raw/replyio.json — a forward whose ONLY copy
  // of the original outreach line lives inside the quoted chain, plus a signature tracking
  // image and a trailing unsubscribe footer that must be scrubbed.
  const forwarded = {
    source: 'replyio',
    id: '396431314',
    subject: 'Fwd: Consulta de colaboración – Artículos patrocinados',
    body:
      '<div dir="ltr"><div>Hola Daniel&nbsp;</div><div><br></div><div>Te pongo en contacto con Diego de Joinnus.&nbsp;</div>' +
      '<div>Slds,&nbsp;</div><div><div dir="ltr" class="gmail_signature"><div dir="ltr">' +
      '<img src="https://ci3.googleusercontent.com/mail-sig/AIorK4xgXGGM_AJqFo8sJQ4LDB_UOcmOrxDtGIFiIPTM4Y6Zku1__M2-txM0kEFET0H0C5w8bXx3_XjZzLQb">' +
      '<br></div></div></div><br><br><div class="gmail_quote gmail_quote_container">' +
      '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>De: ' +
      '<strong class="gmail_sendername" dir="auto">Daniel</strong> <span dir="auto">&lt;' +
      '<a href="mailto:daniel@marketing-pot.com">daniel@marketing-pot.com</a>&gt;</span><br>' +
      'Date: mié, 24 jun 2026 a la(s) 11:47 a.m.<br>Subject: Consulta de colaboración – Artículos patrocinados<br>' +
      'To:  &lt;<a href="mailto:carolina@joinnus.com">carolina@joinnus.com</a>&gt;<br></div><br><br>' +
      'Hola Carolina, <br><br>Soy Daniel, Marketing Manager en Marketing Pot. <br><br>' +
      'Escribo para consultar si aceptan artículos como invitado en joinnus. ¿Podrían compartir el precio ' +
      'por publicación y los requisitos de publicación? <br><br>Gracias de antemano. Quedo a la espera de su respuesta. ' +
      '<br><br>Saludos,<div><br>Daniel D.<br><em>Partnership Manager&nbsp;</em><br>' +
      '<a href="http://marketingpot.co" target="_blank">marketingpot.co</a></div><div><br>' +
      '<p style="margin: 0">To discontinue receiving my messages, just respond with "unsubscribe."</p></div><div></div>\n</div></div>\n',
    from: 'carolina@joinnus.com',
    date: '2026-06-24T16:54:49.00',
    email: 'carolina@joinnus.com',
    name: 'Carolina Bar',
    company: 'joinnus',
    raw: {
      id: 396431314,
      channel: 'email',
      isRead: false,
      subject: ' Consulta de colaboración – Artículos patrocinados',
      bodyPreview: 'Hola Daniel Te pongo en contacto con Diego de Joinnus. Slds,\r\n-…',
      lastActivityDate: '2026-06-24T16:54:49.00',
      isLastMessagePlanned: false,
      contact: {
        id: 752480458,
        ownerId: 483253,
        fullName: 'Carolina Bar',
        email: 'carolina@joinnus.com',
        linkedInProfileUrl: null,
        phone: '',
        companyName: 'joinnus',
        title: '',
        isDeleted: false,
      },
      sequence: { id: 1716087, name: '[RunMedia] Latam 2026.06.23' },
      category: { id: 5, name: 'Forwarded' },
      hasMeetingIntent: false,
      status: { state: 'ok' },
    },
  };

  const cleaned = cleanReplyio(forwarded) as unknown as Record<string, unknown>;
  const messages = cleaned['messages'] as Array<Record<string, unknown>>;
  const body = messages[0]['body'] as string;

  assert.doesNotMatch(body, /googleusercontent/i, 'signature tracking image URL stripped');
  assert.doesNotMatch(body, /discontinue receiving|unsubscribe/i, 'unsubscribe footer stripped');
  assert.match(
    body,
    /Escribo para consultar si aceptan artículos como invitado/,
    'quoted original-outreach line retained — reply.io\'s only copy of conversation history',
  );
});

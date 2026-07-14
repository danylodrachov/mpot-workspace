/**
 * Telegram push — the Brain's outbound channel to the operator.
 *
 * The Brain is the only human-facing point; this is how it reaches the user
 * (Review Drafts, Approval Gate prompts, the Execution Report). Outbound only —
 * the bot accepts inbound updates ONLY from TELEGRAM_CHAT_ID (set in .env).
 *
 * Plain scripted code, no SDK dependency (native fetch to the Bot API).
 * CLI test: `npm run tg:push -- "hello from the AFK agent"`
 */
import 'dotenv/config';

export async function pushMessage(text: string): Promise<void> {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env');
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  if (!body.ok) {
    throw new Error(`Telegram sendMessage failed: ${body.description ?? res.statusText}`);
  }
}

// CLI entrypoint — only when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(' ') || 'AFK agent: Telegram push works ✅';
  pushMessage(text)
    .then(() => console.log('✓ Sent to operator chat'))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

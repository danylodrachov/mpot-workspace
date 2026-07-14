/**
 * Telegram approval gate — two-way (grammy).
 *
 * Sends the daily-plan to the operator chat with Approve / Reject inline buttons.
 * Blocks until the operator responds, then returns the result.
 * Also accepts /feedback <text> to reject with a reason.
 *
 * CLI: `npm run tg:gate -- path/to/data/<date>`
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';

export interface ApprovalResult {
  approved: boolean;
  feedback: string | null;
  timestamp: string;
}

const TELEGRAM_MAX_CHARS = 4096;

export async function awaitApproval(planText: string): Promise<ApprovalResult> {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env');
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  let settled: ApprovalResult | undefined;

  const isOperatorChat = (chatId: number | string | undefined) =>
    String(chatId) === TELEGRAM_CHAT_ID;

  bot.on('callback_query:data', async (ctx) => {
    const msgChatId = ctx.callbackQuery.message?.chat?.id;
    if (!isOperatorChat(msgChatId) || settled) return;

    settled = {
      approved: ctx.callbackQuery.data === 'approve',
      feedback: null,
      timestamp: new Date().toISOString(),
    };

    await ctx.answerCallbackQuery(settled.approved ? '✅ Approved' : '❌ Rejected');
    await ctx
      .editMessageText(
        `${ctx.callbackQuery.message?.text ?? ''}\n\n_${settled.approved ? '✅ Approved' : '❌ Rejected'}_`,
        { parse_mode: 'Markdown' },
      )
      .catch(() => {});
    bot.stop();
  });

  // /feedback <text> rejects with a reason
  bot.command('feedback', async (ctx) => {
    if (!isOperatorChat(ctx.chat?.id) || settled) return;
    settled = {
      approved: false,
      feedback: ctx.match || null,
      timestamp: new Date().toISOString(),
    };
    await ctx.reply('Feedback received — plan rejected.');
    bot.stop();
  });

  await bot.init();

  const truncated =
    planText.length > TELEGRAM_MAX_CHARS
      ? planText.slice(0, TELEGRAM_MAX_CHARS - 20) + '\n…(truncated)'
      : planText;

  const keyboard = new InlineKeyboard()
    .text('✅ Approve all', 'approve')
    .text('❌ Reject', 'reject');

  await bot.api.sendMessage(TELEGRAM_CHAT_ID, truncated, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });

  await bot.start();
  return settled!;
}

/** Reads daily-plan.md, calls awaitApproval, writes approval.json. Returns the result. */
export async function runGate(dayRoot: string): Promise<ApprovalResult> {
  const planPath = join(dayRoot, 'daily-plan.md');
  const planText = readFileSync(planPath, 'utf8');
  const result = await awaitApproval(planText);
  writeFileSync(join(dayRoot, 'approval.json'), JSON.stringify(result, null, 2));
  return result;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const dayRoot = process.argv[2];
  if (!dayRoot) {
    console.error('Usage: node src/telegram/gate.ts <path/to/data/<date>>');
    process.exit(1);
  }
  runGate(dayRoot)
    .then((r) => console.log(`Gate result: ${r.approved ? 'APPROVED' : 'REJECTED'}${r.feedback ? ` — ${r.feedback}` : ''}`))
    .catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
}

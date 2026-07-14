import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const _mod = _require('email-reply-parser') as { default: new () => { read(text: string): { getVisibleText(): string } } };
const EmailReplyParser = _mod.default;

const parser = new EmailReplyParser();

export function topPost(plain: string): string {
  if (!plain) return plain;
  try {
    const visible = parser.read(plain).getVisibleText().trim();
    return visible || plain;
  } catch (e) {
    console.warn(`topPost: parser failed — ${(e as Error).message}`);
    return `⚠ QUOTE-STRIP-FAILED: ${plain}`;
  }
}

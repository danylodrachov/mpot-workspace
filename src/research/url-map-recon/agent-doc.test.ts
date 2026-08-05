import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentPath = fileURLToPath(new URL('../../../.claude/agents/url-map-recon.md', import.meta.url));
const agentText = readFileSync(agentPath, 'utf8');

function frontmatter(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) throw new Error('no frontmatter found');
  return match[1];
}

test('url-map-recon frontmatter has no Read/snapshot/screenshot tools', () => {
  const fm = frontmatter(agentText);
  const toolsLine = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.ok(!/\bRead\b/.test(toolsLine), 'Read must be removed from tools');
  assert.ok(!/snapshot/i.test(toolsLine), 'snapshot tool must be absent');
  assert.ok(!/screenshot/i.test(toolsLine), 'screenshot tool must be absent');
});

test('url-map-recon has no product-title extraction language', () => {
  assert.ok(!/pull the \*\*titles\*\*/i.test(agentText));
  assert.ok(!/game\/table\/event names/i.test(agentText));
  assert.ok(!/product lists \(sports \/ live-casino \/ slots/i.test(agentText));
  assert.ok(/do \*\*not\*\* extract\s*\n?product titles/i.test(agentText), 'must explicitly disclaim product-title extraction');
});

test('recipe examples use extractorId and omit eval (13)', () => {
  assert.ok(agentText.includes('extractorId'));
  assert.ok(!/["']eval["']\s*:/.test(agentText));
  assert.ok(!/\beval\s*\(/.test(agentText));
});

test('return contract is URL-only — no visibleName from page content', () => {
  assert.ok(!agentText.includes('visibleName'));
  assert.ok(agentText.includes('derivedLabel'));
});

// (20) anonymous-first authentication behavior — static doc assertion
test('anonymous-first authentication language present, old must-be-logged-in language absent (20)', () => {
  assert.ok(!/must already be logged in/i.test(agentText));
  assert.ok(/anonymous/i.test(agentText));
});

test('agent never navigates to individual games/tables/matches/events', () => {
  assert.ok(/never navigate to individual/i.test(agentText));
});

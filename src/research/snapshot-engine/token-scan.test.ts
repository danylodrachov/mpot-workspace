import assert from 'node:assert/strict';
import test from 'node:test';
import { scanUrlTokens } from './token-scan.ts';

test('extracts absolute and root-relative URL tokens without returning source bodies', () => {
  const text = `const x = "https://example.com/deposit"; const y = '/casino/live-casino'; const z = "\\/terms-and-conditions";`;
  const tokens = scanUrlTokens(text);
  assert(tokens.includes('https://example.com/deposit'));
  assert(tokens.includes('/casino/live-casino'));
  assert(tokens.includes('/terms-and-conditions'));
});

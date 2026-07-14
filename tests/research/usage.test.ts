import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { createUsageWriter } from '../../src/research/usage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const testDir = path.join(projectRoot, 'tests/research/usage-tmp');

test('usage: createUsageWriter creates writer and records deterministic operations with 0 tokens', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const writer = createUsageWriter(testDir);

  writer.record({
    phase: 'collect',
    operation: 'navigate_to_page',
    worker: 'playwright',
    session: null,
    model: 'N/A',
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:00:00Z',
    finished_at: '2026-07-11T10:01:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'exact',
  });

  const summary = writer.summarize();

  assert(summary.exact, 'summary should have exact totals');
  assert.equal(summary.exact.input_tokens, 0, 'deterministic operation should count as 0 tokens');
  assert.equal(summary.exact.output_tokens, 0, 'deterministic operation should count as 0 tokens');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('usage: createUsageWriter records Claude calls with exact tokens when reported', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const writer = createUsageWriter(testDir);

  writer.record({
    phase: 'extract',
    operation: 'extract_category_fields',
    worker: 'extractor-haiku',
    session: 'session-123',
    model: 'claude-3-5-haiku-20241022',
    input_tokens: 1500,
    output_tokens: 500,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:02:00Z',
    finished_at: '2026-07-11T10:03:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'exact',
  });

  const summary = writer.summarize();

  assert(summary.exact, 'summary should have exact totals');
  assert.equal(summary.exact.input_tokens, 1500, 'should record input tokens');
  assert.equal(summary.exact.output_tokens, 500, 'should record output tokens');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('usage: createUsageWriter classifies partial tokens separately from exact', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const writer = createUsageWriter(testDir);

  // Exact usage
  writer.record({
    phase: 'extract',
    operation: 'op1',
    worker: 'extractor-haiku',
    session: 'session-1',
    model: 'claude-3-5-haiku-20241022',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:00:00Z',
    finished_at: '2026-07-11T10:01:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'exact',
  });

  // Partial usage (missing cache fields)
  writer.record({
    phase: 'extract',
    operation: 'op2',
    worker: 'extractor-haiku',
    session: 'session-2',
    model: 'claude-3-5-haiku-20241022',
    input_tokens: 2000,
    output_tokens: null, // Partial
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:01:00Z',
    finished_at: '2026-07-11T10:02:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'partial',
  });

  const summary = writer.summarize();

  assert(summary.exact, 'should have exact totals');
  assert.equal(summary.exact.input_tokens, 1000, 'exact should only include exact ops');
  assert(summary.partial, 'should have partial totals');
  assert.equal(summary.partial.input_tokens, 2000, 'partial should include partial ops');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('usage: createUsageWriter totals exclude estimated from exact sums', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const writer = createUsageWriter(testDir);

  // Exact
  writer.record({
    phase: 'extract',
    operation: 'op1',
    worker: 'extractor-haiku',
    session: 'session-1',
    model: 'claude-3-5-haiku-20241022',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:00:00Z',
    finished_at: '2026-07-11T10:01:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'exact',
  });

  // Estimated
  writer.record({
    phase: 'extract',
    operation: 'op2',
    worker: 'extractor-haiku',
    session: 'session-2',
    model: 'claude-3-5-haiku-20241022',
    input_tokens: 5000,
    output_tokens: 2000,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:01:00Z',
    finished_at: '2026-07-11T10:02:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'estimated',
  });

  const summary = writer.summarize();

  assert(summary.exact, 'should have exact');
  assert.equal(summary.exact.input_tokens, 1000, 'exact should NOT include estimated');
  assert(summary.estimated, 'should have estimated');
  assert.equal(summary.estimated.input_tokens, 5000, 'estimated should include estimated ops');

  // Clean up
  rmSync(testDir, { recursive: true });
});

test('usage: createUsageWriter records unavailable classification', () => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });

  const writer = createUsageWriter(testDir);

  // Unavailable (no token data at all)
  writer.record({
    phase: 'resolve',
    operation: 'resolve_field',
    worker: 'extractor-haiku',
    session: null,
    model: 'claude-3-5-haiku-20241022',
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    started_at: '2026-07-11T10:00:00Z',
    finished_at: '2026-07-11T10:01:00Z',
    retry: 0,
    status: 'success',
    usage_source: 'unavailable',
  });

  const summary = writer.summarize();

  assert(summary.unavailable, 'should have unavailable classification');

  // Clean up
  rmSync(testDir, { recursive: true });
});

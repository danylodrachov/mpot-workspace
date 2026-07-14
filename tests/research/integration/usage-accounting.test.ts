import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createUsageWriter } from '../../../src/research/usage.ts';
import type { UsageRecord } from '../../../src/research/types.ts';

test('integration: usage accounting with exact/partial/estimated separation', () => {
  // Create temporary run directory for usage file
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));

  try {
    const runId = 'usage-test-001';
    const usageWriter = createUsageWriter(tempDir);

    // Record mixed operation types
    const now = new Date().toISOString();

    // Type 1: Exact operation (Playwright, deterministic)
    usageWriter.record({
      phase: 'collect',
      operation: 'capture_dom',
      worker: 'playwright',
      session: null,
      model: 'n/a',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // Type 2: Exact operation (Claude call with full token reporting)
    usageWriter.record({
      phase: 'extract',
      operation: 'extract_casino_info',
      worker: 'extractor-haiku',
      session: 'session-001',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 500,
      output_tokens: 150,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 2000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // Type 3: Partial operation (partial token reporting, e.g., cache not included)
    usageWriter.record({
      phase: 'extract',
      operation: 'extract_bonuses',
      worker: 'extractor-haiku',
      session: 'session-002',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 400,
      output_tokens: 100,
      cache_read_tokens: null, // Partial — cache not reported
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1500).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'partial',
    });

    // Type 4: Estimated operation (unavailable token reporting)
    usageWriter.record({
      phase: 'collect',
      operation: 'navigate_page',
      worker: 'playwright',
      session: null,
      model: 'n/a',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 3000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'estimated',
    });

    // Type 5: Unavailable operation (no token data)
    usageWriter.record({
      phase: 'resolve',
      operation: 'merge_results',
      worker: 'merger',
      session: null,
      model: 'n/a',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 500).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'unavailable',
    });

    // Get summary
    const summary = usageWriter.summarize();

    // Verify exact operations
    assert.equal(summary.exact.input_tokens, 500, 'exact input tokens only from exact sources');
    assert.equal(summary.exact.output_tokens, 150, 'exact output tokens only from exact sources');

    // Verify partial operations counted separately
    assert.equal(summary.partial.input_tokens, 400, 'partial input tokens separated');
    assert.equal(summary.partial.output_tokens, 100, 'partial output tokens separated');

    // Verify estimated tracked separately (no tokens)
    assert.equal(summary.estimated.input_tokens, 0, 'estimated has no tokens');
    assert.equal(summary.estimated.output_tokens, 0, 'estimated has no tokens');

    // Verify unavailable tracked (no tokens)
    assert.equal(summary.unavailable.input_tokens, 0, 'unavailable has no tokens');
    assert.equal(summary.unavailable.output_tokens, 0, 'unavailable has no tokens');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

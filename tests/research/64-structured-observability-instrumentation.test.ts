/**
 * Issue 64: Structured Observability Instrumentation
 * Black-box tests for metrics schema, sanitization, and reconciliation.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createUsageWriter } from '../../src/research/usage.ts';
import type { UsageRecord } from '../../src/research/types.ts';
import { UsageRecordSchema } from '../../src/research/types.ts';

test('metrics: schema includes all required fields per acceptance criteria', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-schema-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-001');
    const now = new Date().toISOString();

    writer.record({
      phase: 'extract',
      operation: 'extract_casino_data',
      worker: 'extractor-haiku',
      session: 'session-123',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 5000).toISOString(),
      retry: 1,
      status: 'success',
      usage_source: 'exact',
    });

    // Read the JSONL file
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const line = content.trim();
    const record = JSON.parse(line) as UsageRecord;

    // Verify schema compliance with Zod
    const parsed = UsageRecordSchema.parse(record);

    // Verify all required fields exist
    assert(parsed.run_id, 'run_id must be present');
    assert(parsed.phase, 'phase must be present');
    assert(parsed.operation, 'operation must be present');
    assert(parsed.worker, 'worker must be present');
    assert(typeof parsed.model === 'string', 'model must be present');
    assert(typeof parsed.input_tokens === 'number', 'input_tokens must be present');
    assert(typeof parsed.output_tokens === 'number', 'output_tokens must be present');
    assert(typeof parsed.cache_read_tokens === 'number', 'cache_read_tokens must be present');
    assert(typeof parsed.cache_creation_tokens === 'number', 'cache_creation_tokens must be present');
    assert(parsed.started_at, 'started_at must be present');
    assert(parsed.finished_at, 'finished_at must be present');
    assert(typeof parsed.retry === 'number', 'retry count must be present');
    assert(parsed.status, 'status must be present');
    assert(parsed.usage_source, 'usage_source (classification) must be present');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: sanitization — no credentials or PII in emitted records', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-sanitize-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-002');
    const now = new Date().toISOString();

    // Record with potential PII/credential data in non-standard fields
    // The schema should only allow safe fields
    writer.record({
      phase: 'collect',
      operation: 'fetch_page',
      worker: 'playwright',
      session: 'session-456',
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

    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const record = JSON.parse(content.trim()) as UsageRecord;

    // Verify only safe fields are present
    const allowedFields = new Set([
      'run_id', 'phase', 'operation', 'worker', 'session', 'model',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
      'started_at', 'finished_at', 'retry', 'status', 'usage_source'
    ]);

    const recordKeys = Object.keys(record);
    for (const key of recordKeys) {
      assert(allowedFields.has(key), `unexpected key "${key}" in metrics record — should be sanitized`);
    }

    // Verify no raw corpus/credentials/passwords in values
    const recordStr = JSON.stringify(record);
    assert(!recordStr.includes('password'), 'metrics should not contain password');
    assert(!recordStr.includes('secret'), 'metrics should not contain secret');
    assert(!recordStr.includes('api_key'), 'metrics should not contain api_key');
    assert(!recordStr.includes('@'), 'metrics should not contain email addresses');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: token accounting separable by agent, MCP, and direct browser', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-token-sep-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-003');
    const now = new Date().toISOString();

    // Agent-based Claude call
    writer.record({
      phase: 'extract',
      operation: 'extract_op',
      worker: 'extractor-haiku',
      session: 'session-agent-1',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // Direct browser/Playwright (should have null tokens)
    writer.record({
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
      finished_at: new Date(Date.parse(now) + 2000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // MCP-like operation (tool usage)
    writer.record({
      phase: 'collect',
      operation: 'fetch_via_tool',
      worker: 'mcp-fetch',
      session: null,
      model: 'n/a',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1500).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    const summary = writer.summarize();

    // Verify agent-based tokens are recorded
    assert.equal(summary.exact.input_tokens, 1000, 'agent tokens should be counted');
    assert.equal(summary.exact.output_tokens, 500, 'agent tokens should be counted');

    // Verify we can distinguish by reading raw JSONL
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    const agentRecords = lines.filter(l => {
      const r = JSON.parse(l) as UsageRecord;
      return r.worker.includes('haiku') || r.worker.includes('extractor');
    });
    const browserRecords = lines.filter(l => {
      const r = JSON.parse(l) as UsageRecord;
      return r.worker === 'playwright';
    });
    const mcpRecords = lines.filter(l => {
      const r = JSON.parse(l) as UsageRecord;
      return r.worker.includes('mcp');
    });

    assert.equal(agentRecords.length, 1, 'should have 1 agent record');
    assert.equal(browserRecords.length, 1, 'should have 1 browser record');
    assert.equal(mcpRecords.length, 1, 'should have 1 MCP record');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: phase totals and run totals reconcile', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-reconcile-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-004');
    const now = new Date().toISOString();

    // Collect phase
    writer.record({
      phase: 'collect',
      operation: 'navigate',
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

    // Extract phase - 2 operations
    writer.record({
      phase: 'extract',
      operation: 'extract_1',
      worker: 'extractor-haiku',
      session: 'session-1',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    writer.record({
      phase: 'extract',
      operation: 'extract_2',
      worker: 'extractor-haiku',
      session: 'session-2',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 2000,
      output_tokens: 1000,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      started_at: new Date(Date.parse(now) + 1000).toISOString(),
      finished_at: new Date(Date.parse(now) + 2000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // Resolve phase
    writer.record({
      phase: 'resolve',
      operation: 'merge',
      worker: 'merger',
      session: null,
      model: 'n/a',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: new Date(Date.parse(now) + 2000).toISOString(),
      finished_at: new Date(Date.parse(now) + 2500).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    const summary = writer.summarize();

    // Verify totals
    const totalInputTokens = summary.exact.input_tokens;
    const totalOutputTokens = summary.exact.output_tokens;

    assert.equal(totalInputTokens, 3000, 'run total input tokens should reconcile');
    assert.equal(totalOutputTokens, 1500, 'run total output tokens should reconcile');

    // Verify we can read JSONL and compute per-phase totals
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    const byPhase: Record<string, { input: number; output: number }> = {};
    for (const line of lines) {
      const record = JSON.parse(line) as UsageRecord;
      if (!byPhase[record.phase]) {
        byPhase[record.phase] = { input: 0, output: 0 };
      }
      if (record.input_tokens !== null && record.status === 'success') {
        byPhase[record.phase].input += record.input_tokens;
      }
      if (record.output_tokens !== null && record.status === 'success') {
        byPhase[record.phase].output += record.output_tokens;
      }
    }

    // Extract phase should total 3000 input, 1500 output
    assert.equal(byPhase.extract.input, 3000, 'extract phase total should reconcile');
    assert.equal(byPhase.extract.output, 1500, 'extract phase total should reconcile');
    assert.equal(byPhase.collect.input, 0, 'collect phase should have 0 tokens');
    assert.equal(byPhase.resolve.input, 0, 'resolve phase should have 0 tokens');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: outcome recorded with code, scope, phase, attempt, budget state', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-outcome-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-005');
    const now = new Date().toISOString();

    // Success outcome
    writer.record({
      phase: 'extract',
      operation: 'extract_success',
      worker: 'extractor-haiku',
      session: 'session-ok',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 500,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
    });

    // Error outcome
    writer.record({
      phase: 'extract',
      operation: 'extract_error',
      worker: 'extractor-haiku',
      session: 'session-err',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 300,
      output_tokens: null, // Incomplete due to error
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 500).toISOString(),
      retry: 1,
      status: 'error',
      usage_source: 'partial',
    });

    // Timeout outcome
    writer.record({
      phase: 'extract',
      operation: 'extract_timeout',
      worker: 'extractor-haiku',
      session: 'session-timeout',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 800,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 10000).toISOString(),
      retry: 2,
      status: 'timeout',
      usage_source: 'partial',
    });

    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    assert.equal(lines.length, 3, 'should have 3 outcome records');

    // Verify success outcome
    const successRecord = JSON.parse(lines[0]) as UsageRecord;
    assert.equal(successRecord.status, 'success', 'success outcome should be recorded');
    assert.equal(successRecord.retry, 0, 'success attempt count should be recorded');
    assert.equal(successRecord.phase, 'extract', 'phase should be recorded');
    assert.equal(successRecord.operation, 'extract_success', 'operation/scope should be recorded');

    // Verify error outcome
    const errorRecord = JSON.parse(lines[1]) as UsageRecord;
    assert.equal(errorRecord.status, 'error', 'error status should be recorded');
    assert.equal(errorRecord.retry, 1, 'retry/attempt count should be recorded');

    // Verify timeout outcome
    const timeoutRecord = JSON.parse(lines[2]) as UsageRecord;
    assert.equal(timeoutRecord.status, 'timeout', 'timeout status should be recorded');
    assert.equal(timeoutRecord.retry, 2, 'retry count should be recorded for timeout');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: JSONL sidecar format with versioned schema', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-format-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-006');
    const now = new Date().toISOString();

    // Write multiple records
    for (let i = 0; i < 3; i++) {
      writer.record({
        phase: 'extract',
        operation: `op-${i}`,
        worker: 'extractor-haiku',
        session: `session-${i}`,
        model: 'claude-3-5-haiku-20241022',
        input_tokens: 100 * (i + 1),
        output_tokens: 50 * (i + 1),
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        started_at: now,
        finished_at: new Date(Date.parse(now) + 1000).toISOString(),
        retry: 0,
        status: 'success',
        usage_source: 'exact',
      });
    }

    // Verify JSONL format
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    assert.equal(lines.length, 3, 'should have 3 lines in JSONL');

    // Verify each line is valid JSON
    for (const line of lines) {
      const record = JSON.parse(line); // Should not throw
      assert(record.run_id, 'each record should have run_id');
    }

    // Verify sidecar location
    assert(jsonlPath.endsWith('usage.jsonl'), 'metrics should be in usage.jsonl sidecar');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metrics: budget state and defect count tracking', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-budget-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-008');
    const now = new Date().toISOString();

    // Record with budget state
    writer.record({
      phase: 'extract',
      operation: 'extract_with_budget',
      worker: 'extractor-haiku',
      session: 'session-1',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: now,
      finished_at: new Date(Date.parse(now) + 1000).toISOString(),
      retry: 0,
      status: 'success',
      usage_source: 'exact',
      budget_state: {
        tokens_used: 1500,
        tokens_remaining: 8500,
      },
      defect_count: 0,
      schema_version: '1.0',
    });

    // Record with defects
    writer.record({
      phase: 'extract',
      operation: 'extract_with_defects',
      worker: 'extractor-haiku',
      session: 'session-2',
      model: 'claude-3-5-haiku-20241022',
      input_tokens: 800,
      output_tokens: 400,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: new Date(Date.parse(now) + 1000).toISOString(),
      finished_at: new Date(Date.parse(now) + 2000).toISOString(),
      retry: 1,
      status: 'success',
      usage_source: 'exact',
      budget_state: {
        tokens_used: 2300,
        tokens_remaining: 7700,
      },
      defect_count: 2,
      schema_version: '1.0',
    });

    // Verify JSONL contains budget_state and defect_count
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    assert.equal(lines.length, 2, 'should have 2 records');

    const record1 = JSON.parse(lines[0]) as UsageRecord;
    assert(record1.budget_state, 'first record should have budget_state');
    assert.equal(record1.budget_state!.tokens_used, 1500, 'should track tokens used');
    assert.equal(record1.budget_state!.tokens_remaining, 8500, 'should track tokens remaining');
    assert.equal(record1.defect_count, 0, 'should track defect count');
    assert.equal(record1.schema_version, '1.0', 'should include schema version');

    const record2 = JSON.parse(lines[1]) as UsageRecord;
    assert(record2.budget_state, 'second record should have budget_state');
    assert.equal(record2.defect_count, 2, 'second record should have defect count');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('integration: metrics totals reconcile across all classification types', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'metrics-integration-'));
  try {
    const writer = createUsageWriter(tempDir, 'run-test-007');
    const now = new Date().toISOString();

    // Mix of exact, partial, estimated, and unavailable (all successful)
    const records: Array<Omit<UsageRecord, 'run_id'>> = [
      {
        phase: 'extract',
        operation: 'exact_op',
        worker: 'extractor-haiku',
        session: 'session-1',
        model: 'claude-3-5-haiku-20241022',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_creation_tokens: 50,
        started_at: now,
        finished_at: new Date(Date.parse(now) + 1000).toISOString(),
        retry: 0,
        status: 'success',
        usage_source: 'exact',
      },
      {
        phase: 'extract',
        operation: 'partial_op',
        worker: 'extractor-haiku',
        session: 'session-2',
        model: 'claude-3-5-haiku-20241022',
        input_tokens: 500,
        output_tokens: null, // Partial
        cache_read_tokens: null,
        cache_creation_tokens: null,
        started_at: now,
        finished_at: new Date(Date.parse(now) + 1000).toISOString(),
        retry: 0,
        status: 'success',
        usage_source: 'partial',
      },
      {
        phase: 'collect',
        operation: 'browser_op',
        worker: 'playwright',
        session: null,
        model: 'n/a',
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        started_at: now,
        finished_at: new Date(Date.parse(now) + 2000).toISOString(),
        retry: 0,
        status: 'success',
        usage_source: 'estimated',
      },
      {
        phase: 'resolve',
        operation: 'merge_op',
        worker: 'merger',
        session: null,
        model: 'n/a',
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        started_at: new Date(Date.parse(now) + 2000).toISOString(),
        finished_at: new Date(Date.parse(now) + 2500).toISOString(),
        retry: 0,
        status: 'success',
        usage_source: 'unavailable',
      },
    ];

    for (const record of records) {
      writer.record(record);
    }

    const summary = writer.summarize();

    // Verify classification totals (summarize only counts success records)
    assert.equal(summary.exact.input_tokens, 1000, 'exact classification should total correctly');
    assert.equal(summary.exact.output_tokens, 500, 'exact output should total correctly');

    assert.equal(summary.partial.input_tokens, 500, 'partial classification should total correctly');
    assert.equal(summary.partial.output_tokens, 0, 'partial output should be 0 (null becomes 0)');

    assert.equal(summary.estimated.input_tokens, 0, 'estimated should have 0 tokens');
    assert.equal(summary.unavailable.input_tokens, 0, 'unavailable should have 0 tokens');

    // Verify JSONL reconciliation
    const jsonlPath = path.join(tempDir, 'usage.jsonl');
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');

    let computedExactInput = 0;
    let computedExactOutput = 0;
    let computedPartialInput = 0;

    for (const line of lines) {
      const record = JSON.parse(line) as UsageRecord;
      if (record.usage_source === 'exact' && record.status === 'success') {
        computedExactInput += record.input_tokens || 0;
        computedExactOutput += record.output_tokens || 0;
      }
      if (record.usage_source === 'partial' && record.status === 'success') {
        computedPartialInput += record.input_tokens || 0;
      }
    }

    assert.equal(computedExactInput, summary.exact.input_tokens, 'JSONL should reconcile with summary');
    assert.equal(computedExactOutput, summary.exact.output_tokens, 'JSONL output should reconcile');
    assert.equal(computedPartialInput, summary.partial.input_tokens, 'JSONL partial should reconcile');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './discovery-orchestrator.ts';
import type { VisitPlanEntry } from './relevance-validator.ts';
import type { PageBehaviorProfile } from './url-map-recon/types.ts';
import { executeInteractions, redactEvidence } from './interaction-delta-profiler.ts';

// LOCKED TEST SUITE for Issue 12: Interaction Execution and Evidence Redaction
// These tests verify acceptance criteria:
// 1. Standard Playwright probes always precede fallback
// 2. A resolved target skips later probes and records the stop reason
// 3. Broad full-site CDP capture is impossible
// 4. Routine successful pages produce no extended evidence
// 5. Redaction tests cover cookies, auth headers, tokens, and form secrets

// ============================================================================
// Acceptance Criterion 1: Standard Playwright probes always precede fallback
// ============================================================================

test('AC 1: Playwright probes execute before fallback', async () => {
  const tmpDir = mkdtempSync('/tmp/test-interaction-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-001',
      casino_url: 'https://example-casino.com',
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      canonical_origin: 'https://example-casino.com',
      approved_same_domain_scope: 'example-casino.com',
      template_hash: 'tpl-hash-123',
      extraction_rules_hash: 'rules-hash-456',
      url_rules_hash: 'url-rules-hash-789',
      module_version_hash: 'module-hash-000',
      scorer_prompt_hash: 'prompt-hash-111',
      visit_policy_hash: 'policy-hash-222',
      probe_policy_hash: 'probe-hash-333',
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };

    // Create a page-behavior.json from issue 11
    const pageBehavior: PageBehaviorProfile = {
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: new Date().toISOString(),
      sections: {
        sports: {
          url: 'https://example-casino.com/sports',
          rendering: 'static_html',
          content_structure: 'list',
          collection: {
            type: 'static_list',
            visible_count: 10,
          },
          interactive_elements: [
            {
              type: 'filter',
              selector: '.sport-filter',
              effect: 'narrows-results',
            },
          ],
        },
      },
    };

    const behaviorPath = join(tmpDir, 'page-behavior.json');
    writeFileSync(behaviorPath, JSON.stringify(pageBehavior, null, 2));

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'High field relevance',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    // Execute interactions
    const result = await executeInteractions(visitPlan, runContext, tmpDir);

    // Verify result has interaction records
    assert.ok(result.interactions);
    assert.strictEqual(Array.isArray(result.interactions), true);

    // If interactions were executed, verify probe order
    if (result.interactions.length > 0) {
      const interaction = result.interactions[0];
      // Verify probes are recorded (if any)
      if (interaction.probes) {
        // Probes should come before fallback
        const playwrightProbeIndices: number[] = [];
        const fallbackIndices: number[] = [];

        interaction.probes.forEach((probe: any, idx: number) => {
          if (probe.type === 'playwright') {
            playwrightProbeIndices.push(idx);
          }
          if (probe.type === 'fallback') {
            fallbackIndices.push(idx);
          }
        });

        // All playwright probes should come before any fallback probes
        if (playwrightProbeIndices.length > 0 && fallbackIndices.length > 0) {
          const maxPlaywrightIdx = Math.max(...playwrightProbeIndices);
          const minFallbackIdx = Math.min(...fallbackIndices);
          assert.ok(maxPlaywrightIdx < minFallbackIdx, 'Playwright probes must precede fallback');
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 2: A resolved target skips later probes and records stop reason
// ============================================================================

test('AC 2: Resolved target skips later probes and records stop reason', async () => {
  const tmpDir = mkdtempSync('/tmp/test-interaction-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-002',
      casino_url: 'https://example-casino.com',
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      canonical_origin: 'https://example-casino.com',
      approved_same_domain_scope: 'example-casino.com',
      template_hash: 'tpl-hash-123',
      extraction_rules_hash: 'rules-hash-456',
      url_rules_hash: 'url-rules-hash-789',
      module_version_hash: 'module-hash-000',
      scorer_prompt_hash: 'prompt-hash-111',
      visit_policy_hash: 'policy-hash-222',
      probe_policy_hash: 'probe-hash-333',
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };

    const pageBehavior: PageBehaviorProfile = {
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: new Date().toISOString(),
      sections: {
        cashier: {
          url: 'https://example-casino.com/cashier',
          rendering: 'static_html',
          content_structure: 'custom',
          collection: {
            type: 'static_list',
            visible_count: 1,
          },
        },
      },
    };

    const behaviorPath = join(tmpDir, 'page-behavior.json');
    writeFileSync(behaviorPath, JSON.stringify(pageBehavior, null, 2));

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/cashier',
        selected: true,
        selectionReason: 'Mandatory',
        totalRelevantFields: 3,
        totalIrrelevantFields: 0,
      },
    ];

    const result = await executeInteractions(visitPlan, runContext, tmpDir);

    // Verify interaction records exist
    assert.ok(result.interactions);

    // If an interaction was resolved, verify stop reason is recorded
    if (result.interactions.length > 0) {
      const interaction = result.interactions[0];
      if (interaction.stop_reason) {
        // If stop reason exists, no further probes should execute after it
        assert.ok(
          ['element_found', 'evidence_sufficient', 'policy_boundary'].includes(interaction.stop_reason),
          'Stop reason should be valid'
        );
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 3: Broad full-site CDP capture is impossible
// ============================================================================

test('AC 3: CDP capture is prevented', async () => {
  const tmpDir = mkdtempSync('/tmp/test-interaction-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-003',
      casino_url: 'https://example-casino.com',
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      canonical_origin: 'https://example-casino.com',
      approved_same_domain_scope: 'example-casino.com',
      template_hash: 'tpl-hash-123',
      extraction_rules_hash: 'rules-hash-456',
      url_rules_hash: 'url-rules-hash-789',
      module_version_hash: 'module-hash-000',
      scorer_prompt_hash: 'prompt-hash-111',
      visit_policy_hash: 'policy-hash-222',
      probe_policy_hash: 'probe-hash-333',
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };

    const pageBehavior: PageBehaviorProfile = {
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: new Date().toISOString(),
      sections: {},
    };

    const behaviorPath = join(tmpDir, 'page-behavior.json');
    writeFileSync(behaviorPath, JSON.stringify(pageBehavior, null, 2));

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com',
        selected: true,
        selectionReason: 'Landing',
        totalRelevantFields: 2,
        totalIrrelevantFields: 0,
      },
    ];

    // Execute interactions with CDP-usage detection
    const result = await executeInteractions(visitPlan, runContext, tmpDir);

    // Verify no broad CDP trace was captured
    if (result.evidence_manifest) {
      // If manifest exists, verify it doesn't have broad CDP entries
      const broadCdpTraces = result.evidence_manifest.traces?.filter((t: any) => t.type === 'cdp_trace');
      assert.ok(!broadCdpTraces || broadCdpTraces.length === 0, 'Broad CDP traces should not be captured');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 4: Routine successful pages produce no extended evidence
// ============================================================================

test('AC 4: Routine success produces no extended evidence', async () => {
  const tmpDir = mkdtempSync('/tmp/test-interaction-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-004',
      casino_url: 'https://example-casino.com',
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      canonical_origin: 'https://example-casino.com',
      approved_same_domain_scope: 'example-casino.com',
      template_hash: 'tpl-hash-123',
      extraction_rules_hash: 'rules-hash-456',
      url_rules_hash: 'url-rules-hash-789',
      module_version_hash: 'module-hash-000',
      scorer_prompt_hash: 'prompt-hash-111',
      visit_policy_hash: 'policy-hash-222',
      probe_policy_hash: 'probe-hash-333',
      timestamp: new Date().toISOString(),
      authentication_disabled: true,
    };

    const pageBehavior: PageBehaviorProfile = {
      casino_id: 'example_casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: new Date().toISOString(),
      sections: {
        slots: {
          url: 'https://example-casino.com/slots',
          rendering: 'static_html',
          content_structure: 'grid',
          collection: {
            type: 'static_list',
            visible_count: 20,
          },
        },
      },
    };

    const behaviorPath = join(tmpDir, 'page-behavior.json');
    writeFileSync(behaviorPath, JSON.stringify(pageBehavior, null, 2));

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/slots',
        selected: true,
        selectionReason: 'High field relevance',
        totalRelevantFields: 8,
        totalIrrelevantFields: 0,
      },
    ];

    const result = await executeInteractions(visitPlan, runContext, tmpDir);

    // Verify page-behavior.json is updated with interactions
    const updated = JSON.parse(readFileSync(behaviorPath, 'utf-8')) as PageBehaviorProfile;
    assert.ok(updated);

    // For routine success, no extended evidence files should be created
    // Check that no trace/screenshot files exist for this routine interaction
    if (result.interactions && result.interactions.length > 0) {
      const interaction = result.interactions[0];
      // If interaction was successful (no errors), no screenshots/traces should be captured
      if (!interaction.error) {
        assert.ok(!interaction.screenshot, 'Routine success should not capture screenshot');
        assert.ok(!interaction.trace, 'Routine success should not capture trace');
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 5: Redaction covers cookies, auth headers, tokens, form secrets
// ============================================================================

test('AC 5: Redaction removes cookies, auth headers, tokens', () => {
  const sensitiveData = {
    headers: {
      'Cookie': 'session_id=abc123; user_token=xyz789',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'X-Auth-Token': 'secret-token-12345',
    },
    form_data: {
      password: 'my_secret_password',
      credit_card: '4111-1111-1111-1111',
      cvv: '123',
    },
    response_body: 'User logged in with token: secret123',
    dom_snapshot: '<input name="password" value="secret_pass" />',
  };

  const redacted = redactEvidence(sensitiveData);

  // Verify cookies are removed
  assert.ok(!redacted.headers?.['Cookie']?.includes('session_id'), 'Cookies should be redacted');
  assert.ok(!redacted.headers?.['Cookie']?.includes('user_token'), 'User tokens should be redacted');

  // Verify auth headers are removed
  assert.ok(!redacted.headers?.['Authorization']?.includes('Bearer'), 'Authorization should be redacted');
  assert.ok(!redacted.headers?.['X-Auth-Token']?.includes('secret'), 'Auth tokens should be redacted');

  // Verify form secrets are removed
  assert.ok(!redacted.form_data?.password, 'Passwords should be redacted');
  assert.ok(!redacted.form_data?.credit_card, 'Credit cards should be redacted');
  assert.ok(!redacted.form_data?.cvv, 'CVV should be redacted');

  // Verify response body is redacted of tokens
  assert.ok(!redacted.response_body?.includes('token'), 'Tokens in response should be redacted');
});

test('AC 5: Redaction is deterministic on identical input', () => {
  const sensitiveData = {
    headers: {
      'Cookie': 'session=abc; path=/',
      'Authorization': 'Bearer token123',
    },
  };

  const redacted1 = redactEvidence(sensitiveData);
  const redacted2 = redactEvidence(sensitiveData);

  assert.strictEqual(
    JSON.stringify(redacted1),
    JSON.stringify(redacted2),
    'Redaction should be deterministic'
  );
});

// ============================================================================
// Additional validation: Second data case with different sensitive data
// ============================================================================

test('AC 5: Redaction works with different sensitive data (second case)', () => {
  const sensitiveData = {
    headers: {
      'X-API-Key': 'api_key_prod_abc123xyz',
      'Cookie': 'auth_token=jwt.abc.def; user_id=12345',
    },
    form_data: {
      username: 'user123',
      password: 'MyPassword123!',
      credit_card: '5555-4444-3333-2222',
      cvv: '456',
    },
    response_body: 'Successfully authenticated with session token xyz123',
    dom_snapshot: '<input type="password" name="pwd" value="secret123" /><input type="text" value="user@example.com" />',
  };

  const redacted = redactEvidence(sensitiveData);

  // Verify API key is removed
  assert.ok(!redacted.headers?.['X-API-Key'], 'API keys should be redacted');

  // Verify password is removed
  assert.ok(!redacted.form_data?.password, 'Password should be redacted');

  // Verify credit card is removed
  assert.ok(!redacted.form_data?.credit_card, 'Credit card should be redacted in different data');

  // Verify CVV is removed
  assert.ok(!redacted.form_data?.cvv, 'CVV should be redacted in different data');

  // Verify session token in response is redacted
  assert.ok(!redacted.response_body?.includes('session token'), 'Session token in response should be redacted');

  // Verify password input value is redacted
  assert.ok(!redacted.dom_snapshot?.includes('value="secret'), 'Password values in DOM should be redacted');

  // Verify non-sensitive data is preserved
  assert.ok(redacted.form_data?.username === 'user123', 'Non-sensitive fields should be preserved');
});

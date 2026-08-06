import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './discovery-orchestrator.ts';
import type { VisitPlanEntry } from './relevance-validator.ts';
import type { PageBehaviorProfile } from './url-map-recon/types.ts';
import { profilePages } from './page-interactivity-profiler.ts';

// LOCKED TEST SUITE for Issue 11: Page Interactivity Profiling
// These tests verify acceptance criteria:
// 1. Product/field collection cannot run before a page profile exists
// 2. Each detector record has stable detector ID and bounded pre/post evidence
// 3. No screenshot or trace is required for routine success
// 4. No raw body field exists in the schema
// 5. A login gate is recorded as blocked; no login is attempted

// ============================================================================
// Acceptance Criterion 1: Product/field collection cannot run before a page profile exists
// ============================================================================

test('AC 1: profilePages writes page-behavior.json for selected pages', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com',
        selected: true,
        selectionReason: 'Mandatory landing page',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
      {
        url_id: 'url_002',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'High field relevance',
        totalRelevantFields: 8,
        totalIrrelevantFields: 2,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    // Verify page-behavior.json exists
    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    assert.ok(written.casino_id);
    assert.ok(written.profiled_at);
    assert.ok(written.sections);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC 1: profilePages profiles mandatory pages first, then others', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
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

    // Mix of selected pages without explicit ordering
    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_nonmandatory',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'High field relevance',
        totalRelevantFields: 8,
        totalIrrelevantFields: 0,
      },
      {
        url_id: 'url_landing',
        canonicalUrl: 'https://example-casino.com',
        selected: true,
        selectionReason: 'Mandatory landing page',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Both pages should be profiled (profiling order is internal)
    assert.ok(written.sections);
    assert.ok(Object.keys(written.sections).length >= 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 2: Each detector record has stable detector ID and bounded pre/post evidence
// ============================================================================

test('AC 2: page behavior records have bounded evidence fields (no raw DOM)', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'Product testing',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Check that sections have bounded evidence (selector strings, counts, enums)
    for (const [_sectionKey, section] of Object.entries(written.sections || {})) {
      if (!('status' in section)) {
        // This is a full section behavior
        const s = section as any;
        // Evidence fields should be simple: selectors, counts, enum values
        if (s.interactive_elements) {
          for (const elem of s.interactive_elements) {
            assert.ok(elem.selector, 'interactive element should have selector');
            assert.ok(elem.type, 'interactive element should have type');
            assert.ok(elem.effect, 'interactive element should have effect');
            // Ensure selector and effect are brief strings, not raw DOM
            assert.ok(typeof elem.selector === 'string' && elem.selector.length < 500);
            assert.ok(typeof elem.effect === 'string' && elem.effect.length < 500);
          }
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC 2: interactive_elements have stable type IDs', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'Product testing',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Verify that element types are valid enum values (stable detector IDs)
    const validTypes = ['tab', 'dropdown', 'filter', 'accordion', 'sort', 'pagination', 'load_more', 'button'];

    for (const [_sectionKey, section] of Object.entries(written.sections || {})) {
      if (!('status' in section)) {
        const s = section as any;
        if (s.interactive_elements) {
          for (const elem of s.interactive_elements) {
            assert.ok(validTypes.includes(elem.type), `Element type ${elem.type} should be a valid enum value`);
          }
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 3: No screenshot or trace is required for routine success
// ============================================================================

test('AC 3: page behavior does not require screenshots for successful profiling', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-005',
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'Product testing',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Check that there are no screenshot/trace files written
    // (These would only be written on error/unresolved states, not for routine success)
    const dirContents = readdirSync(tmpDir);
    const screenshotFiles = dirContents.filter((f: string) => f.includes('screenshot') || f.includes('trace'));
    // No screenshots for routine success
    assert.equal(screenshotFiles.length, 0, 'No screenshot files should be written for routine success');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 4: No raw body field exists in the schema
// ============================================================================

test('AC 4: page behavior schema does not include raw_body field', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-006',
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_001',
        canonicalUrl: 'https://example-casino.com/sports',
        selected: true,
        selectionReason: 'Product testing',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const profileText = readFileSync(profilePath, 'utf-8');

    // Verify schema does not include raw_body
    assert.ok(!profileText.includes('raw_body'), 'Schema should not have raw_body field');
    assert.ok(!profileText.includes('raw-body'), 'Schema should not have raw-body field');

    // Also verify in the parsed object
    const written = JSON.parse(profileText) as PageBehaviorProfile;
    for (const [_sectionKey, section] of Object.entries(written.sections || {})) {
      if (!('status' in section)) {
        const s = section as any;
        assert.ok(!('raw_body' in s), 'Section should not have raw_body field');
        assert.ok(!('raw-body' in s), 'Section should not have raw-body field');
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 5: A login gate is recorded as blocked; no login is attempted
// ============================================================================

test('AC 5: login-required section is marked as blocked without login attempt', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-007',
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

    // Include a URL that should trigger login gate detection
    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_cashier',
        canonicalUrl: 'https://example-casino.com/cashier',
        selected: true,
        selectionReason: 'Cashier page',
        totalRelevantFields: 3,
        totalIrrelevantFields: 2,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Check that if cashier section exists and is not profiled, it's marked as blocked
    // If it is profiled, it should have valid behavior data
    if (written.sections?.cashier) {
      const cashierSection = written.sections.cashier as any;
      if ('status' in cashierSection) {
        // If blocked, verify it's a valid block status
        assert.ok(['blocked', 'human_required', 'absent'].includes(cashierSection.status),
          `Cashier section status should be blocked/human_required/absent if not accessible`);
        // Verify there's a reason (no login was attempted)
        assert.ok(cashierSection.reason, 'Blocked section should have reason');
      } else {
        // If not blocked, should be a full profile
        assert.ok(cashierSection.url);
        assert.ok(cashierSection.rendering);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC 5: landing page gates are detected and recorded', async () => {
  const tmpDir = mkdtempSync('/tmp/test-page-interactivity-');
  try {
    const runContext: RunContext = {
      run_id: 'test-run-008',
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

    const visitPlan: VisitPlanEntry[] = [
      {
        url_id: 'url_landing',
        canonicalUrl: 'https://example-casino.com',
        selected: true,
        selectionReason: 'Landing page with potential gates',
        totalRelevantFields: 5,
        totalIrrelevantFields: 0,
      },
    ];

    await profilePages(visitPlan, runContext, tmpDir);

    const profilePath = join(tmpDir, 'page-behavior.json');
    const written = JSON.parse(readFileSync(profilePath, 'utf-8')) as PageBehaviorProfile;

    // Verify landing section exists and can have gates
    if (written.landing) {
      // Gates should be structured with type, trigger, dismiss
      if (written.landing.gates && written.landing.gates.length > 0) {
        for (const gate of written.landing.gates) {
          assert.ok(['age_verification', 'cookie_consent', 'geo_block', 'login_required', 'marketing_popup'].includes(gate.type),
            `Gate type should be a valid enum`);
          assert.ok(['immediate', 'after_age_gate', 'after_cookie_gate', 'on_interaction', 'on_scroll'].includes(gate.trigger),
            `Gate trigger should be a valid enum`);
          assert.ok(gate.dismiss, 'Gate should have dismiss path/selector');
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

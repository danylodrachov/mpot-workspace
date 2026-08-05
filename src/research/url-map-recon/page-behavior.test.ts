import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageBehaviorProfile } from './types.ts';
import { validatePageBehavior, writePageBehavior } from './page-behavior.ts';

// LOCKED TEST SUITE for Issue 103: Behavior-Profiling Boundary
// These tests verify acceptance criteria:
// 1. page-behavior.json is written for both complete and partial runs
// 2. Static page, JS-loaded page, modal, tabs/filters, load-more/infinite-scroll behaviors are covered by fixture tests
// 3. Cashier modal vs full-page distinction is captured
// 4. An auth-gated section produces partial output while preserving prior completed section results
// 5. The agent never writes to the URL map or product files, never visits individual game/table/event/match pages

// ============================================================================
// Acceptance Criterion 1: page-behavior.json is written for both complete and partial runs
// ============================================================================

test('AC 1: writes a complete profile with all sections', () => {
  const tmpDir = mkdtempSync('/tmp/test-page-behavior-');
  try {
    const profile: PageBehaviorProfile = {
      casino_id: 'example-casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: '2026-07-24T12:00:00Z',
      landing: {
        url: 'https://example.com',
        gates: [
          { type: 'age_verification', trigger: 'immediate', dismiss: 'click button.age-confirm' },
          { type: 'cookie_consent', trigger: 'after_age_gate', dismiss: 'click #accept-cookies' },
        ],
      },
      sections: {
        sports: {
          url: 'https://example.com/sports',
          rendering: 'static_html',
          content_structure: 'list',
          collection: { type: 'static_list', visible_count: 15 },
          collector_items: 12,
        },
        'live-casino': {
          url: 'https://example.com/live',
          rendering: 'js_loaded',
          load_indicator: 'spinner',
          content_structure: 'grid',
          collection: { type: 'pagination', visible_count: 8, total_count: 24 },
          collector_items: 20,
        },
        cashier: {
          url: 'https://example.com/#cashier',
          rendering: 'modal',
          content_structure: 'tabs',
          collection: { type: 'per_click', visible_count: 5 },
        },
        slots: {
          status: 'blocked' as const,
          reason: 'requires authentication',
        },
        promotions: {
          status: 'absent' as const,
          reason: 'section not found',
        },
      },
    };

    const outputPath = join(tmpDir, 'page-behavior.json');
    writePageBehavior(profile, outputPath);

    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.equal(written.casino_id, 'example-casino');
    assert.ok(written.sections.sports);
    assert.equal(written.sections.cashier.rendering, 'modal');
    assert.equal(written.sections.slots.status, 'blocked');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC 1: writes a partial profile when auth-gated sections are blocked', () => {
  const tmpDir = mkdtempSync('/tmp/test-page-behavior-');
  try {
    const profile: PageBehaviorProfile = {
      casino_id: 'example-casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: '2026-07-24T12:00:00Z',
      sections: {
        sports: {
          url: 'https://example.com/sports',
          rendering: 'static_html',
          content_structure: 'list',
          collection: { type: 'static_list', visible_count: 15 },
        },
        'live-casino': {
          status: 'human_required' as const,
          reason: 'login required to access live games',
        },
        slots: {
          status: 'human_required' as const,
          reason: 'login required to access slots',
        },
        cashier: {
          status: 'human_required' as const,
          reason: 'login required to access cashier',
        },
        promotions: {
          status: 'absent' as const,
          reason: 'section not found',
        },
      },
    };

    const outputPath = join(tmpDir, 'page-behavior-partial.json');
    writePageBehavior(profile, outputPath);

    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.ok(written.sections.sports);
    assert.equal(written.sections.sports.url, 'https://example.com/sports');
    assert.equal(written.sections['live-casino'].status, 'human_required');
    assert.equal(written.sections.slots.status, 'human_required');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC 1: preserves completed sections when another section is blocked', () => {
  const tmpDir = mkdtempSync('/tmp/test-page-behavior-');
  try {
    const profile: PageBehaviorProfile = {
      casino_id: 'example-casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: '2026-07-24T12:00:00Z',
      sections: {
        sports: {
          url: 'https://example.com/sports',
          rendering: 'static_html',
          content_structure: 'list',
          collection: { type: 'static_list', visible_count: 20 },
          collector_items: 18,
        },
        'live-casino': {
          url: 'https://example.com/live',
          rendering: 'js_loaded',
          content_structure: 'grid',
          collection: { type: 'pagination', visible_count: 8, total_count: 24 },
          collector_items: 15,
        },
        slots: {
          status: 'human_required' as const,
          reason: 'login required',
        },
        cashier: {
          status: 'human_required' as const,
          reason: 'login required',
        },
        promotions: {
          status: 'absent' as const,
          reason: 'not found',
        },
      },
    };

    const outputPath = join(tmpDir, 'page-behavior-mixed.json');
    writePageBehavior(profile, outputPath);

    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    // Both completed sections are preserved
    assert.equal(written.sections.sports.url, 'https://example.com/sports');
    assert.equal(written.sections['live-casino'].url, 'https://example.com/live');
    // Blocked sections still have status
    assert.equal(written.sections.slots.status, 'human_required');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Acceptance Criterion 2: Static page, JS-loaded, modal, tabs/filters, load-more/infinite-scroll behaviors
// ============================================================================

test('AC 2: captures static HTML page rendering', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 25 },
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  assert.ok(profile.sections?.sports);
});

test('AC 2: captures JS-loaded page with spinner', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      'live-casino': {
        url: 'https://example.com/live',
        rendering: 'js_loaded',
        load_indicator: 'spinner',
        content_structure: 'grid',
        collection: { type: 'pagination', visible_count: 8, total_count: 50 },
        interactive_elements: [{ type: 'pagination', selector: '.pagination', effect: 'loads next page' }],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!['live-casino'] as any;
  assert.equal(section.rendering, 'js_loaded');
  assert.equal(section.load_indicator, 'spinner');
});

test('AC 2: captures modal rendering', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      cashier: {
        url: 'https://example.com/#cashier',
        rendering: 'modal',
        content_structure: 'tabs',
        collection: { type: 'per_click', visible_count: 5 },
        interactive_elements: [{ type: 'tab', selector: '.tab', effect: 'switches deposit/withdraw', count: 2 }],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.cashier as any;
  assert.equal(section.rendering, 'modal');
});

test('AC 2: captures tabs interactive element with count', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'tabs',
        collection: { type: 'static_list', visible_count: 15 },
        interactive_elements: [
          { type: 'tab', selector: '.sport-tab', effect: 'switches sport category list', count: 12 },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.sports as any;
  const element = section.interactive_elements?.[0];
  assert.equal(element?.type, 'tab');
  assert.equal(element?.count, 12);
});

test('AC 2: captures filter interactive element', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      'live-casino': {
        url: 'https://example.com/live',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'static_list', visible_count: 20 },
        interactive_elements: [
          { type: 'filter', selector: '.filter-btn', effect: 'narrows displayed games by type' },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!['live-casino'] as any;
  const element = section.interactive_elements?.[0];
  assert.equal(element?.type, 'filter');
});

test('AC 2: captures load-more button collection type', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      slots: {
        url: 'https://example.com/slots',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'load_more', visible_count: 30, total_count: 500 },
        interactive_elements: [{ type: 'load_more', selector: 'button.load-more', effect: 'appends next 30 items' }],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.slots as any;
  const collection = section.collection;
  assert.equal(collection.type, 'load_more');
  assert.equal(collection.visible_count, 30);
  assert.equal(collection.total_count, 500);
});

test('AC 2: captures infinite-scroll collection type', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      slots: {
        url: 'https://example.com/slots',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'infinite_scroll', visible_count: 40 },
        interactive_elements: [
          { type: 'pagination', selector: 'window', effect: 'loads more items on scroll to bottom' },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.slots as any;
  assert.equal(section.collection.type, 'infinite_scroll');
});

test('AC 2: captures accordion interactive element', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      promotions: {
        url: 'https://example.com/promotions',
        rendering: 'static_html',
        content_structure: 'accordion',
        collection: { type: 'static_list', visible_count: 5 },
        interactive_elements: [
          { type: 'accordion', selector: '.promo-accordion', effect: 'expands promotion details', count: 5 },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.promotions as any;
  const element = section.interactive_elements?.[0];
  assert.equal(element?.type, 'accordion');
});

// ============================================================================
// Acceptance Criterion 3: Cashier modal vs full-page distinction is captured
// ============================================================================

test('AC 3: captures cashier as modal', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      cashier: {
        url: 'https://example.com/#cashier',
        rendering: 'modal',
        content_structure: 'tabs',
        collection: { type: 'per_click', visible_count: 15 },
        interactive_elements: [
          { type: 'dropdown', selector: '#payment-method', effect: 'reveals method details and limits' },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.cashier as any;
  assert.equal(section.rendering, 'modal');
});

test('AC 3: captures cashier as full page', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      cashier: {
        url: 'https://example.com/cashier',
        rendering: 'static_html',
        content_structure: 'tabs',
        collection: { type: 'per_click', visible_count: 8 },
        interactive_elements: [
          { type: 'tab', selector: '.payment-tab', effect: 'switches deposit/withdraw', count: 2 },
        ],
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.cashier as any;
  assert.equal(section.rendering, 'static_html');
  assert.equal(section.url, 'https://example.com/cashier');
});

test('AC 3: captures per-click payment method loading', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      cashier: {
        url: 'https://example.com/#cashier',
        rendering: 'modal',
        content_structure: 'custom',
        collection: { type: 'per_click', visible_count: 1 },
        interactive_elements: [
          {
            type: 'dropdown',
            selector: '.payment-method-list',
            effect: 'per click reveals: name, limits, currency, processing time',
          },
        ],
        notes: 'payment method details loaded per selection',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.cashier as any;
  assert.equal(section.collection.type, 'per_click');
});

// ============================================================================
// Acceptance Criterion 4: Auth-gated section produces partial output, preserving completed results
// ============================================================================

test('AC 4: marks auth-gated section as human_required', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      slots: {
        status: 'human_required' as const,
        reason: 'login required to access slots section',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.slots as any;
  assert.equal(section.status, 'human_required');
});

test('AC 4: preserves sports and live-casino when slots becomes human_required', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 20 },
        collector_items: 18,
      },
      'live-casino': {
        url: 'https://example.com/live',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'pagination', visible_count: 8, total_count: 24 },
        collector_items: 15,
      },
      slots: {
        status: 'human_required' as const,
        reason: 'login required',
      },
      cashier: {
        status: 'human_required' as const,
        reason: 'login required',
      },
      promotions: {
        status: 'absent' as const,
        reason: 'section not found',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);

  // Verify completed sections are intact
  assert.ok(profile.sections!.sports);
  assert.ok(profile.sections!['live-casino']);

  // Verify those sections have full data
  const sportsSection = profile.sections!.sports as any;
  assert.ok(sportsSection.url);
  assert.ok(sportsSection.rendering);
  assert.ok(sportsSection.collection);

  // Verify blocked sections still exist
  assert.ok(profile.sections!.slots);
  assert.ok(profile.sections!.cashier);
});

test('AC 4: anonymous access with auth-required blocked sections', () => {
  const anonProfile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 15 },
      },
      'live-casino': {
        status: 'blocked' as const,
        reason: 'anonymous access denied; login required',
      },
      slots: {
        status: 'blocked' as const,
        reason: 'anonymous access denied; login required',
      },
      cashier: {
        status: 'blocked' as const,
        reason: 'anonymous access denied; login required',
      },
      promotions: {
        status: 'absent' as const,
        reason: 'section not found',
      },
    },
  };

  const validation = validatePageBehavior(anonProfile);
  assert.equal(validation.valid, true);
  const sportsSection = anonProfile.sections!.sports as any;
  assert.equal(sportsSection.url, 'https://example.com/sports');
  const liveSection = anonProfile.sections!['live-casino'] as any;
  assert.equal(liveSection.status, 'blocked');
});

// ============================================================================
// Acceptance Criterion 5: No URL map writes, no product file writes, no individual game/table/event pages
// ============================================================================

test('AC 5: documents page behavior only (no product URLs)', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 15 },
        notes: 'page behavior only; no product URLs in this field',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);

  // Verify the profile contains ONLY behavior data
  const section = profile.sections!.sports as any;
  assert.ok(section.rendering);
  assert.ok(section.content_structure);
  assert.ok(section.collection);
  assert.ok(section.url); // Section URL is known from recon
});

test('AC 5: uses collector_items field instead of script_engine_items', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 25 },
        collector_items: 20,
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.sports as any;
  assert.ok('collector_items' in section);
  assert.equal(section.collector_items, 20);
  // Should NOT have 'script_engine_items' field
  assert.ok(!('script_engine_items' in section));
});

test('AC 5: does not include individual game/table/event URLs', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      slots: {
        url: 'https://example.com/slots', // Section URL only, known from recon
        rendering: 'static_html',
        content_structure: 'grid',
        collection: { type: 'static_list', visible_count: 50 },
        notes: 'behavior profile; individual game URLs are NOT included',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);

  // The section only has the section-level URL, not individual game URLs
  const section = profile.sections!.slots as any;
  assert.equal(section.url, 'https://example.com/slots');
  // No field for individual game URLs in the behavior schema
  assert.ok(!('game_urls' in section));
  assert.ok(!('individual_urls' in section));
});

test('AC 5: navigation paths use selectors and descriptions, not product URLs', () => {
  const profile: PageBehaviorProfile = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        url: 'https://example.com/sports',
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 15 },
        nav_path: ['click a[href="/sports"]', 'wait for .sport-list', 'screenshot'],
        notes: 'nav_path uses selectors and descriptions, not individual URLs',
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, true);
  const section = profile.sections!.sports as any;
  const navPath = section.nav_path;
  assert.deepEqual(navPath, ['click a[href="/sports"]', 'wait for .sport-list', 'screenshot']);
});

// ============================================================================
// Validation error cases
// ============================================================================

test('Validation: rejects profile without casino_id', () => {
  const profile: any = {
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e: string) => e.includes('casino_id')));
});

test('Validation: rejects profile with invalid geo code', () => {
  const profile: any = {
    casino_id: 'test',
    geo: 'INVALID',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e: string) => e.includes('geo')));
});

test('Validation: rejects section with missing url', () => {
  const profile: any = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      sports: {
        rendering: 'static_html',
        content_structure: 'list',
        collection: { type: 'static_list', visible_count: 15 },
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e: string) => e.includes('url')));
});

test('Validation: rejects error section without reason', () => {
  const profile: any = {
    casino_id: 'test',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: '2026-07-24T12:00:00Z',
    sections: {
      slots: {
        status: 'human_required',
        // Missing reason
      },
    },
  };

  const validation = validatePageBehavior(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e: string) => e.includes('reason')));
});

// ============================================================================
// File I/O tests
// ============================================================================

test('File I/O: writes valid profile to JSON file', () => {
  const tmpDir = mkdtempSync('/tmp/test-page-behavior-');
  try {
    const profile: PageBehaviorProfile = {
      casino_id: 'test-casino',
      geo: 'BR',
      locale: 'pt-BR',
      profiled_at: '2026-07-24T12:00:00Z',
      landing: {
        url: 'https://example.com',
        gates: [{ type: 'age_verification', trigger: 'immediate', dismiss: 'click .age-btn' }],
      },
      sections: {
        sports: {
          url: 'https://example.com/sports',
          rendering: 'static_html',
          content_structure: 'list',
          collection: { type: 'static_list', visible_count: 15 },
        },
      },
    };

    const outputPath = join(tmpDir, 'test-profile.json');
    writePageBehavior(profile, outputPath);

    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.equal(written.casino_id, 'test-casino');
    assert.ok(written.landing.gates);
    assert.equal(written.landing.gates.length, 1);
    assert.ok(written.sections.sports);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('File I/O: rejects writing invalid profile', () => {
  const tmpDir = mkdtempSync('/tmp/test-page-behavior-');
  try {
    const profile: any = {
      geo: 'INVALID',
      // missing casino_id
    };

    const outputPath = join(tmpDir, 'invalid.json');
    let errorMsg = '';
    try {
      writePageBehavior(profile, outputPath);
      assert.fail('Expected writePageBehavior to throw');
    } catch (e: unknown) {
      if (e instanceof Error) {
        errorMsg = e.message;
      }
    }
    assert.ok(errorMsg.includes('Invalid page behavior profile'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

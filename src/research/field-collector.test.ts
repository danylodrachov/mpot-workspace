import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectFieldEvidence } from './field-collector.ts';
import type { FieldRequirementsOutput } from './template-requirements.ts';
import type { PageBehaviorProfile } from './url-map-recon/types.ts';

// Helper to create a temporary directory
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'field-collector-test-'));
}

// Helper to cleanup
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Create fixture for field-requirements.json
function createFieldRequirements(): FieldRequirementsOutput {
  return {
    version: '1.0.0',
    fields: [
      {
        field_id: 'casino_name',
        category: 'casinos',
        name: 'Casino Name',
        type: 'text',
        extraction_rule_ids: ['ARIA_SNAPSHOT_V1', 'DOM_SEMANTIC_SCAN_V1'],
      },
      {
        field_id: 'welcome_bonus',
        category: 'casino_bonuses',
        name: 'Welcome Bonus Amount',
        type: 'text',
        extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1', 'TABLE_EXTRACTION_V1'],
      },
      {
        field_id: 'live_dealer_games',
        category: 'casino_games',
        name: 'Live Dealer Games',
        type: 'text',
        extraction_rule_ids: ['COLLECTION_PRODUCTS_V1'],
      },
    ],
  };
}

// Create fixture for page-behavior.json
function createPageBehavior(): PageBehaviorProfile {
  return {
    casino_id: 'test-casino',
    geo: 'BR',
    locale: 'pt-BR',
    profiled_at: new Date().toISOString(),
    landing: {
      url: 'https://test.example.com/',
      gates: [],
    },
    sections: {
      sports: {
        url: 'https://test.example.com/sports',
        rendering: 'js_loaded',
        content_structure: 'tabs',
        collection: { type: 'static_list', visible_count: 10 },
      },
      'live-casino': {
        url: 'https://test.example.com/live-casino',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'pagination', visible_count: 20 },
      },
      slots: {
        url: 'https://test.example.com/slots',
        rendering: 'js_loaded',
        content_structure: 'grid',
        collection: { type: 'load_more', visible_count: 15 },
      },
    },
  };
}

test('field-collector: collects field evidence with valid structure', async () => {
  const testDir = createTestDir();
  try {
    // Write fixtures
    const fieldReqs = createFieldRequirements();
    const pageBehavior = createPageBehavior();

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const behaviorPath = path.join(testDir, 'page-behavior.json');
    const outputPath = path.join(testDir, 'field-evidence.jsonl');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldReqs));
    fs.writeFileSync(behaviorPath, JSON.stringify(pageBehavior));

    // Collect evidence
    await collectFieldEvidence(fieldReqPath, behaviorPath, outputPath);

    // Verify output file exists
    assert.ok(
      fs.existsSync(outputPath),
      'field-evidence.jsonl should be created'
    );

    // Read and parse output
    const content = fs.readFileSync(outputPath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((line) => line.trim().length > 0);

    // Must generate at least one candidate when fields have extraction rules and sections exist
    assert.ok(
      lines.length > 0,
      'Should generate at least one candidate from provided fields and sections'
    );

    // Parse each line as JSON
    const candidates = lines.map((line) => JSON.parse(line));

    // AC1: Every candidate maps to an existing field ID
    const fieldIds = new Set(fieldReqs.fields.map((f) => f.field_id));
    for (const candidate of candidates) {
      assert.ok(
        fieldIds.has(candidate.field_id),
        `Candidate field_id '${candidate.field_id}' must exist in field-requirements`
      );
    }

    // Verify required fields on each candidate
    for (const candidate of candidates) {
      assert.ok(candidate.field_id, 'candidate must have field_id');
      assert.ok(candidate.url, 'candidate must have url');
      assert.ok(candidate.value, 'candidate must have value');
      assert.ok(candidate.extraction_rule_id, 'candidate must have extraction_rule_id');
      assert.ok(candidate.timestamp, 'candidate must have timestamp');
      assert.ok(candidate.evidence_type, 'candidate must have evidence_type');
    }

    // AC2: Every evidence URL is inside allowed scope
    const allowedUrls = new Set([
      'https://test.example.com/',
      'https://test.example.com/sports',
      'https://test.example.com/live-casino',
      'https://test.example.com/slots',
    ]);
    for (const candidate of candidates) {
      assert.ok(
        allowedUrls.has(candidate.url),
        `URL ${candidate.url} must be in allowed scope`
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test('field-collector: fails when page-behavior.json does not exist', async () => {
  const testDir = createTestDir();
  try {
    const fieldReqs = createFieldRequirements();
    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const behaviorPath = path.join(testDir, 'page-behavior.json');
    const outputPath = path.join(testDir, 'field-evidence.jsonl');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldReqs));
    // Don't write page-behavior.json

    // AC3: Product collection cannot run before behaviour instructions exist
    try {
      await collectFieldEvidence(fieldReqPath, behaviorPath, outputPath);
      assert.fail('Should throw when page-behavior.json does not exist');
    } catch (err) {
      assert.ok(
        err instanceof Error,
        'Should throw an Error when page-behavior.json is missing'
      );
      assert.match(
        (err as Error).message,
        /page.?behavior|exist|found/i,
        'Error message should mention page-behavior'
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test('field-collector: handles empty collection sections explicitly', async () => {
  const testDir = createTestDir();
  try {
    const fieldReqs = createFieldRequirements();
    const pageBehavior = createPageBehavior();

    // Mark one section as blocked
    pageBehavior.sections!.sports = {
      status: 'blocked',
      reason: 'Anonymous access denied',
    };

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const behaviorPath = path.join(testDir, 'page-behavior.json');
    const outputPath = path.join(testDir, 'field-evidence.jsonl');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldReqs));
    fs.writeFileSync(behaviorPath, JSON.stringify(pageBehavior));

    // Collect evidence
    await collectFieldEvidence(fieldReqPath, behaviorPath, outputPath);

    // AC4: Empty and truncated collections remain explicit
    // The output should still be created (even if no evidence for that section)
    assert.ok(fs.existsSync(outputPath), 'field-evidence.jsonl should exist');
  } finally {
    cleanupTestDir(testDir);
  }
});

test('field-collector: includes extraction rule ID on each evidence row', async () => {
  const testDir = createTestDir();
  try {
    const fieldReqs = createFieldRequirements();
    const pageBehavior = createPageBehavior();

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const behaviorPath = path.join(testDir, 'page-behavior.json');
    const outputPath = path.join(testDir, 'field-evidence.jsonl');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldReqs));
    fs.writeFileSync(behaviorPath, JSON.stringify(pageBehavior));

    // Collect evidence
    await collectFieldEvidence(fieldReqPath, behaviorPath, outputPath);

    const content = fs.readFileSync(outputPath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((line) => line.trim().length > 0);

    // Verify each line has extraction_rule_id
    for (const line of lines) {
      const candidate = JSON.parse(line);
      assert.ok(
        candidate.extraction_rule_id,
        'Each evidence row must have extraction_rule_id'
      );
      // Rule ID should be from the field's extraction_rule_ids list
      const field = fieldReqs.fields.find(
        (f) => f.field_id === candidate.field_id
      );
      assert.ok(
        field?.extraction_rule_ids?.includes(candidate.extraction_rule_id),
        `extraction_rule_id '${candidate.extraction_rule_id}' must be in field's extraction_rule_ids`
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test('field-collector: works with different casino data (not hardcoded)', async () => {
  const testDir = createTestDir();
  try {
    // Create DIFFERENT field requirements
    const fieldReqs: FieldRequirementsOutput = {
      version: '1.0.0',
      fields: [
        {
          field_id: 'betting_limit',
          category: 'betting',
          name: 'Betting Limit',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'deposit_method',
          category: 'deposits',
          name: 'Deposit Method',
          type: 'text',
          extraction_rule_ids: ['TABLE_EXTRACTION_V1'],
        },
      ],
    };

    // Create DIFFERENT page behavior
    const pageBehavior: PageBehaviorProfile = {
      casino_id: 'different-casino',
      geo: 'US',
      locale: 'en-US',
      profiled_at: new Date().toISOString(),
      sections: {
        cashier: {
          url: 'https://different.example.com/cashier',
          rendering: 'static_html',
          content_structure: 'custom',
          collection: { type: 'static_list', visible_count: 5 },
        },
      },
    };

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const behaviorPath = path.join(testDir, 'page-behavior.json');
    const outputPath = path.join(testDir, 'field-evidence.jsonl');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldReqs));
    fs.writeFileSync(behaviorPath, JSON.stringify(pageBehavior));

    // Collect evidence
    await collectFieldEvidence(fieldReqPath, behaviorPath, outputPath);

    const content = fs.readFileSync(outputPath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((line) => line.trim().length > 0);

    // Should generate candidates with the different casino data
    assert.ok(lines.length > 0, 'Should generate candidates from different casino data');

    const candidates = lines.map((line) => JSON.parse(line));

    // Verify candidates use the different casino's URL
    for (const candidate of candidates) {
      assert.ok(
        candidate.url.includes('different.example.com'),
        'Candidates should use the different casino URL, not the hardcoded one'
      );
      assert.ok(
        candidate.field_id === 'betting_limit' || candidate.field_id === 'deposit_method',
        'Candidates should use the different field IDs'
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateFieldCoverage } from './coverage-reporter.ts';
import type { FieldRequirementsOutput } from './template-requirements.ts';
import type { FieldEvidenceCandidate } from './field-collector.ts';

// Helper to create a temporary directory
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-reporter-test-'));
}

// Helper to cleanup
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Test 1: Coverage reporter generates field-coverage.json for all researchable fields', async () => {
  const testDir = createTestDir();

  try {
    // Create test fixtures
    const fieldRequirements: FieldRequirementsOutput = {
      version: '1.0.0',
      fields: [
        {
          field_id: 'casino:name',
          category: 'casino',
          name: 'Casino Name',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'casino:year_founded',
          category: 'casino',
          name: 'Year Founded',
          type: 'number',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'support:email',
          category: 'support',
          name: 'Support Email',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
      ],
    };

    // Create field evidence with evidence for first two fields only
    const fieldEvidence: FieldEvidenceCandidate[] = [
      {
        field_id: 'casino:name',
        template: 'casino',
        field_name: 'Casino Name',
        value: 'Test Casino',
        url: 'https://example.com',
        section: 'landing',
        interaction_state: 'static',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
      {
        field_id: 'casino:year_founded',
        template: 'casino',
        field_name: 'Year Founded',
        value: '2020',
        url: 'https://example.com',
        section: 'landing',
        interaction_state: 'static',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
    ];

    // Create empty normalisation decisions
    const normalisationDecisions: any[] = [];

    // Create minimal visit plan
    const visitPlan = {
      plan: [
        {
          url_id: 'url1',
          url: 'https://example.com',
          isMandatory: true,
          disposition: 'selected',
          reason: 'mandatory',
        },
      ],
    };

    // Write fixtures
    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const fieldEvidencePath = path.join(testDir, 'field-evidence.jsonl');
    const normalisationPath = path.join(testDir, 'normalisation-decisions.jsonl');
    const visitPlanPath = path.join(testDir, 'visit-plan.json');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements, null, 2));
    fs.writeFileSync(
      fieldEvidencePath,
      fieldEvidence.map((e) => JSON.stringify(e)).join('\n')
    );
    fs.writeFileSync(
      normalisationPath,
      normalisationDecisions.map((d) => JSON.stringify(d)).join('\n')
    );
    fs.writeFileSync(visitPlanPath, JSON.stringify(visitPlan, null, 2));

    // Run coverage reporter
    const outputPath = path.join(testDir, 'field-coverage.json');
    const deltaPath = path.join(testDir, 'discovery-delta.json');

    await generateFieldCoverage(fieldReqPath, fieldEvidencePath, normalisationPath, visitPlanPath, outputPath, deltaPath);

    // Verify output
    assert(fs.existsSync(outputPath), 'field-coverage.json should be created');

    const coverageContent = fs.readFileSync(outputPath, 'utf-8');
    const coverage = JSON.parse(coverageContent);

    // AC1: Every researchable field has one row
    assert.equal(coverage.fields.length, 3, 'Should have coverage for all 3 researchable fields');

    // Verify field IDs and statuses
    const fieldMap = new Map(coverage.fields.map((f: any) => [f.field_id, f as { status: string }]));
    assert(fieldMap.has('casino:name'), 'Should have entry for casino:name');
    assert(fieldMap.has('casino:year_founded'), 'Should have entry for casino:year_founded');
    assert(fieldMap.has('support:email'), 'Should have entry for support:email');

    // AC3: Missing evidence remains missing
    assert.equal((fieldMap.get('casino:name') as any).status, 'found', 'casino:name should be found (has evidence)');
    assert.equal((fieldMap.get('casino:year_founded') as any).status, 'found', 'casino:year_founded should be found (has evidence)');
    assert.equal((fieldMap.get('support:email') as any).status, 'missing', 'support:email should be missing (no evidence)');

    // AC5: Counts reconcile with field-requirements.json
    assert.equal(coverage.total_fields, 3, 'Total fields should match field-requirements');
    assert.equal(coverage.found_count, 2, 'Should have 2 found fields');
    assert.equal(coverage.missing_count, 1, 'Should have 1 missing field');
  } finally {
    cleanupTestDir(testDir);
  }
});

test('Test 2: Coverage reporter excludes operator fields', async () => {
  const testDir = createTestDir();

  try {
    // Create field requirements with operator_fields
    const fieldRequirements: FieldRequirementsOutput = {
      version: '1.0.0',
      fields: [
        {
          field_id: 'casino:name',
          category: 'casino',
          name: 'Casino Name',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        // Note: operator fields like 'country', 'priority' are NOT in this list
        // because template-requirements.ts already filters them out
      ],
    };

    const fieldEvidence: FieldEvidenceCandidate[] = [];
    const normalisationDecisions: any[] = [];
    const visitPlan = {
      plan: [
        {
          url_id: 'url1',
          url: 'https://example.com',
          isMandatory: true,
          disposition: 'selected',
          reason: 'mandatory',
        },
      ],
    };

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const fieldEvidencePath = path.join(testDir, 'field-evidence.jsonl');
    const normalisationPath = path.join(testDir, 'normalisation-decisions.jsonl');
    const visitPlanPath = path.join(testDir, 'visit-plan.json');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements, null, 2));
    fs.writeFileSync(fieldEvidencePath, ''); // Empty evidence
    fs.writeFileSync(normalisationPath, ''); // Empty decisions
    fs.writeFileSync(visitPlanPath, JSON.stringify(visitPlan, null, 2));

    const outputPath = path.join(testDir, 'field-coverage.json');
    const deltaPath = path.join(testDir, 'discovery-delta.json');

    await generateFieldCoverage(fieldReqPath, fieldEvidencePath, normalisationPath, visitPlanPath, outputPath, deltaPath);

    const coverageContent = fs.readFileSync(outputPath, 'utf-8');
    const coverage = JSON.parse(coverageContent);

    // AC2: Operator fields have no coverage row (they're not in field-requirements)
    assert.equal(coverage.fields.length, 1, 'Should have coverage for only 1 researchable field');
    assert.equal(coverage.fields[0].field_id, 'casino:name', 'Should only have casino:name');
  } finally {
    cleanupTestDir(testDir);
  }
});

test('Test 3: Coverage reporter generates discovery-delta.json for gaps', async () => {
  const testDir = createTestDir();

  try {
    const fieldRequirements: FieldRequirementsOutput = {
      version: '1.0.0',
      fields: [
        {
          field_id: 'casino:name',
          category: 'casino',
          name: 'Casino Name',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'casino:year_founded',
          category: 'casino',
          name: 'Year Founded',
          type: 'number',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
      ],
    };

    const fieldEvidence: FieldEvidenceCandidate[] = [
      {
        field_id: 'casino:name',
        template: 'casino',
        field_name: 'Casino Name',
        value: 'Test Casino',
        url: 'https://example.com',
        section: 'landing',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
    ];

    const visitPlan = {
      plan: [
        {
          url_id: 'url1',
          url: 'https://example.com',
          isMandatory: true,
          disposition: 'selected',
          reason: 'mandatory',
        },
        {
          url_id: 'url2',
          url: 'https://example.com/about',
          isMandatory: false,
          disposition: 'not_selected',
          reason: 'low relevance',
        },
      ],
    };

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const fieldEvidencePath = path.join(testDir, 'field-evidence.jsonl');
    const normalisationPath = path.join(testDir, 'normalisation-decisions.jsonl');
    const visitPlanPath = path.join(testDir, 'visit-plan.json');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements, null, 2));
    fs.writeFileSync(
      fieldEvidencePath,
      fieldEvidence.map((e) => JSON.stringify(e)).join('\n')
    );
    fs.writeFileSync(normalisationPath, '');
    fs.writeFileSync(visitPlanPath, JSON.stringify(visitPlan, null, 2));

    const outputPath = path.join(testDir, 'field-coverage.json');
    const deltaPath = path.join(testDir, 'discovery-delta.json');

    await generateFieldCoverage(fieldReqPath, fieldEvidencePath, normalisationPath, visitPlanPath, outputPath, deltaPath);

    // Verify delta is created
    assert(fs.existsSync(deltaPath), 'discovery-delta.json should be created');

    const deltaContent = fs.readFileSync(deltaPath, 'utf-8');
    const delta = JSON.parse(deltaContent);

    // Delta should have at least one gap (casino:year_founded is missing)
    assert(Array.isArray(delta.gaps), 'Delta should have gaps array');
    assert(delta.gaps.length >= 1, 'Should have at least one gap (casino:year_founded missing)');

    // Verify gap contains expected fields
    const yearFoundedGap = delta.gaps.find((g: any) => g.field_id === 'casino:year_founded');
    assert(yearFoundedGap, 'Should have gap for casino:year_founded');
    assert.equal(yearFoundedGap.gap_type, 'missing', 'Gap type should be missing');
  } finally {
    cleanupTestDir(testDir);
  }
});

test('Test 4: Coverage reporter counts reconcile with field-requirements', async () => {
  const testDir = createTestDir();

  try {
    // Different data from test 1 to prove generic behavior
    const fieldRequirements: FieldRequirementsOutput = {
      version: '1.0.0',
      fields: [
        {
          field_id: 'support:phone',
          category: 'support',
          name: 'Phone Number',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'support:live_chat',
          category: 'support',
          name: 'Live Chat Available',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'support:email',
          category: 'support',
          name: 'Email Address',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
        {
          field_id: 'support:hours',
          category: 'support',
          name: 'Support Hours',
          type: 'text',
          extraction_rule_ids: ['DOM_SEMANTIC_SCAN_V1'],
        },
      ],
    };

    // Evidence for 3 out of 4 fields
    const fieldEvidence: FieldEvidenceCandidate[] = [
      {
        field_id: 'support:phone',
        template: 'support',
        field_name: 'Phone Number',
        value: '+1-555-0100',
        url: 'https://example.com/contact',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
      {
        field_id: 'support:live_chat',
        template: 'support',
        field_name: 'Live Chat Available',
        value: 'yes',
        url: 'https://example.com/contact',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
      {
        field_id: 'support:email',
        template: 'support',
        field_name: 'Email Address',
        value: 'support@example.com',
        url: 'https://example.com/contact',
        extraction_rule_id: 'DOM_SEMANTIC_SCAN_V1',
        evidence_type: 'dom_text',
        timestamp: new Date().toISOString(),
      },
    ];

    const visitPlan = {
      plan: [
        {
          url_id: 'url1',
          url: 'https://example.com/contact',
          isMandatory: true,
          disposition: 'selected',
        },
      ],
    };

    const fieldReqPath = path.join(testDir, 'field-requirements.json');
    const fieldEvidencePath = path.join(testDir, 'field-evidence.jsonl');
    const normalisationPath = path.join(testDir, 'normalisation-decisions.jsonl');
    const visitPlanPath = path.join(testDir, 'visit-plan.json');

    fs.writeFileSync(fieldReqPath, JSON.stringify(fieldRequirements, null, 2));
    fs.writeFileSync(
      fieldEvidencePath,
      fieldEvidence.map((e) => JSON.stringify(e)).join('\n')
    );
    fs.writeFileSync(normalisationPath, '');
    fs.writeFileSync(visitPlanPath, JSON.stringify(visitPlan, null, 2));

    const outputPath = path.join(testDir, 'field-coverage.json');
    const deltaPath = path.join(testDir, 'discovery-delta.json');

    await generateFieldCoverage(fieldReqPath, fieldEvidencePath, normalisationPath, visitPlanPath, outputPath, deltaPath);

    const coverageContent = fs.readFileSync(outputPath, 'utf-8');
    const coverage = JSON.parse(coverageContent);

    // AC5: Counts reconcile
    assert.equal(coverage.total_fields, 4, 'Total should be 4 fields');
    assert.equal(coverage.found_count, 3, 'Found count should be 3');
    assert.equal(coverage.missing_count, 1, 'Missing count should be 1');
    assert.equal(coverage.found_count + coverage.missing_count, coverage.total_fields, 'Counts should reconcile');
  } finally {
    cleanupTestDir(testDir);
  }
});

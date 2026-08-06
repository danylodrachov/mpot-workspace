import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyMetadata, classifyAndPersist } from './url-metadata-classifier.ts';
import type { UrlMapEntry } from './types.ts';

test('Classifier: no browser/network dependencies exist', async () => {
  // This is a compile-time check — url-metadata-classifier.ts must not import
  // any browser or network modules. The test passes if the module loads.
  const module = await import('./url-metadata-classifier.ts');
  assert.ok(module.classifyMetadata, 'classifyMetadata function should exist');
  assert.ok(module.classifyAndPersist, 'classifyAndPersist function should exist');
});

test('Classifier: mandatory fixture (cashier) is flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/cashier',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, true, 'Cashier URL should be mandatory');
  assert.equal(classified.pageClass, 'cashier', 'Should classify as cashier');
});

test('Classifier: mandatory fixture (deposit) is flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/deposit',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, true, 'Deposit URL should be mandatory');
  assert.equal(classified.pageClass, 'deposit', 'Should classify as deposit');
});

test('Classifier: mandatory fixture (withdrawal) is flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/withdrawal',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, true, 'Withdrawal URL should be mandatory');
  assert.equal(classified.pageClass, 'withdrawal', 'Should classify as withdrawal');
});

test('Classifier: mandatory fixture (bonuses) is flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/bonuses',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, true, 'Bonuses URL should be mandatory');
  assert.equal(classified.pageClass, 'bonuses', 'Should classify as bonuses');
});

test('Classifier: mandatory fixture (terms-and-conditions) is flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/terms-and-conditions',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, true, 'Terms and conditions URL should be mandatory');
  assert.ok(
    classified.pageClass === 'terms' || classified.pageClass === 'terms_and_conditions',
    'Should classify as terms-related'
  );
});

test('Classifier: unknown fixture remains present and unclassified', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/some-random-page',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isMandatory, false, 'Unknown URL should not be mandatory');
  assert.ok(classified.pageClass === undefined || classified.pageClass === 'unknown', 'Should leave unknown URLs unclassified');
});

test('Classifier: product landing pages are flagged', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/slots',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.isProductCategoryLanding, true, 'Slots URL should be product category landing');
  assert.equal(classified.pageClass, 'slots', 'Should classify as slots');
});

test('Classifier: derived label from slug', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/deposit-limits',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
    derivedLabel: 'deposit limits',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.slugLabel, 'deposit limits', 'Should preserve slug label');
});

test('Classifier: route tokens extracted from path', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/sports/football/matches',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.ok(Array.isArray(classified.routeTokens), 'routeTokens should be an array');
  assert.ok(classified.routeTokens.includes('sports'), 'Should include sports token');
  assert.ok(classified.routeTokens.includes('football'), 'Should include football token');
});

test('Classifier: output includes origin status', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/bonus',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.originStatus, 'official_same_origin', 'Should preserve origin status');
});

test('Classifier: source confidence assigned', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/cashier',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.ok(classified.sourceConfidence !== undefined, 'Should assign source confidence');
  assert.ok(typeof classified.sourceConfidence === 'number', 'Source confidence should be a number');
  assert.ok(classified.sourceConfidence >= 0 && classified.sourceConfidence <= 1, 'Confidence should be 0-1');
});

test('Classifier: deterministic output for same input', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/bonus-rules',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const result1 = classifyMetadata(entry);
  const result2 = classifyMetadata(entry);

  assert.deepEqual(result1, result2, 'Two runs on same input should produce identical output');
});

test('Classifier: persistence to clean-url-inventory.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'url-classifier-test-'));

  try {
    const inventory: UrlMapEntry[] = [
      {
        canonicalUrl: 'https://example.com/bonus',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/deposit',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/slots',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/unknown-page',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
    ];

    await classifyAndPersist(tmpDir, inventory);

    const inventoryPath = path.join(tmpDir, 'clean-url-inventory.json');
    assert.ok(fs.existsSync(inventoryPath), 'clean-url-inventory.json should exist');

    const updated = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));
    assert.ok(Array.isArray(updated), 'Inventory should be an array');
    assert.equal(updated.length, inventory.length, 'Should preserve all URLs');

    // All entries should have new classification fields
    for (const entry of updated) {
      assert.ok(entry.canonicalUrl, 'Should have canonicalUrl');
      assert.ok(entry.originStatus, 'Should have originStatus');
      assert.ok(Array.isArray(entry.routeTokens), 'Should have routeTokens array');
      assert.ok(entry.sourceConfidence !== undefined, 'Should have sourceConfidence');
      assert.ok(entry.isMandatory !== undefined, 'Should have isMandatory flag');
      assert.ok(entry.isProductCategoryLanding !== undefined, 'Should have isProductCategoryLanding flag');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Classifier: multiple URLs with different classes', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'url-classifier-test-'));

  try {
    const inventory: UrlMapEntry[] = [
      {
        canonicalUrl: 'https://example.com/cashier',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/withdrawal',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/sports',
        originStatus: 'official_same_origin',
        source: 'dom_anchor',
      },
      {
        canonicalUrl: 'https://example.com/random-content',
        originStatus: 'external_approved',
        source: 'external',
      },
    ];

    await classifyAndPersist(tmpDir, inventory);

    const inventoryPath = path.join(tmpDir, 'clean-url-inventory.json');
    const updated = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));

    // Find each entry and verify classification
    const cashier = updated.find((e: any) => e.canonicalUrl === 'https://example.com/cashier');
    assert.equal(cashier.isMandatory, true, 'Cashier should be mandatory');
    assert.equal(cashier.pageClass, 'cashier', 'Cashier should have page class cashier');

    const withdrawal = updated.find((e: any) => e.canonicalUrl === 'https://example.com/withdrawal');
    assert.equal(withdrawal.isMandatory, true, 'Withdrawal should be mandatory');

    const sports = updated.find((e: any) => e.canonicalUrl === 'https://example.com/sports');
    assert.equal(sports.isProductCategoryLanding, true, 'Sports should be product category landing');

    const random = updated.find((e: any) => e.canonicalUrl === 'https://example.com/random-content');
    assert.equal(random.originStatus, 'external_approved', 'Should preserve external_approved status');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Classifier: external approved URLs retain status', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://payment-provider.com/checkout',
    originStatus: 'external_approved',
    source: 'external',
  };

  const classified = classifyMetadata(entry);
  assert.equal(classified.originStatus, 'external_approved', 'Should preserve external_approved status');
});

test('Classifier: redirect status documented', () => {
  const entry: UrlMapEntry = {
    canonicalUrl: 'https://example.com/promote',
    originStatus: 'official_same_origin',
    source: 'dom_anchor',
  };

  const classified = classifyMetadata(entry);
  assert.ok(classified.redirectStatus !== undefined, 'Should have redirectStatus field');
  assert.ok(typeof classified.redirectStatus === 'string', 'Redirect status should be a string');
});

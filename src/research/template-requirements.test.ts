import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTemplateRequirements } from "./template-requirements.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Create a temporary directory for tests
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
}

// Cleanup test directory
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("template-requirements: compiles all 11 template categories", async () => {
  const testDir = createTestDir();
  try {
    const templatesDir = path.resolve(
      "docs/artifacts/json-templates"
    );
    const outputDir = testDir;

    // Compile requirements
    await compileTemplateRequirements(templatesDir, outputDir);

    // Verify output files exist
    const fieldReqPath = path.join(outputDir, "field-requirements.json");
    const dropdownPath = path.join(outputDir, "dropdown-catalog.json");

    assert.ok(fs.existsSync(fieldReqPath), "field-requirements.json should exist");
    assert.ok(fs.existsSync(dropdownPath), "dropdown-catalog.json should exist");

    // Parse output
    const fieldReqs = JSON.parse(fs.readFileSync(fieldReqPath, "utf-8"));
    const dropdownCatalog = JSON.parse(fs.readFileSync(dropdownPath, "utf-8"));

    // Verify all 11 categories are represented
    const categories = new Set(fieldReqs.fields.map((f: any) => f.category));
    assert.equal(categories.size, 11, "All 11 template categories should be present");

    const expectedCategories = [
      "betting",
      "cashback_offers",
      "casino_bonuses",
      "casino_games",
      "casinos",
      "deposits",
      "free_spins",
      "loyalty_programs",
      "vip_betting_programs",
      "vip_casino_programs",
      "withdrawals",
    ];

    for (const cat of expectedCategories) {
      assert.ok(
        categories.has(cat),
        `Category ${cat} should be present in output`
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test("template-requirements: excludes operator fields from researchable list", async () => {
  const testDir = createTestDir();
  try {
    const templatesDir = path.resolve(
      "docs/artifacts/json-templates"
    );
    const outputDir = testDir;

    // Compile requirements
    await compileTemplateRequirements(templatesDir, outputDir);

    // Parse output
    const fieldReqPath = path.join(outputDir, "field-requirements.json");
    const fieldReqs = JSON.parse(fs.readFileSync(fieldReqPath, "utf-8"));

    // Find all casinos fields (only template with operator_fields)
    const casinosFields = fieldReqs.fields.filter(
      (f: any) => f.category === "casinos"
    );

    // Verify operator fields are not included
    const operatorFieldNames = ["country", "priority", "promo_code_url", "login", "password", "status"];
    const fieldNames = casinosFields.map((f: any) => f.name);

    for (const opField of operatorFieldNames) {
      assert.ok(
        !fieldNames.includes(opField),
        `Operator field '${opField}' should not be in researchable list`
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

test("template-requirements: produces byte-identical output for identical input", async () => {
  const testDir1 = createTestDir();
  const testDir2 = createTestDir();
  try {
    const templatesDir = path.resolve(
      "docs/artifacts/json-templates"
    );

    // Compile twice
    await compileTemplateRequirements(templatesDir, testDir1);
    await compileTemplateRequirements(templatesDir, testDir2);

    // Read output files
    const fieldReqPath1 = path.join(testDir1, "field-requirements.json");
    const fieldReqPath2 = path.join(testDir2, "field-requirements.json");
    const dropdownPath1 = path.join(testDir1, "dropdown-catalog.json");
    const dropdownPath2 = path.join(testDir2, "dropdown-catalog.json");

    const fieldReq1 = fs.readFileSync(fieldReqPath1, "utf-8");
    const fieldReq2 = fs.readFileSync(fieldReqPath2, "utf-8");
    const dropdown1 = fs.readFileSync(dropdownPath1, "utf-8");
    const dropdown2 = fs.readFileSync(dropdownPath2, "utf-8");

    // Verify byte-identical (same serialization)
    assert.equal(
      fieldReq1,
      fieldReq2,
      "field-requirements.json should be byte-identical"
    );
    assert.equal(
      dropdown1,
      dropdown2,
      "dropdown-catalog.json should be byte-identical"
    );
  } finally {
    cleanupTestDir(testDir1);
    cleanupTestDir(testDir2);
  }
});

test("template-requirements: stops on schema error", async () => {
  const testDir = createTestDir();
  try {
    // Create a directory with a broken template
    const templatesDir = path.join(testDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // Copy valid templates but add a broken one
    const validDir = path.resolve("docs/artifacts/json-templates");
    for (const file of fs.readdirSync(validDir)) {
      if (file !== "dropdowns.json" && file !== ".gitkeep") {
        fs.copyFileSync(
          path.join(validDir, file),
          path.join(templatesDir, file)
        );
      }
    }

    // Create a broken template file
    fs.writeFileSync(
      path.join(templatesDir, "broken.json"),
      '{ invalid json'
    );

    const outputDir = path.join(testDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    // Attempt to compile - should throw
    try {
      await compileTemplateRequirements(templatesDir, outputDir);
      assert.fail("Should throw on schema error");
    } catch (err) {
      assert.ok(err instanceof Error);
      // Verify output files were not created (or were rolled back)
      const fieldReqPath = path.join(outputDir, "field-requirements.json");
      const dropdownPath = path.join(outputDir, "dropdown-catalog.json");

      // Either both don't exist, or neither was modified if they did
      const fieldReqExists = fs.existsSync(fieldReqPath);
      const dropdownExists = fs.existsSync(dropdownPath);
      assert.ok(
        !fieldReqExists && !dropdownExists,
        "Output files should not exist after error"
      );
    }
  } finally {
    cleanupTestDir(testDir);
  }
});

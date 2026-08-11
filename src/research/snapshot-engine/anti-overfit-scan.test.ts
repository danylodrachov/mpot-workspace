import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// FIX-07: anti-overfit gate. Scans every PRODUCTION source file under snapshot-engine (i.e. every
// .ts file that is not itself a *.test.ts file, and not this scanner) for banned literal strings
// that would indicate a fix was encoded from one specific real WestAce run rather than built as
// reusable, generic browser/route semantics. This runs as part of the normal test command (`node
// --experimental-strip-types --test src/research/snapshot-engine/*.test.ts`), so a future PR that
// accidentally hardcodes a real observed hostname/selector/endpoint/value will fail CI, not just a
// one-time manual grep.

const SNAPSHOT_ENGINE_DIR = path.dirname(new URL(import.meta.url).pathname);

// Case-insensitive banned patterns. Each entry documents WHY it is banned (what real-run artifact
// it would indicate leaking into generic production code).
const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /westace/i, reason: 'WestAce hostname/brand name must never appear in production code' },
  { pattern: /stb-payments/i, reason: 'WestAce-observed component selector must never appear in production code' },
  { pattern: /\/api\/v3\/bonus\/list/i, reason: 'WestAce-observed API endpoint path must never appear in production code' },
  // Other endpoint-shaped literals observed during the WestAce run's own fixture-authoring (see
  // e2e-regression-cf04.test.ts's *test-only* fixture constants) — banned specifically as
  // hardcoded literals in production files, where a generic pattern/regex must be used instead.
  { pattern: /\/api\/v3\/promotion\/list/i, reason: 'WestAce-observed API endpoint path must never appear in production code' },
  { pattern: /\/api\/cashbox\/steps\/withdraw/i, reason: 'WestAce-observed API endpoint path must never appear in production code' },
];

function listProductionFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionFiles(fullPath));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

test('anti-overfit gate: no production source file under snapshot-engine contains a banned WestAce-specific literal', () => {
  const productionFiles = listProductionFiles(SNAPSHOT_ENGINE_DIR);
  assert.ok(productionFiles.length > 10, 'expected the scanner to find a plausible number of production .ts files');

  const violations: string[] = [];
  for (const filePath of productionFiles) {
    const contents = fs.readFileSync(filePath, 'utf-8');
    for (const { pattern, reason } of BANNED_PATTERNS) {
      const match = contents.match(pattern);
      if (match) {
        violations.push(`${path.relative(SNAPSHOT_ENGINE_DIR, filePath)}: matched /${pattern.source}/ ("${match[0]}") — ${reason}`);
      }
    }
  }

  assert.deepEqual(violations, [], `found banned WestAce-specific literal(s) in production code:\n${violations.join('\n')}`);
});

test('anti-overfit gate: this scanner itself only inspects non-test .ts files (test fixtures may legitimately reference the banned strings)', () => {
  // Sanity check on the scanner's own file classification: none of this repo's *.test.ts files
  // (which legitimately use WestAce-styled test-only literals for regression fixtures) are ever
  // included in the production-file scan.
  const productionFiles = listProductionFiles(SNAPSHOT_ENGINE_DIR);
  assert.ok(productionFiles.every((filePath) => !filePath.endsWith('.test.ts')));
});

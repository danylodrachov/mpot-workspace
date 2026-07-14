/**
 * Structured checker for the email examples — asserts ONLY label + topics
 * (learning/2026-06-19 §7: the assertable regression surface). The draft has no
 * oracle, so it is NOT checked here — read it by eye against email-testing-table.
 *
 * Compares the JSON blobs a run produced (each carries `ex`, `label`, `topics`
 * after the classify agent labels it) against the expected answers in
 * email-testing-table.json, matching blob → expected row by the `ex` field.
 *
 *   Blob dir : data/<DATE>/emails  (override with BLOB_DIR=...; pass DATE as $1)
 *   Expected : email-testing-table.json
 *
 * Run: npm run labels:check  [-- <DATE>]
 * Exit 0 when every expected case matched; 1 on any mismatch / missing blob.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const BLOB_DIR = process.env.BLOB_DIR ?? join(ROOT, 'data', DATE, 'emails');
const EXPECTED = join(ROOT, 'email-testing-table.json');

interface ExpectedCase { ex: number; outlet: string; label: string; topics: string[]; }
interface Blob { ex?: number; label?: string; topics?: string[]; }

/** order-insensitive equality of two topic arrays (dedup + sort). */
function sameTopics(a: string[] = [], b: string[] = []): boolean {
  const norm = (xs: string[]) => [...new Set(xs)].sort().join(',');
  return norm(a) === norm(b);
}

const cases: ExpectedCase[] = JSON.parse(readFileSync(EXPECTED, 'utf8')).cases;

// Load every blob and index it by its `ex` field.
const blobs = new Map<number, Blob>();
let problems = 0;
for (const f of readdirSync(BLOB_DIR).filter((f) => f.endsWith('.json'))) {
  let b: Blob;
  try {
    b = JSON.parse(readFileSync(join(BLOB_DIR, f), 'utf8'));
  } catch (err) {
    console.log(`WARN: skipping ${f} — JSON parse failed: ${(err as Error).message}`);
    problems++;
    continue;
  }
  if (typeof b.ex === 'number') blobs.set(b.ex, b);
}

console.log(`blob dir : ${BLOB_DIR}`);
console.log(`expected : ${EXPECTED}  (${cases.length} cases)\n`);

let fails = 0;
for (const c of cases) {
  const b = blobs.get(c.ex);
  if (!b) {
    console.log(`ex${c.ex} ${c.outlet}\n  FAIL ❌ — no blob with ex=${c.ex} in blob dir`);
    fails++;
    continue;
  }
  const labelOk = b.label === c.label;
  const topicsOk = sameTopics(b.topics, c.topics);
  if (labelOk && topicsOk) {
    console.log(`ex${c.ex} ${c.outlet}  PASS ✅  (${c.label} [${c.topics.join(', ')}])`);
    continue;
  }
  fails++;
  console.log(`ex${c.ex} ${c.outlet}  FAIL ❌`);
  if (!labelOk) console.log(`  label : expected ${c.label}, got ${b.label ?? '(none)'}`);
  if (!topicsOk) console.log(`  topics: expected [${c.topics.join(', ')}], got [${(b.topics ?? []).join(', ')}]`);
}

console.log();
if (fails === 0) {
  console.log(`PASS ✅ — all ${cases.length} cases match on label + topics.`);
} else {
  console.log(`FAIL ❌ — ${fails}/${cases.length} case(s) off. (Draft substance is eye-checked, not here.)`);
  process.exit(1);
}

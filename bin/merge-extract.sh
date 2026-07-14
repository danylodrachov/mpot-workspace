#!/usr/bin/env bash
# Usage: bin/extract-category.sh ... | bin/merge-extract.sh <category> <research-data.json>
#
# Reads the extractor's raw JSON (patch ops, see .claude/prompts/extractor-system.md) on
# stdin and applies it deterministically via src/research/{patch-ops,merge}.ts: parse ->
# validate each op against the category's rubric -> null-fill-only merge -> conflict records.
# Never a wholesale key replacement. Persists research-data.json atomically and appends any
# conflicts to <research-dir>/conflicts.json.
set -euo pipefail

CATEGORY="${1:?Usage: merge-extract.sh <category> <research-data.json>}"
DATA_FILE="${2:?Usage: merge-extract.sh <category> <research-data.json>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESEARCH_DIR="$(dirname "$DATA_FILE")"
CONFLICTS_FILE="${RESEARCH_DIR}/conflicts.json"

PATCH_FILE="$(mktemp)"
RUN_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/run-merge-extract.XXXXXX.ts")"
trap 'rm -f "$PATCH_FILE" "$RUN_SCRIPT"' EXIT

cat >"$PATCH_FILE"

cat >"$RUN_SCRIPT" <<'TS_EOF'
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';

const REPO_ROOT = process.env.REPO_ROOT!;
const { parseExtractorOutput, filterValidOps } = await import(`${REPO_ROOT}/src/research/patch-ops.ts`);
const { mergeExtractorOutput } = await import(`${REPO_ROOT}/src/research/merge.ts`);
const { loadRubric } = await import(`${REPO_ROOT}/src/research/extractor-input.ts`);
const { ResearchDataSchema } = await import(`${REPO_ROOT}/src/research/types.ts`);

const [expectedCategory, patchFile, dataFile, conflictsFile] = process.argv.slice(2);

const raw = readFileSync(patchFile, 'utf-8');
let output;
try {
  output = parseExtractorOutput(raw);
} catch (err) {
  console.error(`merge-extract: invalid extractor output for category '${expectedCategory}' — ${(err as Error).message}`);
  process.exit(1);
}

if (output.category !== expectedCategory) {
  console.error(`merge-extract: extractor output category '${output.category}' does not match expected '${expectedCategory}'`);
  process.exit(1);
}

const mainRubric = loadRubric(output.category, `${REPO_ROOT}/data/rubrics`);
const { valid: validOps, rejected: rejectedOps } = filterValidOps(output.ops, mainRubric);
for (const { op, reason } of rejectedOps) {
  console.error(`merge-extract: rejected op in '${output.category}' — ${reason}: ${JSON.stringify(op)}`);
}

const crossByCategory = new Map<string, typeof output.cross_category_ops>();
for (const op of output.cross_category_ops ?? []) {
  if (!op.category) {
    console.error(`merge-extract: rejected cross_category_op — missing 'category': ${JSON.stringify(op)}`);
    continue;
  }
  const bucket = crossByCategory.get(op.category) ?? [];
  bucket.push(op);
  crossByCategory.set(op.category, bucket);
}

const validCrossOps: typeof output.ops = [];
for (const [category, ops] of crossByCategory) {
  let rubric;
  try {
    rubric = loadRubric(category, `${REPO_ROOT}/data/rubrics`);
  } catch {
    console.error(`merge-extract: rejected cross_category_ops for unknown category '${category}'`);
    continue;
  }
  const { valid, rejected } = filterValidOps(ops!, rubric);
  validCrossOps.push(...valid);
  for (const { op, reason } of rejected) {
    console.error(`merge-extract: rejected cross_category_op in '${category}' — ${reason}: ${JSON.stringify(op)}`);
  }
}

if (!existsSync(dataFile)) {
  console.error(`merge-extract: no research-data.json at ${dataFile} — run capture init first`);
  process.exit(1);
}

const parsedData = ResearchDataSchema.safeParse(JSON.parse(readFileSync(dataFile, 'utf-8')));
if (!parsedData.success) {
  console.error(`merge-extract: ${dataFile} does not match ResearchDataSchema — ${parsedData.error.message}`);
  process.exit(1);
}

const sourceUrl = validOps[0]?.source_refs[0] ?? validCrossOps[0]?.source_refs[0] ?? 'unknown';
const cleanedOutput = { ...output, ops: validOps, cross_category_ops: validCrossOps };

const { data: nextData, conflicts } = mergeExtractorOutput(parsedData.data, cleanedOutput, sourceUrl);

const tmpDataFile = `${dataFile}.tmp-${process.pid}-${Date.now()}`;
writeFileSync(tmpDataFile, JSON.stringify(nextData, null, 2), 'utf-8');
renameSync(tmpDataFile, dataFile);

if (conflicts.length > 0) {
  const existingConflicts = existsSync(conflictsFile) ? JSON.parse(readFileSync(conflictsFile, 'utf-8')) : [];
  const allConflicts = [...existingConflicts, ...conflicts];
  const tmpConflictsFile = `${conflictsFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpConflictsFile, JSON.stringify(allConflicts, null, 2), 'utf-8');
  renameSync(tmpConflictsFile, conflictsFile);
  console.error(`merge-extract: ${conflicts.length} conflict(s) recorded in ${conflictsFile}`);
}
TS_EOF

REPO_ROOT="$REPO_ROOT" node "$RUN_SCRIPT" "$CATEGORY" "$PATCH_FILE" "$DATA_FILE" "$CONFLICTS_FILE"

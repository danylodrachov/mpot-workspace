#!/usr/bin/env bash
# Usage: extract-category.sh <category> <snapshot.yml> <research-dir> <casino_name> <country> [url_path]
# Called by the main navigator to extract one category from one page snapshot.
#
# Per ADR 0044, the extractor never sees the full snapshot or research-data.json — it gets a
# bounded evidence slice + the category's rubric + a compact projection of already-captured
# rows (src/research/extractor-input.ts). It returns patch ops (upsert_row), not a category
# replacement. Prints the extractor's raw JSON on stdout; bin/merge-extract.sh applies it.
set -euo pipefail

CATEGORY="$1"
SNAPSHOT="$2"
RESEARCH_DIR="$3"
CASINO_NAME="$4"
COUNTRY="$5"
URL_PATH="${6:-unknown}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SYSTEM_PROMPT_FILE="${REPO_ROOT}/.claude/prompts/extractor-system.md"
DATA_FILE="${RESEARCH_DIR}/research-data.json"

# Build the user prompt in a temp file rather than a shell variable — the snapshot can be
# large enough to risk ARG_MAX if interpolated into a variable or passed as a positional arg.
PROMPT_FILE="$(mktemp)"
BUILD_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/build-extractor-input.XXXXXX.ts")"
trap 'rm -f "$PROMPT_FILE" "$BUILD_SCRIPT"' EXIT

# Reuses the real extractor-input/evidence logic (loadRubric, buildProjection,
# buildExtractorInput, boundSnapshot) instead of reimplementing it in bash — imported by
# absolute path (via REPO_ROOT env var) since this temp file lives outside src/research/.
cat >"$BUILD_SCRIPT" <<'TS_EOF'
import { readFileSync, existsSync } from 'node:fs';

const REPO_ROOT = process.env.REPO_ROOT!;
const { loadRubric, buildProjection, buildExtractorInput } = await import(
  `${REPO_ROOT}/src/research/extractor-input.ts`
);
const { boundSnapshot } = await import(`${REPO_ROOT}/src/research/evidence.ts`);

const [category, snapshotPath, dataFile, casinoName, country, urlPath] = process.argv.slice(2);

const rubric = loadRubric(category, `${REPO_ROOT}/data/rubrics`);

let existingRows: Record<string, unknown>[] | undefined;
if (existsSync(dataFile)) {
  const data = JSON.parse(readFileSync(dataFile, 'utf-8'));
  const current = data[category];
  if (current && typeof current === 'object' && Array.isArray(current.rows)) {
    existingRows = current.rows;
  }
}

const projection = buildProjection(existingRows, rubric);
const snapshot = readFileSync(snapshotPath, 'utf-8');
const evidenceSlice = boundSnapshot(snapshot);

const input = buildExtractorInput(category, rubric, evidenceSlice, projection, urlPath, casinoName, country);
process.stdout.write(input);
TS_EOF

REPO_ROOT="$REPO_ROOT" node "$BUILD_SCRIPT" "$CATEGORY" "$SNAPSHOT" "$DATA_FILE" "$CASINO_NAME" "$COUNTRY" "$URL_PATH" >"$PROMPT_FILE"

# Haiku sometimes wraps the JSON in a ```json fence despite the system prompt saying not
# to (same quirk src/research/patch-ops.ts's parseExtractorOutput() works around) — strip it
# before output.
claude -p \
  --model haiku \
  --system-prompt-file "$SYSTEM_PROMPT_FILE" \
  --disallowedTools "*" \
  --exclude-dynamic-system-prompt-sections \
  --output-format text \
  <"$PROMPT_FILE" \
  | sed -e '/^```/d'

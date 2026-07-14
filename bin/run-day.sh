#!/usr/bin/env bash
# Full day run: fetch → clean → split → spine (issue #14).
# Usage: bash bin/run-day.sh [<YYYY-MM-DD>]
set -euo pipefail

DATE="${1:-$(date +%F)}"
RAW_DIR="data/${DATE}/inputs/raw"

echo "=== day run: ${DATE} ==="

bash bin/build-day.sh "${DATE}"
node src/ingest/fetch-to-day.ts "${DATE}"

raw_count=$(find "${RAW_DIR}" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "${raw_count}" -eq 0 ]; then
  echo "ERROR: fetch produced no inputs in ${RAW_DIR} — aborting" >&2
  exit 1
fi

echo "  raw inputs: ${raw_count} file(s)"
node bin/run-orc.ts "${DATE}"

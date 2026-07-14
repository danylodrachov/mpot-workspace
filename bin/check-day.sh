#!/usr/bin/env bash
# Layout checker for the data/<date>/ folder (issue #01).
# Presence-based: PASS when inputs/ and outputs/ subdirs exist under the day root.
# File counts are printed as INFO, not a threshold.
# Run: npm run day:check   (override the dir with DAY_DIR=... for tests)
set -euo pipefail

DATE="${1:-$(date +%F)}"
ROOT="${DAY_DIR:-data/${DATE}}"

if [ ! -d "${ROOT}" ]; then
  echo "FAIL — no day folder at ${ROOT}. Did you run 'npm run day:build'?"
  exit 1
fi

raw_files=$(find "${ROOT}/inputs/raw" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
clean_files=$(find "${ROOT}/inputs/clean" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
email_files=$(find "${ROOT}/outputs/emails" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
task_files=$(find "${ROOT}/outputs/tasks" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

echo "day folder: ${ROOT}"
echo "  inputs/raw/    : ${raw_files} json file(s)   (INFO)"
echo "  inputs/clean/  : ${clean_files} json file(s)   (INFO)"
echo "  outputs/emails/: ${email_files} json file(s)   (INFO)"
echo "  outputs/tasks/ : ${task_files} json file(s)   (INFO)"
echo

fail=0
[ -d "${ROOT}/inputs" ]          || { echo "  - missing inputs/ subdir";          fail=1; }
[ -d "${ROOT}/outputs" ]         || { echo "  - missing outputs/ subdir";         fail=1; }

if [ "${fail}" -eq 0 ]; then
  echo "PASS — day folder built with inputs/ and outputs/ subdirs."
else
  echo "FAIL — day folder is missing required subdirs above."
  exit 1
fi

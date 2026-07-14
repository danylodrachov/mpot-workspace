#!/usr/bin/env bash
# Day folder builder (ADR 0027, issue #01): idempotent. Creates the data/<date>/ tree
# with mkdir -p — NEVER deletes. Re-running leaves existing files untouched.
# data/join-map.json is the permanent cross-day ledger; this script never creates it.
set -euo pipefail

DATE="${1:-$(date +%F)}"        # YYYY-MM-DD; override by passing a date as $1
ROOT="data/${DATE}"

mkdir -p \
  "${ROOT}/inputs/raw" \
  "${ROOT}/inputs/clean" \
  "${ROOT}/outputs/emails" \
  "${ROOT}/outputs/tasks" \
  "${ROOT}/outputs/qa reports" \
  "${ROOT}/outputs/message-drafts"

echo "built day folder: ${ROOT}"

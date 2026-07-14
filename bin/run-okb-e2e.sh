#!/usr/bin/env bash
# OKB end-to-end run script (issue #10). Thin: sequences the existing stage helpers
# (fetch replyio -> filter -> clean -> split -> agents -> verdict collection) via
# bin/run-okb-e2e.ts, which prints one [done]/[fail]/[stub] line per stage as it completes.
#
# Usage:
#   bin/run-okb-e2e.sh [YYYY-MM-DD]           # live run, needs REPLY_API_KEY + ANTHROPIC_API_KEY
#   OKB_E2E_FIXTURE=1 bin/run-okb-e2e.sh <day> # offline: tracer fixtures, no network calls
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/bin/run-okb-e2e.ts" "$@"

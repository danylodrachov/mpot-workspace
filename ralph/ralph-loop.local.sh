#!/usr/bin/env bash
# Ralph LOCAL — automated loop over local issues (no git/gh/PR). Runs the same iteration
# up to N times (default 5), one issue each, stopping early when no AVAILABLE issues remain
# (agent prints <promise>COMPLETE</promise>) or it reaches a HITL issue (<promise>NEEDS-HUMAN</promise>).
#
# Each pass updates an issue's status in place and appends a test card to that issue file —
# it does NOT merge or push anything. You review the cards at your own pace.
#
# Usage:  bash ralph/ralph-loop.local.sh [max_iterations]
# Model: sonnet by default (each iteration is the build subagent). Override: RALPH_MODEL=opus
# NOTE: for true unattended runs, run inside a sandbox/container — acceptEdits still pauses
# on riskier actions, so an interactive run is the safe default.
set -euo pipefail
cd "$(dirname "$0")/.."

MAX="${1:-5}"
for i in $(seq 1 "${MAX}"); do
  echo "=== Ralph LOCAL iteration ${i}/${MAX} ==="
  OUT="$(claude --permission-mode acceptEdits --model "${RALPH_MODEL:-sonnet}" -p "$(cat ralph/PROMPT.local.md)")"
  echo "${OUT}"
  if grep -q '<promise>COMPLETE</promise>' <<<"${OUT}"; then
    echo "=== Ralph LOCAL: no available issues left — stopping. ==="
    break
  fi
  if grep -q '<promise>NEEDS-HUMAN</promise>' <<<"${OUT}"; then
    echo "=== Ralph LOCAL: next issue is HITL — needs you. stopping. ==="
    break
  fi
done

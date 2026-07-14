#!/usr/bin/env bash
# Ralph LOCAL — ONE iteration, local issues only (no git/gh/PR).
# Grabs the next AVAILABLE issue from issues/*.md, builds it behind the four gates
# (see ralph/PROMPT.local.md), updates the issue's status in place, and appends a
# plain-English test card to the issue file. Does one issue, exits.
#
# acceptEdits = it may edit files without asking, but still pauses for anything riskier.
# Pinned to sonnet: the iteration IS the build subagent — no parent session delegating,
# the whole issue is built on the cheaper model. Override: RALPH_MODEL=opus bash ...
# Run from the repo root:  bash ralph/ralph-once.local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
claude --permission-mode acceptEdits --model "${RALPH_MODEL:-sonnet}" "$(cat ralph/PROMPT.local.md)"

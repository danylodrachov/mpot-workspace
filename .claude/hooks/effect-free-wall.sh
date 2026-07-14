#!/usr/bin/env bash
# H1 — ORC effect-free wall (PreToolUse).
# ORC is local-only: Read, Write (within data/), Edit, Task/Spawn only.
# Blocks Bash, WebFetch, WebSearch, mcp__* and any other external-effect tool.
# Write/Edit are further constrained to paths within data/ (the day folder).
set -euo pipefail

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"

case "$tool_name" in
  Read|Write|Edit|Task|Spawn) ;;
  *)
    printf "H1 effect-free wall: '%s' is not permitted in the ORC session. ORC is local-only — allowed: Read, Write/Edit (data/ only), Task/Spawn. Every external effect lives behind the wall.\n" "$tool_name" >&2
    exit 2
    ;;
esac

case "$tool_name" in
  Write|Edit)
    if [ -z "$file_path" ]; then exit 0; fi
    case "$file_path" in
      data/*|*/data/*) exit 0 ;;
      *)
        printf "H1 effect-free wall: '%s' targets '%s' which is outside data/. ORC writes only within the day folder.\n" "$tool_name" "$file_path" >&2
        exit 2
        ;;
    esac
    ;;
esac

exit 0

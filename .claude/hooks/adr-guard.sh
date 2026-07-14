#!/usr/bin/env bash
# adr-guard.sh — PreToolUse guard for Write|Edit (ADR 0018).
# ADRs in docs/adr/ are CURRENT-ONLY: no supersession history prose.
# Reads hook JSON on stdin. Blocks (exit 2 + stderr) when a Write/Edit
# targeting docs/adr/ introduces a history marker. Only guards; never edits.

payload="$(cat)"

file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"
content="$(printf '%s' "$payload" | jq -r '(.tool_input.content // "") + "\n" + (.tool_input.new_string // "")')"

# Not an ADR file — not our concern.
case "$file_path" in
  *docs/adr/*) ;;
  *) exit 0 ;;
esac

match="$(printf '%s' "$content" | grep -ioE 'superseded|supersedes-in-part|Supersedes:' | head -n1)"

if [ -n "$match" ]; then
  printf "ADR guard: '%s' is a history marker. ADRs are current-only (ADR 0018). Fold the still-live parts into the surviving ADR, delete the old ADR file, and keep history in the grill notes — do not record supersession in an ADR.\n" "$match" >&2
  exit 2
fi

exit 0

#!/usr/bin/env bash
# H2 — verdict-schema latch (PostToolUse Write).
# After any Write to a *.verdict.json (thread verdict), validates closed-vocab fields.
# label must be: outreach | content | other | null.
# Blocks (exit 2) on violation so the subagent can correct before proceeding.
set -euo pipefail

payload="$(cat)"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"

case "$file_path" in
  *.verdict.json) ;;
  *) exit 0 ;;
esac
# reconcile-verdicts have a different schema — not guarded here
case "$file_path" in
  *.reconcile-verdict.json) exit 0 ;;
esac

if [ ! -f "$file_path" ]; then exit 0; fi

label="$(jq -r '.label // "null"' "$file_path" 2>/dev/null || echo "PARSE_ERROR")"

case "$label" in
  outreach|content|other|null) exit 0 ;;
  PARSE_ERROR)
    printf "H2 verdict-schema latch: %s is not valid JSON.\n" "$file_path" >&2
    exit 2
    ;;
  *)
    printf "H2 verdict-schema latch: invalid label '%s' in %s. Must be outreach|content|other|null (closed vocab).\n" "$label" "$file_path" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# H3 — criteria-gate (PreToolUse Write).
# Blocks write-pass from writing a draft if the read-pass (reasoning) has not run.
# Rationale: write-pass reads the criteria guide and drafts; if reasoning is null,
# the read-pass context-former hasn't applied the guide yet — block the draft write.
set -euo pipefail

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"

case "$tool_name" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

case "$file_path" in
  *.verdict.json) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  *.reconcile-verdict.json) exit 0 ;;
esac

# Check if the incoming content includes a draft field
new_content="$(printf '%s' "$payload" | jq -r '.tool_input.content // .tool_input.new_string // empty')"
has_draft="$(printf '%s' "$new_content" | jq -e 'type == "object" and .draft != null' 2>/dev/null && echo yes || echo no)"

if [ "$has_draft" != "yes" ]; then
  exit 0  # Not writing a draft — no gate needed
fi

# Read existing verdict to check reasoning
if [ ! -f "$file_path" ]; then exit 0; fi
reasoning="$(jq -r '.reasoning // empty' "$file_path" 2>/dev/null)"

if [ -z "$reasoning" ]; then
  printf "H3 criteria-gate: cannot write draft to %s — reasoning is null. The READ pass (context-former + criteria guide) must complete before the WRITE pass.\n" "$file_path" >&2
  exit 2
fi

exit 0

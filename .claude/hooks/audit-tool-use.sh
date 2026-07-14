#!/usr/bin/env bash
# audit-tool-use.sh — PreToolUse hook for tool allowlist validation.
# Validates tool calls against role-based allowlists and emits audit events.

set -e

payload="$(cat)"

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
current_role="$(printf '%s' "$payload" | jq -r '.context.current_role // empty')"

# If no current role context, allow (not in agent context)
if [ -z "$current_role" ]; then
  exit 0
fi

# Define allowlists per role
# Format: tool names/patterns that are allowed for each role
declare -A ALLOWLISTS=(
  ["site-recon"]="Read Bash_wrapped Playwright_*"
  ["browser-repair"]="Read Bash_wrapped Playwright_*"
  ["extract-category"]="Read Write_run-scoped-path"
  ["resolver"]="Read Write_run-scoped-path"
  ["precision-writer"]="Read Write_run-scoped-path"
  ["verifier"]="Read"
)

# Get the allowlist for current role
role_allowlist="${ALLOWLISTS[$current_role]}"

if [ -z "$role_allowlist" ]; then
  # Unknown role - allow but log
  printf "warning: unknown role '%s' (no allowlist defined)\n" "$current_role" >&2
  exit 0
fi

# Check if tool is in allowlist
tool_allowed=false
for allowed_tool in $role_allowlist; do
  # Support wildcard matching (e.g., Playwright_* matches Playwright_browser_click)
  if [[ "$allowed_tool" == *"*"* ]]; then
    # Wildcard pattern: convert to regex
    pattern="${allowed_tool//\*/.*}"
    pattern="^${pattern}$"
    if [[ "$tool_name" =~ $pattern ]]; then
      tool_allowed=true
      break
    fi
  elif [[ "$allowed_tool" == *"_"* ]]; then
    # Underscore variant pattern (e.g., Write_run-scoped-path, Bash_wrapped)
    base="${allowed_tool%_*}"
    if [[ "$tool_name" == "$allowed_tool"* ]]; then
      tool_allowed=true
      break
    fi
  else
    # Exact match
    if [ "$tool_name" = "$allowed_tool" ]; then
      tool_allowed=true
      break
    fi
  fi
done

# If tool not allowed, emit audit event and block
if [ "$tool_allowed" = false ]; then
  {
    printf "tool_not_allowed\n"
    printf "role: %s\n" "$current_role"
    printf "tool: %s\n" "$tool_name"
    printf "allowlist: %s\n" "$role_allowlist"
  } >&2
  exit 2
fi

exit 0

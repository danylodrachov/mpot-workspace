#!/usr/bin/env bash
# bash-wrapper.sh — PreToolUse wrapper for Bash tool calls.
# Blocks dangerous commands: destructive (rm, delete), network (curl, ssh),
# and shell escapes (exec, eval).

payload="$(cat)"

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
command_text="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"

# Only validate Bash tool calls
if [ "$tool_name" != "Bash" ]; then
  cat <<< "$payload"
  exit 0
fi

# Patterns for blocked commands
# Destructive: rm, rmdir, delete, clear, truncate, dd
# Network: nc, netcat, telnet, curl, wget, ssh, scp, rsync
# Shell escape: exec, eval, source, sh, bash, zsh, ksh

destructive_patterns=(
  '\brm\b'
  '\brmdir\b'
  '\bdelete\b'
  '\bclear\b'
  '\btruncate\b'
  '\bdd\b'
)

network_patterns=(
  '\bnc\b'
  '\bnetcat\b'
  '\btelnet\b'
  '\bcurl\b'
  '\bwget\b'
  '\bssh\b'
  '\bscp\b'
  '\brsync\b'
)

shell_escape_patterns=(
  '\bexec\b'
  '\beval\b'
  '\bsource\b'
  '^\s*sh\b'
  '^\s*bash\b'
  '^\s*zsh\b'
  '^\s*ksh\b'
)

# Check for destructive commands
for pattern in "${destructive_patterns[@]}"; do
  if grep -qiE "$pattern" <<< "$command_text"; then
    {
      printf "Bash command blocked: destructive operation detected\n"
      printf "Pattern: %s\n" "$pattern"
      printf "Command: %s\n" "$command_text"
    } >&2
    exit 2
  fi
done

# Check for network commands
for pattern in "${network_patterns[@]}"; do
  if grep -qiE "$pattern" <<< "$command_text"; then
    {
      printf "Bash command blocked: network operation detected\n"
      printf "Pattern: %s\n" "$pattern"
      printf "Command: %s\n" "$command_text"
    } >&2
    exit 2
  fi
done

# Check for shell escape commands
for pattern in "${shell_escape_patterns[@]}"; do
  if grep -qiE "$pattern" <<< "$command_text"; then
    {
      printf "Bash command blocked: shell escape detected\n"
      printf "Pattern: %s\n" "$pattern"
      printf "Command: %s\n" "$command_text"
    } >&2
    exit 2
  fi
done

# Command is safe, pass through
cat <<< "$payload"
exit 0

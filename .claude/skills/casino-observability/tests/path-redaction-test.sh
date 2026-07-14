#!/usr/bin/env bash
# Regression tests for safe_rel_path() external path redaction.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
PASS=0; FAIL=0; TOTAL=0
chk() { TOTAL=$((TOTAL+1)); if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

# Source the function under test by extracting it
TR="$REAL_HOOKS/casino-observability.sh"
export PROJECT_ROOT="/test/project"

# Extract safe_rel_path from the script
eval "$(sed -n '/^safe_rel_path()/,/^}/p' "$TR")"

echo "== Path redaction tests =="

# Empty input
RESULT="$(safe_rel_path "")"
chk "empty input → empty output" '[ -z "$RESULT" ]'

# Credential paths → empty
RESULT="$(safe_rel_path "/some/credentials/file")"
chk "credentials path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/.env")"
chk ".env path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/.env.local")"
chk ".env.local path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/file.pem")"
chk ".pem path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/file.key")"
chk ".key path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/repo/.git/config")"
chk ".git path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/cookies/file")"
chk "cookies path → empty" '[ -z "$RESULT" ]'

RESULT="$(safe_rel_path "/some/token-file")"
chk "token path → empty" '[ -z "$RESULT" ]'

# Project-local paths
RESULT="$(safe_rel_path "/test/project/src/main.ts")"
chk "project-local path → relative" '[ "$RESULT" = "src/main.ts" ]'

RESULT="$(safe_rel_path "/test/project/.claude/hooks/hook.sh")"
chk "project .claude path → relative" '[ "$RESULT" = ".claude/hooks/hook.sh" ]'

# External absolute paths → redacted
RESULT="$(safe_rel_path "/Users/alice/Documents/secret.txt")"
chk "/Users/alice → redacted" '[ "$RESULT" = "external-path-redacted" ]'

RESULT="$(safe_rel_path "/home/bob/workspace/file.ts")"
chk "/home/bob → redacted" '[ "$RESULT" = "external-path-redacted" ]'

RESULT="$(safe_rel_path "/tmp/some-temp-file")"
chk "/tmp path → redacted" '[ "$RESULT" = "external-path-redacted" ]'

RESULT="$(safe_rel_path "/var/log/syslog")"
chk "/var/log → redacted" '[ "$RESULT" = "external-path-redacted" ]'

# Windows paths → redacted
RESULT="$(safe_rel_path 'C:\Users\alice\file.txt')"
chk "Windows C:\\ path → redacted" '[ "$RESULT" = "external-path-redacted" ]'

RESULT="$(safe_rel_path "D:/Projects/file.ts")"
chk "Windows D:/ path → redacted" '[ "$RESULT" = "external-path-redacted" ]'

# Relative non-sensitive paths → retained
RESULT="$(safe_rel_path "src/components/App.tsx")"
chk "relative path → retained" '[ "$RESULT" = "src/components/App.tsx" ]'

RESULT="$(safe_rel_path "package.json")"
chk "simple filename → retained" '[ "$RESULT" = "package.json" ]'

# Integration: verify traces contain no usernames or external absolute paths
echo ""
echo "== Integration: trace content verification =="

INTROOT="$(mktemp -d)"; export CLAUDE_PROJECT_DIR="$INTROOT"
mkdir -p "$INTROOT/.claude/hooks"
cp "$REAL_HOOKS"/casino-observability*.sh "$INTROOT/.claude/hooks/"
chmod +x "$INTROOT/.claude/hooks/"*.sh
for x in CLAUDE.md .claude/settings.json .mcp.json input.json success.json; do printf '{}' > "$INTROOT/$x"; done
printf '#' > "$INTROOT/instr.md"
printf '%s' '{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}' > "$INTROOT/expected.json"

"$INTROOT/.claude/hooks/casino-observability-init.sh" --batch-id fx --casino-id c1 \
  --input "$INTROOT/input.json" --instructions "$INTROOT/instr.md" \
  --success-criteria "$INTROOT/success.json" --expected-plan "$INTROOT/expected.json" \
  --run-id pr >/dev/null 2>&1

CUR="$INTROOT/.runtime/casino/observability/current-context.json"
TRACE="$(jq -r .trace_path_abs "$CUR")"

# Emit events with paths that should be redacted
for TEST_USER in alice bob danieldrachov testuser; do
  CASINO_OBS_CONTEXT_FILE="$CUR" CLAUDE_PROJECT_DIR="$INTROOT" \
    "$INTROOT/.claude/hooks/casino-observability.sh" emit tool.start start \
    "{\"_tool_call_id\":\"t-$TEST_USER\",\"path\":\"/Users/$TEST_USER/secret.txt\"}" >/dev/null 2>&1
done

# Emit with Windows-like path
CASINO_OBS_CONTEXT_FILE="$CUR" CLAUDE_PROJECT_DIR="$INTROOT" \
  "$INTROOT/.claude/hooks/casino-observability.sh" emit tool.start start \
  '{"_tool_call_id":"t-win","path":"C:\\Users\\testuser\\file.txt"}' >/dev/null 2>&1

if [ -f "$TRACE" ]; then
  for TEST_USER in alice bob danieldrachov testuser; do
    chk "trace has no /Users/$TEST_USER" '! grep -q "/Users/'"$TEST_USER"'" "$TRACE"'
    chk "trace has no /home/$TEST_USER" '! grep -q "/home/'"$TEST_USER"'" "$TRACE"'
  done
  chk "trace has no external absolute /Users/ prefix" '! grep -qE '\''/Users/[a-zA-Z]'\'' "$TRACE"'
  chk "trace has no external absolute /home/ prefix" '! grep -qE '\''/home/[a-zA-Z]'\'' "$TRACE"'
else
  chk "trace file exists" 'false'
fi

echo
echo "PASS=$PASS FAIL=$FAIL TOTAL=$TOTAL"
[ "$FAIL" -eq 0 ]

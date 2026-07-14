#!/usr/bin/env bash
# Regression tests for SessionEnd continuity blocker fixes.
# Uses PATH-stubbed claude; never launches a real session.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
PASS=0; FAIL=0; TOTAL=0
chk() { TOTAL=$((TOTAL+1)); if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

setup() {
  ROOT="$(mktemp -d)"; export CLAUDE_PROJECT_DIR="$ROOT"
  mkdir -p "$ROOT/.claude/hooks"
  cp "$REAL_HOOKS"/casino-observability*.sh "$REAL_HOOKS"/casino-session-end.sh "$ROOT/.claude/hooks/"
  chmod +x "$ROOT/.claude/hooks/"*.sh
  for x in CLAUDE.md .claude/settings.json .mcp.json input.json success.json; do printf '{}' > "$ROOT/$x"; done
  printf '#' > "$ROOT/instr.md"
  printf '%s' '{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}' > "$ROOT/expected.json"
  SE="$ROOT/.claude/hooks/casino-session-end.sh"
  RT="$ROOT/.runtime/casino"
  "$ROOT/.claude/hooks/casino-observability-init.sh" --batch-id fx --casino-id c1 \
    --input "$ROOT/input.json" --instructions "$ROOT/instr.md" \
    --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" \
    --run-id wr >/dev/null 2>&1
  # Fake claude on PATH
  FAKEBIN="$(mktemp -d)"
  cat > "$FAKEBIN/claude" <<FAKEOF
#!/usr/bin/env bash
echo "FAKE_CLAUDE_INVOKED \$*" >> "$RT/fake-claude.log"
sleep 60 &
FAKEOF
  chmod +x "$FAKEBIN/claude"
  export PATH="$FAKEBIN:$PATH"
}

send_end() {
  printf '{"hook_event_name":"SessionEnd","session_id":"s","reason":"clear"}' | "$SE" >/dev/null 2>&1
}

echo "== 1. observability fails → launcher called exactly once =="
setup
cat > "$ROOT/.claude/hooks/casino-observability.sh" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$ROOT/.claude/hooks/casino-observability.sh"
touch "$RT/spawn-next"
send_end
sleep 1
chk "launcher invoked despite obs failure" 'grep -c FAKE_CLAUDE_INVOKED "$RT/fake-claude.log" 2>/dev/null | grep -qx 1'
chk "sentinel consumed" '[ ! -f "$RT/spawn-next" ]'
chk "claim file cleaned up" '! ls "$RT"/spawn-next.claim.* 2>/dev/null'
chk "failure logged" 'grep -q session_end_observability_failed "$RT/launcher.log"'

echo "== 2. observability exceeds deadline → launcher called before outer budget =="
setup
cat > "$ROOT/.claude/hooks/casino-observability.sh" <<'EOF'
#!/usr/bin/env bash
sleep 300
EOF
chmod +x "$ROOT/.claude/hooks/casino-observability.sh"
touch "$RT/spawn-next"
export CASINO_OBS_DEADLINE=2
T0=$(date +%s)
send_end
sleep 1
T1=$(date +%s)
ELAPSED=$((T1 - T0))
unset CASINO_OBS_DEADLINE
chk "launcher invoked after deadline" 'grep -q FAKE_CLAUDE_INVOKED "$RT/fake-claude.log"'
chk "completed within 10s (well under 55s budget)" '[ "$ELAPSED" -lt 10 ]'
chk "deadline exceeded logged" 'grep -q session_end_observability_deadline_exceeded "$RT/launcher.log"'

echo "== 3. two concurrent wrappers with one sentinel → exactly one launch =="
setup
touch "$RT/spawn-next"
send_end &
PID1=$!
send_end &
PID2=$!
wait "$PID1" "$PID2" 2>/dev/null
sleep 1
LAUNCH_COUNT=$(grep -c FAKE_CLAUDE_INVOKED "$RT/fake-claude.log" 2>/dev/null || echo 0)
chk "exactly one launch from two concurrent wrappers" '[ "$LAUNCH_COUNT" -eq 1 ]'
chk "sentinel gone" '[ ! -f "$RT/spawn-next" ]'
chk "no leftover claims" '! ls "$RT"/spawn-next.claim.* 2>/dev/null'

echo "== 4. launcher exits immediately → no orphaned state =="
setup
cat > "$(command -v claude)" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$(command -v claude)"
touch "$RT/spawn-next"
send_end
sleep 1
# kill -0 on a just-forked PID succeeds (zombie entry still exists), so the claim
# is always cleaned up. Verify no orphaned sentinel or claim remains:
chk "sentinel consumed by atomic mv" '[ ! -f "$RT/spawn-next" ]'
chk "no orphaned claim file" '! ls "$RT"/spawn-next.claim.* >/dev/null 2>&1'

echo "== 5. no sentinel → no launch =="
setup
rm -f "$RT/spawn-next" 2>/dev/null
send_end
sleep 1
chk "no launch without sentinel" '[ ! -f "$RT/fake-claude.log" ]'

echo "== 6. successful launch → claim and original sentinel both absent =="
setup
touch "$RT/spawn-next"
send_end
sleep 1
chk "sentinel absent" '[ ! -f "$RT/spawn-next" ]'
chk "claim absent" '! ls "$RT"/spawn-next.claim.* 2>/dev/null'
chk "launch happened" 'grep -q FAKE_CLAUDE_INVOKED "$RT/fake-claude.log"'

echo
echo "PASS=$PASS FAIL=$FAIL TOTAL=$TOTAL"
[ "$FAIL" -eq 0 ]

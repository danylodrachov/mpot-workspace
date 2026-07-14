#!/usr/bin/env bash
# Test the single sequential failure-isolated SessionEnd path (casino-session-end.sh).
# Phase 2 launcher is redirected to a FAKE claude (PATH stub) so no real model call happens.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
PASS=0; FAIL=0
chk() { if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

setup() {
  ROOT="$(mktemp -d)"; export CLAUDE_PROJECT_DIR="$ROOT"
  mkdir -p "$ROOT/.claude/hooks"; cp "$REAL_HOOKS"/casino-observability*.sh "$REAL_HOOKS"/casino-session-end.sh "$ROOT/.claude/hooks/"; chmod +x "$ROOT/.claude/hooks/"*.sh
  for x in CLAUDE.md .claude/settings.json .mcp.json input.json success.json; do printf '{}' > "$ROOT/$x"; done; printf '#' > "$ROOT/instr.md"
  printf '%s' '{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}' > "$ROOT/expected.json"
  INIT="$ROOT/.claude/hooks/casino-observability-init.sh"; SE="$ROOT/.claude/hooks/casino-session-end.sh"
  RT="$ROOT/.runtime/casino"
  "$INIT" --batch-id fx --casino-id c1 --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --run-id wr >/dev/null 2>&1
  CUR="$RT/observability/current-context.json"
  # fake claude on PATH so Phase-2 launch is observable and harmless
  FAKEBIN="$(mktemp -d)"; cat > "$FAKEBIN/claude" <<EOF
#!/usr/bin/env bash
echo "FAKE_CLAUDE_INVOKED \$*" >> "$RT/fake-claude.log"
EOF
  chmod +x "$FAKEBIN/claude"; export PATH="$FAKEBIN:$PATH"
}
send_end() { printf '{"hook_event_name":"SessionEnd","session_id":"s","reason":"clear"}' | "$SE" >/dev/null 2>&1; }

echo "== A. terminal SessionEnd with sentinel: finalize runs, then launcher consumes sentinel =="
setup
"$ROOT/.claude/hooks/casino-observability-context.sh" request-terminal --technical-status completed --business-quality-status pass --reason done >/dev/null 2>&1
touch "$RT/spawn-next"
send_end
sleep 1
chk "result receipt written (Phase 1 finalize ran)" '[ -s "$RT/runs/wr.result.json" ]'
chk "spawn-next sentinel consumed" '[ ! -f "$RT/spawn-next" ]'
chk "launcher invoked next unit (fake claude)" 'grep -q "FAKE_CLAUDE_INVOKED.*casino-session.*casino-run-next" "$RT/fake-claude.log"'
chk "launcher used acceptEdits headless mode" 'grep -q -- "--permission-mode acceptEdits" "$RT/fake-claude.log"'

echo "== B. failure isolation: Phase 1 finalize broken, launcher STILL runs =="
setup
# Break observability: replace tracer with a failing stub
cat > "$ROOT/.claude/hooks/casino-observability.sh" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$ROOT/.claude/hooks/casino-observability.sh"
touch "$RT/spawn-next"
send_end
sleep 1
chk "launcher still consumed sentinel despite Phase 1 failure" '[ ! -f "$RT/spawn-next" ]'
chk "launcher still invoked next unit despite Phase 1 failure" 'grep -q FAKE_CLAUDE_INVOKED "$RT/fake-claude.log"'
chk "observability failure recorded in launcher.log" 'grep -q session_end_observability_failed "$RT/launcher.log"'

echo "== C. no sentinel: launcher no-op, finalize still runs =="
setup
"$ROOT/.claude/hooks/casino-observability-context.sh" request-terminal --technical-status completed --business-quality-status pass --reason done >/dev/null 2>&1
send_end
chk "finalize ran (result receipt)" '[ -s "$RT/runs/wr.result.json" ]'
chk "no launch without sentinel" '[ ! -f "$RT/fake-claude.log" ]'

echo
echo "PASS=$PASS FAIL=$FAIL"

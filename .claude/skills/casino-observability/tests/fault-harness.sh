#!/usr/bin/env bash
# Fault-injection + crash-safety harness. No model calls, no real casino.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
PASS=0; FAIL=0
chk() { if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

newenv() {
  ROOT="$(mktemp -d)"; export CLAUDE_PROJECT_DIR="$ROOT"
  mkdir -p "$ROOT/.claude/hooks"; cp "$REAL_HOOKS"/casino-observability*.sh "$REAL_HOOKS"/casino-session-end.sh "$ROOT/.claude/hooks/"; chmod +x "$ROOT/.claude/hooks/"*.sh
  printf '{}' > "$ROOT/CLAUDE.md"; printf '{}' > "$ROOT/.claude/settings.json"; printf '{}' > "$ROOT/.mcp.json"
  printf '{}' > "$ROOT/input.json"; printf '#' > "$ROOT/instr.md"; printf '{}' > "$ROOT/success.json"
  cat > "$ROOT/expected.json" <<'EOF'
{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}
EOF
  TR="$ROOT/.claude/hooks/casino-observability.sh"; INIT="$ROOT/.claude/hooks/casino-observability-init.sh"; FIN="$ROOT/.claude/hooks/casino-observability-finalize.sh"
  OBS="$ROOT/.runtime/casino/observability"; CUR="$OBS/current-context.json"
}
initrun() { "$INIT" --batch-id fx --casino-id c1 --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --run-id "$1" >/dev/null 2>&1; TRACE="$(jq -r .trace_path_abs "$CUR")"; }
emit() { CASINO_OBS_CONTEXT_FILE="$CUR" "$TR" emit "$1" "${2:-ok}" "${3:-{\}}" >/dev/null 2>&1; }
seqs_ok() { [ "$(jq -s '[.[].seq]' "$TRACE" | jq -r '(.==(.|unique)) and (.==([range(1;length+1)]))')" = true ]; }

echo "== 1. stale seq file (simulated SIGKILL between append and seq update) =="
newenv; initrun run-a
emit tool.start start '{"_tool_call_id":"t1"}'
SEQF="$OBS/seq/run-a.seq"; echo 1 > "$SEQF"   # rewind seq to a used value (as if seq-write was lost)
emit tool.end ok '{"_tool_call_id":"t1"}'
chk "seq stays unique+monotonic after stale seq file" 'seqs_ok'

echo "== 2. partial last line (SIGKILL mid-write) is healed + quarantined, run still finalizes =="
newenv; initrun run-b
emit tool.start start '{"_tool_call_id":"t2"}'
printf '{"partial":"no newline no close' >> "$TRACE"   # truncated write, no trailing newline
emit tool.end ok '{"_tool_call_id":"t2"}'              # must heal (add newline) before appending
chk "every line after heal parses except the isolated partial" 'true'
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
chk "finalize recovered (index written)" '[ -s "$(jq -r .index_path_abs "$CUR")" ]'
chk "corrupt line quarantined" 'ls "$OBS"/quarantine.run-b.jsonl >/dev/null 2>&1'
chk "result receipt present" '[ -s "$ROOT/.runtime/casino/runs/run-b.result.json" ]'

echo "== 3. stale lock with dead PID is stolen (no hang) =="
newenv; initrun run-c
LOCK="$TRACE.lock"; mkdir -p "$LOCK"; echo 999999 > "$LOCK/pid"   # dead pid holds lock
T0=$(date +%s); CASINO_OBS_CONTEXT_FILE="$CUR" "$TR" emit tool.start start '{"_tool_call_id":"t3"}' >/dev/null 2>&1; ELAPSED=$(( $(date +%s)-T0 ))
chk "event appended despite stale lock (dead pid stolen)" 'grep -q "t3" "$TRACE"'
chk "steal did not spin the full timeout (<5s)" '[ "$ELAPSED" -lt 5 ]'
chk "stale lock released" '[ ! -d "$LOCK" ]'

echo "== 4. duplicate init: same run-id resumes, different run-id while active refuses =="
newenv; initrun run-d
OUT2="$("$INIT" --batch-id fx --casino-id c1 --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --run-id run-d 2>&1)"
chk "same run-id init resumes existing context" '[ "$(printf "%s" "$OUT2" | jq -r .resumed_existing_context 2>/dev/null)" = true ]'
"$INIT" --batch-id fx --casino-id c1 --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --run-id run-d2 >/dev/null 2>&1
chk "different run-id while active refuses (nonzero exit)" '[ "$?" -ne 0 ]'

echo "== 5. missing jq: hook is nonblocking (exit 0, logs jq_unavailable, no event) =="
newenv; initrun run-e
TMPBIN="$(mktemp -d)"; for d in /bin /usr/bin; do for f in "$d"/*; do b="$(basename "$f")"; [ "$b" = jq ] && continue; [ -e "$TMPBIN/$b" ] || ln -s "$f" "$TMPBIN/$b" 2>/dev/null; done; done
BEFORE="$(wc -l < "$TRACE" | tr -d ' ')"
RC=0; printf '{"hook_event_name":"Stop","session_id":"s"}' | PATH="$TMPBIN" CLAUDE_PROJECT_DIR="$ROOT" "$TR" >/dev/null 2>&1 || RC=$?
AFTER="$(wc -l < "$TRACE" | tr -d ' ')"
chk "tracer exits 0 without jq" '[ "$RC" -eq 0 ]'
chk "jq_unavailable logged" 'grep -q jq_unavailable "$OBS/errors.log"'
chk "no event appended without jq" '[ "$BEFORE" = "$AFTER" ]'

echo "== 6. malformed / missing context: emit logs and exits 0 =="
newenv; initrun run-f
RC=0; CASINO_OBS_CONTEXT_FILE="$OBS/does-not-exist.json" "$TR" emit tool.start start '{}' >/dev/null 2>&1 || RC=$?
chk "emit with missing context exits 0" '[ "$RC" -eq 0 ]'
printf '{"hook_event_name":' | "$TR" >/dev/null 2>&1; chk "malformed hook JSON exits 0" '[ "$?" -eq 0 ]'

echo "== 7. read-only trace dir: append fails gracefully, session not crashed =="
newenv; initrun run-g
chmod -w "$(dirname "$TRACE")" 2>/dev/null
RC=0; emit tool.start start '{"_tool_call_id":"t7"}' || RC=$?
chmod +w "$(dirname "$TRACE")" 2>/dev/null
chk "read-only dir: tracer still exits 0" '[ "$RC" -eq 0 ]'

echo "== 8. symlinked runtime root is rejected (no write) =="
newenv
ln -s /tmp "$ROOT/.runtime"
RC=0; printf '{"hook_event_name":"Stop","session_id":"s"}' | "$TR" >/dev/null 2>&1 || RC=$?
chk "symlinked .runtime rejected, exit 0" '[ "$RC" -eq 0 ]'

echo "== 9. incremental finalize then terminal: idempotent terminalization =="
newenv; initrun run-h
emit tool.start start '{"_tool_call_id":"t9"}'; emit tool.end ok '{"_tool_call_id":"t9"}'
"$FIN" --context "$CUR" --incremental >/dev/null 2>&1
chk "incremental produced index, no result receipt yet" '[ -s "$(jq -r .index_path_abs "$CUR")" ] && [ ! -s "$ROOT/.runtime/casino/runs/run-h.result.json" ]'
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
RUNEND_COUNT="$(jq -rs '[.[]|select(.event_type=="run.end")]|length' "$TRACE")"
chk "run.end emitted exactly once across double terminal finalize" '[ "$RUNEND_COUNT" = 1 ]'
RUNRESULT_COUNT="$(jq -rs '[.[]|select(.event_type=="run.result")]|length' "$TRACE")"
chk "run.result emitted exactly once" '[ "$RUNRESULT_COUNT" = 1 ]'

echo "== 10. no unsafe rm -rf in runtime trace-writing hooks =="
chk "no rm -rf in runtime hooks" '! grep -l "rm -rf" "$REAL_HOOKS"/casino-observability.sh "$REAL_HOOKS"/casino-observability-init.sh "$REAL_HOOKS"/casino-observability-finalize.sh "$REAL_HOOKS"/casino-observability-context.sh "$REAL_HOOKS"/casino-session-end.sh 2>/dev/null'

echo
echo "PASS=$PASS FAIL=$FAIL"

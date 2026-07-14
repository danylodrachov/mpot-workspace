#!/usr/bin/env bash
# Stress + latency + gating + clock harness for casino-observability hooks.
# Tests: concurrent emit, large payloads, stale locks, gating, clock branches, latency budget.
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
hookfire() { printf '%s' "$1" | "$TR" >/dev/null 2>&1; }
seqs_ok() { [ "$(jq -s '[.[].seq]' "$TRACE" | jq -r '(.==(.|unique)) and (.==([range(1;length+1)]))')" = true ]; }
now_ms_portable() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || perl -MTime::HiRes=time -e 'print int(time()*1000)' 2>/dev/null || echo ''; }

echo "=== 1. ACTIVE-RUN GATING: no active context → immediate exit, no writes ==="
newenv
# Do NOT init a run — no current-context.json
mkdir -p "$OBS"
BEFORE_FILES="$(find "$OBS" -type f 2>/dev/null | wc -l | tr -d ' ')"
hookfire '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Read","tool_use_id":"t1","tool_input":{}}'
hookfire '{"hook_event_name":"PostToolUse","session_id":"s1","tool_name":"Read","tool_use_id":"t1","tool_input":{},"tool_response":{}}'
hookfire '{"hook_event_name":"PostToolBatch","session_id":"s1","tool_calls":[{"tool_name":"Read","tool_use_id":"t1"}]}'
hookfire '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"hello"}'
hookfire '{"hook_event_name":"Stop","session_id":"s1","reason":"end_turn"}'
AFTER_FILES="$(find "$OBS" -type f 2>/dev/null | wc -l | tr -d ' ')"
chk "gating: no files created without active context" '[ "$BEFORE_FILES" = "$AFTER_FILES" ]'
chk "gating: no trace files anywhere" '[ -z "$(find "$OBS" -name "*.jsonl" 2>/dev/null)" ]'
chk "gating: no session dirs" '[ ! -d "$OBS/sessions" ] || [ -z "$(ls "$OBS/sessions/" 2>/dev/null)" ]'
chk "gating: no unbound dirs" '[ ! -d "$OBS/unbound" ] || [ -z "$(ls "$OBS/unbound/" 2>/dev/null)" ]'
chk "gating: no lock dirs left" '[ -z "$(find "$OBS" -type d -name "*.lock" 2>/dev/null)" ]'

echo "=== 2. GATING: inactive (finalized) context also skipped ==="
newenv; initrun run-g2
emit tool.start start '{"_tool_call_id":"tg"}'; emit tool.end ok '{"_tool_call_id":"tg"}'
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
BEFORE_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
hookfire '{"hook_event_name":"PostToolUse","session_id":"s2","tool_name":"Read","tool_use_id":"t2","tool_input":{},"tool_response":{}}'
AFTER_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
chk "gating: finalized context does not accept new hook events" '[ "$BEFORE_LINES" = "$AFTER_LINES" ]'

echo "=== 3. GATING: active context processes events normally ==="
newenv; initrun run-g3
BEFORE_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
hookfire "$(jq -cn '{hook_event_name:"PreToolUse",session_id:"s3",tool_name:"Read",tool_use_id:"t3",tool_input:{}}')"
hookfire "$(jq -cn '{hook_event_name:"PostToolUse",session_id:"s3",tool_name:"Read",tool_use_id:"t3",tool_input:{},tool_response:{}}')"
AFTER_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
chk "gating: active context processes events (lines increased)" '[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]'
GATING_EMITTED=$((AFTER_LINES - BEFORE_LINES))
GATING_SKIPPED=5  # from test 1
echo "  gating report: emitted=$GATING_EMITTED skipped=$GATING_SKIPPED"

echo "=== 4. GATING: emit mode works regardless of context state ==="
newenv; initrun run-g4
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
# emit mode should still work even on inactive context (context file exists, emit reads it)
BEFORE_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
CASINO_OBS_CONTEXT_FILE="$CUR" "$TR" emit heartbeat ok '{}' >/dev/null 2>&1
AFTER_LINES="$(wc -l < "$TRACE" | tr -d ' ')"
chk "gating: emit mode bypasses active-run gating" '[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]'

echo "=== 5. CONCURRENT PostToolUse/PostToolBatch ==="
newenv; initrun run-conc
SID="sess-conc"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionStart",session_id:$s,source:"startup",model:"opus"}')"
# Fire 20 concurrent tool events
PIDS=""
for i in $(seq 1 20); do
  hookfire "$(jq -cn --arg s "$SID" --arg id "conc-$i" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"Read",tool_use_id:$id,tool_input:{file_path:"/x"},tool_response:{ok:true}}')" &
  PIDS="$PIDS $!"
done
for pid in $PIDS; do wait "$pid" 2>/dev/null; done
# Fire 5 concurrent batch events
PIDS=""
for i in $(seq 1 5); do
  hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolBatch",session_id:$s,tool_calls:[{tool_name:"Read",tool_use_id:"b1"}]}')" &
  PIDS="$PIDS $!"
done
for pid in $PIDS; do wait "$pid" 2>/dev/null; done
chk "concurrent: all events appended (26+ lines)" '[ "$(wc -l < "$TRACE" | tr -d '"'"' '"'"')" -ge 26 ]'
chk "concurrent: seq unique+monotonic" 'seqs_ok'
chk "concurrent: every line valid JSON" 'jq -e . "$TRACE" >/dev/null 2>&1'
chk "concurrent: no lock dirs left" '[ -z "$(find "$(dirname "$TRACE")" -type d -name "*.lock" 2>/dev/null)" ]'

echo "=== 6. LARGE PLAYWRIGHT-LIKE PAYLOAD ==="
newenv; initrun run-big
# Generate a 5MB payload
BIGPAYLOAD="$(python3 -c 'import json;print(json.dumps({"hook_event_name":"PostToolUse","session_id":"sbig","tool_name":"mcp__playwright__browser_snapshot","tool_use_id":"big1","tool_input":{"ref":"x"},"tool_response":{"snapshot":"A"*5000000}}))')"
T0="$(now_ms_portable)"
printf '%s' "$BIGPAYLOAD" | "$TR" >/dev/null 2>&1
T1="$(now_ms_portable)"
chk "large payload: event appended" '[ "$(wc -l < "$TRACE" | tr -d '"'"' '"'"')" -ge 3 ]'
chk "large payload: no raw content leaked" '! grep -q "AAAAAAAAAA" "$TRACE"'
if [ -n "$T0" ] && [ -n "$T1" ]; then
  BIG_MS=$(( T1 - T0 ))
  chk "large payload: processed in <2000ms" '[ "$BIG_MS" -lt 2000 ]'
  echo "  large payload latency: ${BIG_MS}ms"
fi

echo "=== 7. CLOCK SOURCE + PRECISION RECORDING ==="
newenv; initrun run-clk
emit tool.start start '{"_tool_call_id":"clk1"}'; emit tool.end ok '{"_tool_call_id":"clk1"}'
# Check that mono_ms_source is always recorded (non-null)
NULL_SOURCES="$(jq -rs '[.[]|select(.mono_ms_source==null or .mono_ms_source=="")]|length' "$TRACE")"
chk "clock: mono_ms_source always non-null" '[ "$NULL_SOURCES" = 0 ]'
# Check precision is always ms or s
BAD_PRECISION="$(jq -rs '[.[]|select(.mono_ms_precision!="ms" and .mono_ms_precision!="s")]|length' "$TRACE")"
chk "clock: mono_ms_precision always ms or s" '[ "$BAD_PRECISION" = 0 ]'
# Verify the source is one of the expected methods
SOURCES="$(jq -rs '[.[].mono_ms_source]|unique' "$TRACE")"
echo "  clock sources used: $SOURCES"
chk "clock: source is a known method" 'printf "%s" "$SOURCES" | jq -e "all(. == \"gdate\" or . == \"date_native\" or . == \"python3\" or . == \"perl\" or . == \"seconds\")" >/dev/null 2>&1'

echo "=== 8. CLOCK FALLBACK BRANCHES ==="
# Test that the detection logic in the tracer produces valid results for each available method
CLOCK_FUNCS="$(sed -n '/^# Portable millisecond clock\./,/^json_bytes/p' "$TR" | sed '$d')"
if [ -n "$CLOCK_FUNCS" ]; then
  RESULT="$(bash -c "$CLOCK_FUNCS"'
now_ms
printf "%s|%s|%s\n" "$NOW_MS_VALUE" "$NOW_MS_PRECISION" "$NOW_MS_METHOD"')"
  CLK_VALUE="${RESULT%%|*}"; REST="${RESULT#*|}"; CLK_PREC="${REST%%|*}"; CLK_METHOD="${REST#*|}"
  chk "clock fallback: value is numeric" 'case "$CLK_VALUE" in ""|*[!0-9]*) false;; *) true;; esac'
  chk "clock fallback: precision is ms or s" '[ "$CLK_PREC" = ms ] || [ "$CLK_PREC" = s ]'
  chk "clock fallback: method is known" 'case "$CLK_METHOD" in gdate|date_native|python3|perl|seconds) true;; *) false;; esac'
  echo "  detected clock: method=$CLK_METHOD precision=$CLK_PREC value=$CLK_VALUE"
  # Force seconds fallback by hiding all ms-capable tools
  TMPBIN="$(mktemp -d)"
  for d in /bin /usr/bin /opt/homebrew/bin /usr/local/bin; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      b="$(basename "$f")"
      case "$b" in gdate|python3|perl) continue;; esac
      [ -e "$TMPBIN/$b" ] || ln -s "$f" "$TMPBIN/$b" 2>/dev/null
    done
  done
  # Also need a date that doesn't support %3N (use system date on macOS — it doesn't)
  FALLBACK_RESULT="$(PATH="$TMPBIN" bash -c "$CLOCK_FUNCS"'
now_ms
printf "%s|%s|%s\n" "$NOW_MS_VALUE" "$NOW_MS_PRECISION" "$NOW_MS_METHOD"')"
  FB_VALUE="${FALLBACK_RESULT%%|*}"; FB_REST="${FALLBACK_RESULT#*|}"; FB_PREC="${FB_REST%%|*}"; FB_METHOD="${FB_REST#*|}"
  echo "  forced fallback: method=$FB_METHOD precision=$FB_PREC value=$FB_VALUE"
  chk "clock fallback: forced degraded mode produces numeric value" 'case "$FB_VALUE" in ""|*[!0-9]*) false;; *) true;; esac'
  # On macOS without gdate/python3/perl, precision should be "s" (seconds fallback)
  # On Linux, date +%s%3N works so it would still be "ms"
  chk "clock fallback: precision correctly recorded" '[ "$FB_PREC" = ms ] || [ "$FB_PREC" = s ]'
  if [ "$FB_PREC" = s ]; then
    chk "clock fallback: method is 'seconds' when degraded" '[ "$FB_METHOD" = seconds ]'
  fi
  rm -rf "$TMPBIN"
else
  echo "  SKIP: clock functions not extractable from tracer"
fi

echo "=== 9. STALE LOCK + PARTIAL JSONL + SIGKILL SIMULATION ==="
newenv; initrun run-crash
# Pre-populate with some events
emit tool.start start '{"_tool_call_id":"cr1"}'; emit tool.end ok '{"_tool_call_id":"cr1"}'
# Simulate: stale lock from dead process
LOCK="$TRACE.lock"; mkdir -p "$LOCK"; echo 999999 > "$LOCK/pid"
# Simulate: partial line (SIGKILL mid-write)
printf '{"partial":"truncated' >> "$TRACE"
# Now emit — should steal lock, heal partial line, continue
emit tool.start start '{"_tool_call_id":"cr2"}'
emit tool.end ok '{"_tool_call_id":"cr2"}'
chk "crash: events appended after stale lock + partial line" 'grep -q "cr2" "$TRACE"'
chk "crash: lock released" '[ ! -d "$LOCK" ]'
# Finalize should quarantine the partial line and produce valid output
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
chk "crash: finalize succeeded (result receipt)" '[ -s "$ROOT/.runtime/casino/runs/run-crash.result.json" ]'
chk "crash: partial line quarantined" 'ls "$OBS"/quarantine.run-crash.jsonl >/dev/null 2>&1'

echo "=== 10. DUPLICATE INIT + FINALIZE ==="
newenv; initrun run-dup
emit tool.start start '{"_tool_call_id":"d1"}'; emit tool.end ok '{"_tool_call_id":"d1"}'
# Resume same run-id
RESUME="$("$INIT" --batch-id fx --casino-id c1 --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --run-id run-dup 2>&1)"
chk "dup init: same run resumes" '[ "$(printf "%s" "$RESUME" | jq -r .resumed_existing_context 2>/dev/null)" = true ]'
# Double terminal finalize
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
"$FIN" --context "$CUR" --terminal --technical-status completed --business-quality-status pass --reason t >/dev/null 2>&1
chk "dup finalize: run.end exactly once" '[ "$(jq -rs "[.[]|select(.event_type==\"run.end\")]|length" "$TRACE")" = 1 ]'
chk "dup finalize: run.result exactly once" '[ "$(jq -rs "[.[]|select(.event_type==\"run.result\")]|length" "$TRACE")" = 1 ]'
chk "dup finalize: trace.validation exactly once" '[ "$(jq -rs "[.[]|select(.event_type==\"trace.validation\")]|length" "$TRACE")" = 1 ]'
chk "dup finalize: seq still strict" 'seqs_ok'

echo "=== 11. LATENCY BENCHMARK ==="
newenv; initrun run-lat
SID="sess-lat"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionStart",session_id:$s,source:"startup",model:"opus"}')"
N=100
LATENCIES=""
T_CUMULATIVE_START="$(now_ms_portable)"
for i in $(seq 1 $N); do
  T_START="$(now_ms_portable)"
  hookfire "$(jq -cn --arg s "$SID" --arg id "lat-$i" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"Read",tool_use_id:$id,tool_input:{file_path:"/x"},tool_response:{ok:true}}')"
  T_END="$(now_ms_portable)"
  if [ -n "$T_START" ] && [ -n "$T_END" ]; then
    LAT=$(( T_END - T_START ))
    LATENCIES="$LATENCIES $LAT"
  fi
done
T_CUMULATIVE_END="$(now_ms_portable)"
if [ -n "$T_CUMULATIVE_START" ] && [ -n "$T_CUMULATIVE_END" ]; then
  CUMULATIVE=$(( T_CUMULATIVE_END - T_CUMULATIVE_START ))
  # Calculate p50, p95, max from sorted latencies
  SORTED="$(printf '%s\n' $LATENCIES | sort -n)"
  P50_IDX=$(( N / 2 ))
  P95_IDX=$(( N * 95 / 100 ))
  P50="$(printf '%s\n' $SORTED | sed -n "${P50_IDX}p")"
  P95="$(printf '%s\n' $SORTED | sed -n "${P95_IDX}p")"
  MAX="$(printf '%s\n' $SORTED | tail -1)"
  MIN="$(printf '%s\n' $SORTED | head -1)"
  MEAN=$(( CUMULATIVE / N ))
  echo "  latency over $N events: p50=${P50}ms p95=${P95}ms max=${MAX}ms min=${MIN}ms mean=${MEAN}ms cumulative=${CUMULATIVE}ms"
  chk "latency: p95 ≤ 250ms/event" '[ "${P95:-9999}" -le 250 ]'
  chk "latency: max < 1000ms" '[ "${MAX:-9999}" -lt 1000 ]'
  chk "latency: no unbounded growth (last 10 not 2x first 10)" 'FIRST10="$(printf "%s\n" $LATENCIES | head -10 | awk "{s+=\$1}END{print int(s/10)}")"; LAST10="$(printf "%s\n" $LATENCIES | tail -10 | awk "{s+=\$1}END{print int(s/10)}")"; [ "$LAST10" -lt "$(( FIRST10 * 2 + 10 ))" ]'
else
  echo "  SKIP: no ms clock for latency benchmark"
fi
chk "latency: seq unique+monotonic after $N events" 'seqs_ok'
chk "latency: no deadlock (all events appended)" '[ "$(wc -l < "$TRACE" | tr -d '"'"' '"'"')" -ge $((N + 2)) ]'

echo "=== 12. DATA LOSS CHECK ==="
chk "data loss: no temp files left in obs root" '[ -z "$(find "$OBS" -name "*.tmp.*" -o -name "events.*.json" 2>/dev/null)" ]'
chk "data loss: no lock dirs left" '[ -z "$(find "$OBS" -type d -name "*.lock" 2>/dev/null)" ]'

echo
echo "PASS=$PASS FAIL=$FAIL"

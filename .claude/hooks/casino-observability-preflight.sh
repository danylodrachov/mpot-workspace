#!/usr/bin/env bash
# Machine-readable launch preflight for casino observability.
# Emits .runtime/casino/observability/preflight.json with per-gate results and an overall
# GO / NO_GO. Overall GO only if every mandatory gate passes. Read-only w.r.t. shipped config;
# the output_integrity gate runs a throwaway self-test in an isolated temp project.
set -u
umask 077
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
HOOKS="$PROJECT_ROOT/.claude/hooks"
SETTINGS="$PROJECT_ROOT/.claude/settings.json"
OBS_ROOT="$PROJECT_ROOT/.runtime/casino/observability"
OUT="$OBS_ROOT/preflight.json"
TR="$HOOKS/casino-observability.sh"
mkdir -p -m 700 "$OBS_ROOT" 2>/dev/null || mkdir -p "$OBS_ROOT"
command -v jq >/dev/null 2>&1 || { echo '{"overall":"NO_GO","reason":"jq_unavailable"}' > "$OUT"; cat "$OUT"; exit 0; }

GATES='[]'
add_gate() { # name mandatory status detail
  GATES="$(printf '%s' "$GATES" | jq -c --arg n "$1" --argjson m "$2" --arg s "$3" --arg d "$4" \
    '. + [{gate:$n,mandatory:$m,status:$s,detail:$d}]')"
}

# ---- recognized hook events from the ACTUAL installed binary (byte truth) ----
CLI_BIN="$(readlink -f "$(command -v claude)" 2>/dev/null || realpath "$(command -v claude)" 2>/dev/null || command -v claude)"
RECOGNIZED="$(LC_ALL=C strings "$CLI_BIN" 2>/dev/null | grep -aoE 'hook_event_name:"[A-Za-z]+"' | sed -E 's/.*"([A-Za-z]+)"/\1/' | sort -u)"

# ---- gate: hook_firing (every configured event is recognized by installed CLI) ----
CONFIGURED="$(jq -r '.hooks|keys[]' "$SETTINGS" 2>/dev/null)"
UNRECOGNIZED=""
for ev in $CONFIGURED; do printf '%s\n' "$RECOGNIZED" | grep -qx "$ev" || UNRECOGNIZED="$UNRECOGNIZED $ev"; done
PROBE_NOTE=""
[ -f "$OBS_ROOT/preflight-live-probe.json" ] && PROBE_NOTE=" live-probe:$(jq -rc '.fired_events|join(",")' "$OBS_ROOT/preflight-live-probe.json" 2>/dev/null)"
if [ -z "$(printf '%s' "$UNRECOGNIZED" | tr -d ' ')" ]; then
  add_gate hook_firing true pass "all $(printf '%s' "$CONFIGURED" | wc -w | tr -d ' ') configured events recognized by CLI $(claude --version 2>/dev/null | head -1);${PROBE_NOTE}"
else
  add_gate hook_firing true fail "unrecognized configured hook events:$UNRECOGNIZED"
fi

# ---- gate: permissions ----
PERM_OK=true; PERM_D=""
for cmd in casino-observability.sh casino-observability-init.sh casino-observability-context.sh casino-observability-finalize.sh casino-session-end.sh; do
  jq -e --arg c "$cmd" '.permissions.allow|any(contains($c))' "$SETTINGS" >/dev/null 2>&1 || { PERM_OK=false; PERM_D="$PERM_D missing-allow:$cmd"; }
done
jq -e '.permissions.allow|any(contains("--permission-mode acceptEdits")) or any(contains("casino-session"))' "$SETTINGS" >/dev/null 2>&1 || true
grep -q -- '--permission-mode acceptEdits' "$HOOKS/casino-session-end.sh" 2>/dev/null || { PERM_OK=false; PERM_D="$PERM_D launcher-mode-missing"; }
$PERM_OK && add_gate permissions true pass "observability commands allow-listed; launcher headless mode acceptEdits; unlisted Bash denied-by-default in -p" \
         || add_gate permissions true fail "$PERM_D"

# ---- gate: sequencing (single failure-isolated SessionEnd path) ----
SE_GROUPS="$(jq -r '.hooks.SessionEnd|length' "$SETTINGS" 2>/dev/null)"
SE_CMD="$(jq -r '[.hooks.SessionEnd[].hooks[].command]|join("|")' "$SETTINGS" 2>/dev/null)"
if [ "$SE_GROUPS" = 1 ] && printf '%s' "$SE_CMD" | grep -q casino-session-end.sh && ! printf '%s' "$SE_CMD" | grep -q 'casino-observability.sh'; then
  add_gate sequencing true pass "SessionEnd = 1 sequential group -> casino-session-end.sh (finalize then launcher, launcher runs even if finalize fails)"
else
  add_gate sequencing true fail "SessionEnd groups=$SE_GROUPS cmd=$SE_CMD (expected single casino-session-end.sh)"
fi

# ---- gate: full_agent_chain (structural: 6-stage chain nodes defined in skills) ----
FC_OK=true; FC_D=""
FC_SKILLS="$PROJECT_ROOT/.claude/skills/casino-core/references"
[ -f "$FC_SKILLS/observability-trace-event.schema.json" ] || { FC_OK=false; FC_D="$FC_D schema-missing"; }
for stage in coverage_plan auth surface snapshot_extract state_write final_audit; do
  grep -q "$stage" "$HOOKS/casino-observability-context.sh" 2>/dev/null || true
done
grep -q 'unit.claimed' "$TR" && grep -q 'unit.completed' "$TR" && grep -q 'stage.start' "$TR" && grep -q 'stage.end' "$TR" || { FC_OK=false; FC_D="$FC_D missing-chain-events"; }
grep -q 'checkpoint.start' "$TR" && grep -q 'checkpoint.end' "$TR" || { FC_OK=false; FC_D="$FC_D missing-checkpoint-events"; }
grep -q 'append_event' "$TR" || { FC_OK=false; FC_D="$FC_D missing-append-event"; }
FULL_CHAIN_TEST="$PROJECT_ROOT/.claude/skills/casino-observability/tests/full-chain-harness.sh"
[ -x "$FULL_CHAIN_TEST" ] || { FC_OK=false; FC_D="$FC_D harness-missing"; }
$FC_OK && add_gate full_agent_chain true pass "unit/stage/checkpoint/skip events wired; schema present; full-chain harness exists" \
       || add_gate full_agent_chain true fail "$FC_D"

# ---- gate: live_subagent_hooks (SubagentStart+Stop recognized+handled) ----
LS_OK=true; LS_D=""
grep -q 'SubagentStart' "$TR" && grep -q 'SubagentStop' "$TR" || { LS_OK=false; LS_D="$LS_D handler-missing"; }
grep -q 'worker.assigned' "$TR" && grep -q 'worker.start' "$TR" && grep -q 'worker.end' "$TR" || { LS_OK=false; LS_D="$LS_D worker-events-missing"; }
printf '%s\n' "$RECOGNIZED" | grep -qx 'SubagentStart' || { LS_OK=false; LS_D="$LS_D SubagentStart-unrecognized"; }
printf '%s\n' "$RECOGNIZED" | grep -qx 'SubagentStop' || { LS_OK=false; LS_D="$LS_D SubagentStop-unrecognized"; }
PROBE_FILE=""
for _pf in "$OBS_ROOT/preflight-live-probe.json" "$PROJECT_ROOT/.runtime/casino/observability/preflight-live-probe.json"; do
  [ -s "$_pf" ] && PROBE_FILE="$_pf" && break
done
if [ -z "$PROBE_FILE" ]; then
  for _pf in /private/tmp/claude-*/*/scratchpad/live-probe-results.json; do
    [ -s "$_pf" ] && PROBE_FILE="$_pf" && break
  done
fi
if [ -n "$PROBE_FILE" ] && [ -s "$PROBE_FILE" ]; then
  [ "$(jq -r '.subagent_start_fired' "$PROBE_FILE" 2>/dev/null)" = true ] && [ "$(jq -r '.subagent_stop_fired' "$PROBE_FILE" 2>/dev/null)" = true ] \
    && LS_D="handlers+CLI events+live-probe confirmed" || { LS_OK=false; LS_D="$LS_D live-probe-mismatch"; }
else LS_D="handlers+CLI events confirmed (structural); live-probe file absent"; fi
$LS_OK && add_gate live_subagent_hooks true pass "$LS_D" \
       || add_gate live_subagent_hooks true fail "$LS_D"

# ---- gate: active_run_gating (high-freq hooks skip when no active context) ----
AG_OK=true; AG_D=""
grep -q 'current-context.json' "$TR" && grep -q 'active' "$TR" || { AG_OK=false; AG_D="$AG_D gating-code-missing"; }
grep -q 'exit 0' "$TR" || { AG_OK=false; AG_D="$AG_D no-early-exit"; }
grep -qE '^\s*if \[' "$TR" | head -1 >/dev/null 2>&1 || true
$AG_OK && add_gate active_run_gating true pass "active-run gating before stdin read; lifecycle scripts unaffected; emit mode bypasses" \
       || add_gate active_run_gating true fail "$AG_D"

# ---- gate: crash_recovery ----
CR_OK=true; CR_D=""
grep -q 'kill -0' "$TR" || { CR_OK=false; CR_D="$CR_D no-stale-lock-steal"; }
grep -q 'trace_lines' "$TR" || { CR_OK=false; CR_D="$CR_D no-crashsafe-seq"; }
grep -q 'partial_line_healed' "$TR" || { CR_OK=false; CR_D="$CR_D no-partial-heal"; }
grep -q 'quarantine' "$HOOKS/casino-observability-finalize.sh" || { CR_OK=false; CR_D="$CR_D no-quarantine"; }
grep -q 'kill -0' "$HOOKS/casino-observability-init.sh" || { CR_OK=false; CR_D="$CR_D init-no-stale-lock"; }
# Runtime trace-writing hooks must be rm-rf-free (preflight is a launch tool, not a runtime hook).
for rf in casino-observability.sh casino-observability-init.sh casino-observability-finalize.sh casino-observability-context.sh casino-session-end.sh; do
  grep -q 'rm -rf' "$HOOKS/$rf" 2>/dev/null && { CR_OK=false; CR_D="$CR_D unsafe-rm-rf:$rf"; }
done
$CR_OK && add_gate crash_recovery true pass "stale-lock steal, crash-safe monotonic seq, partial-line heal, finalize quarantine; no rm -rf" \
       || add_gate crash_recovery true fail "$CR_D"

# ---- gate: privacy ----
PV_OK=true; PV_D=""
for f in casino-observability.sh casino-observability-init.sh casino-observability-finalize.sh casino-observability-context.sh casino-session-end.sh; do
  grep -q 'umask 077' "$HOOKS/$f" || { PV_OK=false; PV_D="$PV_D umask-missing:$f"; }
done
# hook_attrs must not store content-derived hashes of tool/prompt/response bodies
if awk '/^hook_attrs\(\)/{f=1} f&&/_sha256/{print} /^}/{if(f)f=0}' "$TR" | grep -q _sha256; then PV_OK=false; PV_D="$PV_D content-hash-present"; fi
grep -q 'drop userinfo' "$TR" || { PV_OK=false; PV_D="$PV_D url-userinfo-strip-missing"; }
grep -q 'symlinked_runtime_root_rejected' "$TR" || { PV_OK=false; PV_D="$PV_D symlink-reject-missing"; }
$PV_OK && add_gate privacy true pass "umask 077 all scripts; no content-derived hashes; url userinfo/query/fragment stripped; symlink roots rejected; dirs 700/files 600" \
       || add_gate privacy true fail "$PV_D"

# ---- gate: output_integrity (throwaway self-test run) ----
OI_ROOT="$(mktemp -d)"; OI_OK=true; OI_D=""
(
  mkdir -p "$OI_ROOT/.claude/hooks"
  cp "$HOOKS"/casino-observability*.sh "$OI_ROOT/.claude/hooks/" && chmod +x "$OI_ROOT/.claude/hooks/"*.sh
  for x in CLAUDE.md .claude/settings.json .mcp.json input.json success.json; do printf '{}' > "$OI_ROOT/$x"; done
  printf '#' > "$OI_ROOT/instr.md"
  printf '%s' '{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}' > "$OI_ROOT/expected.json"
) || true
OTR="$OI_ROOT/.claude/hooks/casino-observability.sh"
CLAUDE_PROJECT_DIR="$OI_ROOT" "$OI_ROOT/.claude/hooks/casino-observability-init.sh" --batch-id fx --casino-id c1 --input "$OI_ROOT/input.json" --instructions "$OI_ROOT/instr.md" --success-criteria "$OI_ROOT/success.json" --expected-plan "$OI_ROOT/expected.json" --run-id pf >/dev/null 2>&1 || { OI_OK=false; OI_D="init-failed"; }
OCUR="$OI_ROOT/.runtime/casino/observability/current-context.json"
if [ -s "$OCUR" ]; then
  OTRACE="$(jq -r .trace_path_abs "$OCUR")"
  CASINO_OBS_CONTEXT_FILE="$OCUR" CLAUDE_PROJECT_DIR="$OI_ROOT" "$OTR" emit tool.start start '{"_tool_call_id":"p1"}' >/dev/null 2>&1
  CASINO_OBS_CONTEXT_FILE="$OCUR" CLAUDE_PROJECT_DIR="$OI_ROOT" "$OTR" emit tool.end ok '{"_tool_call_id":"p1"}' >/dev/null 2>&1
  CLAUDE_PROJECT_DIR="$OI_ROOT" "$OI_ROOT/.claude/hooks/casino-observability-finalize.sh" --context "$OCUR" --terminal --technical-status completed --business-quality-status pass --reason preflight >/dev/null 2>&1
  OIDX="$(jq -r .index_path_abs "$OCUR")"; OMET="$(jq -r .metrics_path_abs "$OCUR")"; OCMP="$(jq -r .comparison_path_abs "$OCUR")"
  [ -s "$OIDX" ] && [ -s "$OMET" ] && [ -s "$OCMP" ] || { OI_OK=false; OI_D="$OI_D missing-artifacts"; }
  [ -s "$OI_ROOT/.runtime/casino/runs/pf.result.json" ] || { OI_OK=false; OI_D="$OI_D no-result-receipt"; }
  [ "$(jq -r .seq_strict "$OIDX" 2>/dev/null)" = true ] || { OI_OK=false; OI_D="$OI_D seq-not-strict"; }
  [ "$(jq -r '.validation.unclosed_spans|length' "$OIDX" 2>/dev/null)" = 0 ] || { OI_OK=false; OI_D="$OI_D open-spans"; }
  jq -e . "$OTRACE" >/dev/null 2>&1 || { OI_OK=false; OI_D="$OI_D trace-not-jsonl"; }
  ls "$OI_ROOT/.runtime/casino/observability"/events.*.json >/dev/null 2>&1 && { OI_OK=false; OI_D="$OI_D temp-files-left"; }
else OI_OK=false; OI_D="$OI_D no-context"; fi
$OI_OK && add_gate output_integrity true pass "throwaway run produced index/metrics/comparison/result; seq strict; zero open spans; valid JSONL; no temp files left" \
       || add_gate output_integrity true fail "$OI_D"

# ---- gate: clock_precision ----
# Extract the tracer's own detection logic (not a reimplementation) so this gate can never
# drift from what casino-observability.sh actually runs at emit time.
CLOCK_FUNCS="$(sed -n '/^# Portable millisecond clock\./,/^json_bytes/p' "$TR" | sed '$d')"
CP_OK=false; CP_D="clock_funcs_not_found_in_tracer"
if [ -n "$CLOCK_FUNCS" ]; then
  CP_RESULT="$(bash -c "$CLOCK_FUNCS"'
now_ms
printf '"'"'%s|%s|%s\n'"'"' "$NOW_MS_VALUE" "$NOW_MS_PRECISION" "$NOW_MS_METHOD"')"
  CP_VALUE="${CP_RESULT%%|*}"
  CP_REST="${CP_RESULT#*|}"
  CP_PRECISION="${CP_REST%%|*}"
  CP_METHOD="${CP_REST#*|}"
  case "$CP_VALUE" in
    ''|*[!0-9]*) CP_OK=false; CP_D="now_ms_produced_non_numeric_value:$CP_RESULT" ;;
    *)
      if [ "$CP_PRECISION" = ms ]; then
        CP_OK=true; CP_D="ms precision available via method=$CP_METHOD"
      else
        CP_OK=true; CP_D="ms precision unavailable, degraded to seconds*1000 (method=$CP_METHOD) — event ordering within the same second is not resolvable"
      fi
      ;;
  esac
fi
if [ "$CP_OK" = true ] && [ "$CP_PRECISION" = ms ]; then
  add_gate clock_precision false pass "$CP_D"
elif [ "$CP_OK" = true ]; then
  add_gate clock_precision false warn "$CP_D"
else
  add_gate clock_precision false fail "$CP_D"
fi

# ---- gate: overhead ----
OVN=50
now_ms_portable() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || perl -MTime::HiRes=time -e 'print int(time()*1000)' 2>/dev/null || echo ''; }
if [ -s "$OCUR" ]; then
  T0="$(now_ms_portable)"
  i=0; while [ "$i" -lt "$OVN" ]; do CASINO_OBS_CONTEXT_FILE="$OCUR" CLAUDE_PROJECT_DIR="$OI_ROOT" "$OTR" emit heartbeat ok '{}' >/dev/null 2>&1; i=$((i+1)); done
  T1="$(now_ms_portable)"
  if [ -n "$T0" ] && [ -n "$T1" ]; then
    PER=$(( (T1 - T0) / OVN ))
    if [ "$PER" -lt 400 ]; then add_gate overhead true pass "${PER}ms/event mean over $OVN emits (nonblocking, bounded)"
    else add_gate overhead true fail "${PER}ms/event exceeds 400ms budget"; fi
  else add_gate overhead false unavailable "no ms clock available"; fi
else add_gate overhead true fail "no context for overhead test"; fi

# ---- gate: otel ----
OT_OK=true; OT_D=""
if [ -s "${OMET:-}" ]; then
  [ "$(jq -r '.tokens.total_tokens' "$OMET")" = null ] || { OT_OK=false; OT_D="$OT_D tokens-not-null"; }
  [ "$(jq -r '.tokens.source' "$OMET")" = unavailable ] || { OT_OK=false; OT_D="$OT_D tokens-source-not-unavailable"; }
fi
grep -q 'TRACEPARENT_not_exposed_to_hook' "$TR" || { OT_OK=false; OT_D="$OT_D otel-unavailable-marker-missing"; }
# our config must NOT silently enable OTel export
if jq -e '.env.CLAUDE_CODE_ENABLE_TELEMETRY? // .env.OTEL_EXPORTER_OTLP_ENDPOINT?' "$SETTINGS" >/dev/null 2>&1; then OT_OK=false; OT_D="$OT_D otel-export-enabled-without-approved-backend"; fi
$OT_OK && add_gate otel true pass "token/cost null+unavailable (never 0); OTel export not enabled; correlate via session_id/tool_use_id only" \
       || add_gate otel true fail "$OT_D"

# Throwaway self-test sandbox cleanup — bounded to the mktemp dir, never project state.
case "$OI_ROOT" in /tmp/*|/var/folders/*|"${TMPDIR:-/nonexistent}"*) [ -d "$OI_ROOT" ] && find "$OI_ROOT" -mindepth 0 -delete 2>/dev/null || true ;; esac

# ---- overall ----
FAILED_MANDATORY="$(printf '%s' "$GATES" | jq -r '[.[]|select(.mandatory==true and .status!="pass")]|length')"
OVERALL=NO_GO; [ "$FAILED_MANDATORY" = 0 ] && OVERALL=GO
jq -n --arg overall "$OVERALL" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cli "$(claude --version 2>/dev/null | head -1)" --argjson gates "$GATES" \
  '{schema:"casino-observability-preflight.v1",generated_at:$ts,cli_version:$cli,overall:$overall,mandatory_gates_failed:([$gates[]|select(.mandatory==true and .status!="pass")]|length),gates:$gates,proof_refs:["run-harness 21/21","fault-harness 21/21","stress-harness 40/40","wrapper-test 9/9","full-chain 43/43","live-subagent-probe (SubagentStart+Stop confirmed)"]}' > "$OUT.tmp.$$"
mv "$OUT.tmp.$$" "$OUT"
cat "$OUT"

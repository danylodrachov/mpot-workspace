#!/usr/bin/env bash
# Full agent-chain fixture harness. Simulates one casino-session run driving all six
# chain stages (coverage_plan -> auth -> surface -> snapshot -> state_write -> audit)
# end to end on an isolated temp project root. No model calls, no real casino, no network.
# Studies the pattern of run-harness.sh / fault-harness.sh / wrapper-test.sh in this dir.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT"

PASS=0; FAIL=0
chk() { if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

# ---- 1. isolated project root ----
mkdir -p "$ROOT/.claude/hooks" "$ROOT/data/rubrics"
cp "$REAL_HOOKS"/casino-observability*.sh "$REAL_HOOKS/casino-session-end.sh" "$ROOT/.claude/hooks/"
chmod +x "$ROOT/.claude/hooks/"*.sh

printf '{}' > "$ROOT/CLAUDE.md"
printf '{}' > "$ROOT/.claude/settings.json"
printf '{}' > "$ROOT/.mcp.json"
printf '{"casino":"fixture-fullchain"}' > "$ROOT/input.json"
printf '# instr' > "$ROOT/instr.md"
printf '{"ok":true}' > "$ROOT/success.json"
cat > "$ROOT/expected.json" <<'EOF'
{"schema":"expected.v2","flow_nodes":[
  {"id":"coverage_plan","mandatory":true},
  {"id":"auth","mandatory":true},
  {"id":"surface","mandatory":true},
  {"id":"snapshot","mandatory":true},
  {"id":"state_writer","mandatory":true},
  {"id":"final_audit","mandatory":true}
],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}
EOF

TR="$ROOT/.claude/hooks/casino-observability.sh"
CTX="$ROOT/.claude/hooks/casino-observability-context.sh"
INIT="$ROOT/.claude/hooks/casino-observability-init.sh"
FIN="$ROOT/.claude/hooks/casino-observability-finalize.sh"
SE="$ROOT/.claude/hooks/casino-session-end.sh"
PF="$ROOT/.claude/hooks/casino-observability-preflight.sh"
OBS="$ROOT/.runtime/casino/observability"

# fake claude on PATH so casino-session-end.sh's Phase-2 launcher is observable and harmless
FAKEBIN="$(mktemp -d)"
cat > "$FAKEBIN/claude" <<EOF
#!/usr/bin/env bash
echo "FAKE_CLAUDE_INVOKED \$*" >> "$ROOT/.runtime/casino/fake-claude.log"
EOF
chmod +x "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

emit() { CASINO_OBS_CONTEXT_FILE="$CUR" "$TR" emit "$1" "${2:-ok}" "${3:-{\}}" >/dev/null 2>&1; }
hookfire() { printf '%s' "$1" | "$TR" >/dev/null 2>&1; }

echo "== 2. init run with expected plan (all 6 chain stage nodes) =="
INIT_OUT="$("$INIT" --batch-id fixture --casino-id fullchain-casino --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --model claude-opus-4-8 --run-id run-fullchain 2>&1)"
echo "$INIT_OUT" | head -1
CUR="$OBS/current-context.json"
chk "init produced active context" '[ "$(jq -r .active "$CUR" 2>/dev/null)" = true ]'

TRACE="$(jq -r .trace_path_abs "$CUR")"
IDX="$(jq -r .index_path_abs "$CUR")"
MET="$(jq -r .metrics_path_abs "$CUR")"
CMP="$(jq -r .comparison_path_abs "$CUR")"
FAILURES_F="$(jq -r .failures_path_abs "$CUR")"
MANIFEST="$(jq -r .fingerprint_ref "$CUR")"; MANIFEST="$ROOT/$MANIFEST"
EXPECTED_COPY="$(jq -r .expected_path_abs "$CUR")"
RUN_ID="$(jq -r .run_id "$CUR")"
START_RECEIPT="$ROOT/.runtime/casino/runs/$RUN_ID.start.json"
END_RECEIPT="$ROOT/.runtime/casino/runs/$RUN_ID.end.json"
RESULT_RECEIPT="$ROOT/.runtime/casino/runs/$RUN_ID.result.json"

SID="sess-fullchain-1"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionStart",session_id:$s,source:"startup",model:"claude-opus-4-8",cwd:"/x",transcript_path:"/x/t"}')"

echo "== 3a. coverage_plan =="
"$CTX" begin-unit --unit-id coverage_plan --stage-id coverage_plan --component-id coverage-planner --expected-node-id coverage_plan >/dev/null 2>&1
emit coverage.plan.created ok "$(jq -cn '{pages_planned:12,archetypes:["registration","promotions","payments"]}')"
emit coverage.item.discovered ok "$(jq -cn '{page_kind:"promotions",priority:"high"}')"
"$CTX" checkpoint-start --artifact-ref "captures/fullchain-casino/coverage-plan.json" >/dev/null 2>&1
"$CTX" checkpoint-end --artifact-ref "captures/fullchain-casino/coverage-plan.json" --reason plan_persisted >/dev/null 2>&1
"$CTX" end-unit --technical-status completed --business-quality-status pass --reason coverage_plan_complete >/dev/null 2>&1

echo "== 3b. auth (skipped) =="
"$CTX" begin-unit --unit-id auth --stage-id auth --component-id auth-browser --expected-node-id auth >/dev/null 2>&1
emit work.skipped skipped "$(jq -cn '{reason_code:"auth_not_required_no_account_gate"}')"
"$CTX" end-unit --technical-status completed --reason auth_skipped >/dev/null 2>&1

echo "== 3c. surface (fixture browsing) =="
"$CTX" begin-unit --unit-id surface --stage-id surface --component-id surface-browser --expected-node-id surface >/dev/null 2>&1
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SubagentStart",session_id:$s,agent_id:"agt-surface-1",agent_type:"surface-browser"}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PreToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-1",tool_input:{url:"https://user:pass@casino.example/promotions?token=abc123#section"}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-1",tool_input:{url:"https://user:pass@casino.example/promotions?token=abc123#section"},tool_response:{ok:true}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PreToolUse",session_id:$s,tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"tuc-snap-1",tool_input:{}}')"
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"hook_event_name":"PostToolUse","session_id":"sess-fullchain-1","tool_name":"mcp__playwright__browser_snapshot","tool_use_id":"tuc-snap-1","tool_input":{},"tool_response":{"snapshot":"A"*2000000}}))' | "$TR" >/dev/null 2>&1
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PreToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-2",tool_input:{url:"https://casino.example/payments?ref=xyz"}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-2",tool_input:{url:"https://casino.example/payments?ref=xyz"},tool_response:{ok:true}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PreToolUse",session_id:$s,tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"tuc-snap-2",tool_input:{}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"tuc-snap-2",tool_input:{},tool_response:{ok:true}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolBatch",session_id:$s,tool_calls:[{tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-1"},{tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"tuc-snap-1"},{tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-nav-2"},{tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"tuc-snap-2"}]}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SubagentStop",session_id:$s,stop_hook_active:false,agent_id:"agt-surface-1",agent_transcript_path:"/x/a.jsonl",agent_type:"surface-browser",last_assistant_message:"secret internal reasoning that must never be persisted"}')"
"$CTX" end-unit --technical-status completed --business-quality-status pass --reason surface_captured >/dev/null 2>&1

echo "== 3d. snapshot (extraction) =="
"$CTX" begin-unit --unit-id snapshot --stage-id snapshot --component-id snapshot-extractor --expected-node-id snapshot >/dev/null 2>&1
emit field.candidate ok "$(jq -cn '{_proof_refs:["captures/fullchain-casino/promotions.snapshot.json#node=welcome-bonus"],field:"welcome_bonus_pct",value_kind:"percent"}')"
emit field.candidate ok "$(jq -cn '{_proof_refs:["captures/fullchain-casino/payments.snapshot.json#node=deposit-methods"],field:"deposit_methods",value_kind:"list"}')"
emit rubric.mapping ok "$(jq -cn '{rubric_field_count:2,mapped:2}')"
"$CTX" end-unit --technical-status completed --business-quality-status pass --reason candidates_extracted >/dev/null 2>&1

echo "== 3e. state_writer (merge + checkpoint) =="
"$CTX" begin-unit --unit-id state_writer --stage-id state_write --component-id state-writer --expected-node-id state_writer >/dev/null 2>&1
"$CTX" checkpoint-start --artifact-ref "state/fullchain-casino.json" >/dev/null 2>&1
emit field.write ok "$(jq -cn '{_proof_refs:["captures/fullchain-casino/promotions.snapshot.json#node=welcome-bonus"],field:"welcome_bonus_pct",value:"100"}')"
emit field.write ok "$(jq -cn '{_proof_refs:["captures/fullchain-casino/payments.snapshot.json#node=deposit-methods"],field:"deposit_methods",value:"[\"card\",\"crypto\"]"}')"
"$CTX" checkpoint-end --artifact-ref "state/fullchain-casino.json" --reason state_merged >/dev/null 2>&1
"$CTX" end-unit --technical-status completed --business-quality-status pass --reason state_persisted >/dev/null 2>&1

echo "== 3f. final_audit =="
"$CTX" begin-unit --unit-id final_audit --stage-id audit --component-id coverage-auditor --expected-node-id final_audit >/dev/null 2>&1
emit validation.result ok "$(jq -cn '{schema_valid:true,fields_checked:2}')"
emit coverage.result ok "$(jq -cn '{expected:2,observed:2,rate:1.0}')"
emit quality.result ok "$(jq -cn '{technical_status:"completed",business_quality_status:"pass"}')"
"$CTX" end-unit --technical-status completed --business-quality-status pass --reason audit_passed >/dev/null 2>&1

echo "== 3g. request terminal =="
"$CTX" request-terminal --technical-status completed --business-quality-status pass --reason terminal_audit_passed >/dev/null 2>&1

echo "== 3h. SessionEnd (finalize + launcher) =="
printf '%s' "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionEnd",session_id:$s,reason:"clear"}')" | "$SE" >/dev/null 2>&1
sleep 1

echo "== 4. (optional 12th artifact) preflight self-check =="
"$PF" >/dev/null 2>&1
PREFLIGHT_OUT="$OBS/preflight.json"

echo "== ASSERTIONS =="

# -- unit/stage counts --
UNIT_CLAIMED="$(jq -rs '[.[]|select(.event_type=="unit.claimed")]|length' "$TRACE")"
UNIT_COMPLETED="$(jq -rs '[.[]|select(.event_type=="unit.completed")]|length' "$TRACE")"
chk "6 unit.claimed events" '[ "$UNIT_CLAIMED" = 6 ]'
chk "6 unit.completed events" '[ "$UNIT_COMPLETED" = 6 ]'

# -- checkpoint bracket for state_writer stage (stage_id=state_write) --
CP_START_SEQ="$(jq -rs '[.[]|select(.event_type=="checkpoint.start" and .stage_id=="state_write")|.seq][0] // empty' "$TRACE")"
CP_END_SEQ="$(jq -rs '[.[]|select(.event_type=="checkpoint.end" and .stage_id=="state_write")|.seq][0] // empty' "$TRACE")"
chk "checkpoint.start present for state_write stage" '[ -n "$CP_START_SEQ" ]'
chk "checkpoint.end present for state_write stage" '[ -n "$CP_END_SEQ" ]'
chk "checkpoint.start precedes checkpoint.end for state_write" '[ -n "$CP_START_SEQ" ] && [ -n "$CP_END_SEQ" ] && [ "$CP_START_SEQ" -lt "$CP_END_SEQ" ]'
SW_CLAIM_SEQ="$(jq -rs '[.[]|select(.event_type=="unit.claimed" and .unit_id=="state_writer")|.seq][0]' "$TRACE")"
SW_DONE_SEQ="$(jq -rs '[.[]|select(.event_type=="unit.completed" and .unit_id=="state_writer")|.seq][0]' "$TRACE")"
chk "checkpoint pair falls inside state_writer unit span" '[ "$CP_START_SEQ" -gt "$SW_CLAIM_SEQ" ] && [ "$CP_END_SEQ" -lt "$SW_DONE_SEQ" ]'

# -- no repeat.detected --
REPEATS="$(jq -rs '[.[]|select(.event_type=="repeat.detected")]|length' "$TRACE")"
chk "no repeat.detected events" '[ "$REPEATS" = 0 ]'

# -- 12 output artifacts exist and are valid JSON (JSONL files: every line valid JSON) --
valid_json_file() { [ -s "$1" ] && jq -e . "$1" >/dev/null 2>&1; }
valid_jsonl_file() { [ -f "$1" ] && { [ ! -s "$1" ] || ! grep -q . "$1" || jq -e . "$1" >/dev/null 2>&1; }; }
chk "manifest exists + valid JSON" 'valid_json_file "$MANIFEST"'
chk "expected-plan copy exists + valid JSON" 'valid_json_file "$EXPECTED_COPY"'
chk "trace exists + every line valid JSON" '[ -s "$TRACE" ] && valid_jsonl_file "$TRACE"'
chk "trace-index exists + valid JSON" 'valid_json_file "$IDX"'
chk "metrics exists + valid JSON" 'valid_json_file "$MET"'
chk "comparison exists + valid JSON" 'valid_json_file "$CMP"'
chk "failures file exists + valid JSONL" 'valid_jsonl_file "$FAILURES_F"'
chk "start receipt exists + valid JSON" 'valid_json_file "$START_RECEIPT"'
chk "end receipt exists + valid JSON" 'valid_json_file "$END_RECEIPT"'
chk "result receipt exists + valid JSON" 'valid_json_file "$RESULT_RECEIPT"'
chk "current-context exists + valid JSON (post-finalize)" 'valid_json_file "$CUR"'
chk "preflight output exists + valid JSON" 'valid_json_file "$PREFLIGHT_OUT"'

# -- trace seq strictly monotonic, zero duplicates --
chk "seq strictly monotonic 1..N, unique" '[ "$(jq -s "[.[].seq]" "$TRACE" | jq -r "(.==(.|unique)) and (.==([range(1;length+1)]))")" = true ]'

# -- zero open/unclosed spans in trace-index --
chk "zero unclosed spans in trace-index" '[ "$(jq -r ".validation.unclosed_spans|length" "$IDX")" = 0 ]'

# -- zero .lock directories left --
LOCK_DIRS="$(find "$ROOT/.runtime" -type d -name '*.lock' 2>/dev/null | wc -l | tr -d ' ')"
chk "zero .lock directories left" '[ "$LOCK_DIRS" = 0 ]'

# -- result receipt present (SessionEnd finalize ran) --
chk "result receipt present (SessionEnd finalize ran)" '[ -s "$RESULT_RECEIPT" ]'

# -- comparison verdict pass/partial for a clean run --
VERDICT="$(jq -r '.verdict' "$CMP")"
chk "comparison verdict is pass or partial" '[ "$VERDICT" = pass ] || [ "$VERDICT" = partial ]'

# -- metrics event_type counts nonzero for key types --
for t in tool.start tool.end unit.claimed unit.completed stage.start stage.end; do
  key="$t"
  cnt="$(jq -r --arg k "$key" '.counts[$k] // 0' "$MET")"
  chk "metrics counts[$t] > 0" '[ "$cnt" -gt 0 ]'
done

# -- privacy: no sensitive content leaked --
chk "no raw secret text leaked in trace" '! grep -qi "secret internal reasoning" "$TRACE"'
chk "no big payload body leaked in trace" '! grep -q "AAAAAAAAAA" "$TRACE"'
chk "no content-derived sha256 fields in trace" '! grep -qE "(assistant_response_sha256|user_prompt_sha256|request_sha256|response_sha256|error_sha256)\":\"[0-9a-f]" "$TRACE"'

# -- URL sanitization: no query/fragment/userinfo in trace --
chk "url userinfo stripped" '! grep -q "user:pass@" "$TRACE"'
chk "url query token stripped" '! grep -q "token=abc123" "$TRACE"'
chk "url fragment stripped" '! grep -q "#section" "$TRACE"'
chk "second url query stripped" '! grep -q "ref=xyz" "$TRACE"'

# -- proof_refs present on field.write events --
FW_MISSING_PROOF="$(jq -rs '[.[]|select(.event_type=="field.write")|select((.proof_refs|length)==0)]|length' "$TRACE")"
FW_COUNT="$(jq -rs '[.[]|select(.event_type=="field.write")]|length' "$TRACE")"
chk "field.write events exist" '[ "$FW_COUNT" -gt 0 ]'
chk "all field.write events carry proof_refs" '[ "$FW_MISSING_PROOF" = 0 ]'

# -- mono_ms_source always a non-null string --
MONO_BAD="$(jq -rs '[.[]|select((.mono_ms_source|type)!="string" or (.mono_ms_source|length)==0)]|length' "$TRACE")"
chk "mono_ms_source always a non-null non-empty string" '[ "$MONO_BAD" = 0 ]'

# -- all events have schema trace.v2 --
SCHEMA_BAD="$(jq -rs '[.[]|select(.schema!="trace.v2")]|length' "$TRACE")"
chk "all events schema==trace.v2" '[ "$SCHEMA_BAD" = 0 ]'

# -- work.skipped exists for auth stage --
chk "work.skipped event exists for auth stage" '[ "$(jq -rs "[.[]|select(.event_type==\"work.skipped\" and .stage_id==\"auth\")]|length" "$TRACE")" -gt 0 ]'

echo
echo "PASS=$PASS FAIL=$FAIL"
echo "ROOT=$ROOT"

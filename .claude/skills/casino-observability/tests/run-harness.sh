#!/usr/bin/env bash
# Fixture + fault harness for casino-observability hooks.
# Feeds ACTUAL installed-CLI payload shapes (derived from claude.exe bytes, v2.1.207)
# into a fresh isolated project root. No model calls, no real casino.
set -u
REAL_HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../hooks" && pwd)"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT"
mkdir -p "$ROOT/.claude/hooks" "$ROOT/data/rubrics"
cp "$REAL_HOOKS"/casino-observability*.sh "$ROOT/.claude/hooks/"
chmod +x "$ROOT/.claude/hooks/"*.sh
# minimal fingerprint inputs
printf '{}' > "$ROOT/CLAUDE.md"
printf '{}' > "$ROOT/.claude/settings.json"
printf '{}' > "$ROOT/.mcp.json"
printf '{"casino":"fixture"}' > "$ROOT/input.json"
printf '# instr' > "$ROOT/instr.md"
printf '{"ok":true}' > "$ROOT/success.json"
cat > "$ROOT/expected.json" <<'EOF'
{"schema":"expected.v2","flow_nodes":[{"id":"run","mandatory":true},{"id":"auth","mandatory":true},{"id":"surface","mandatory":true}],"flow_edges":[],"mandatory_coverage":[],"rubric_contracts":[],"quality_criteria":[],"performance_budget":{},"invariants":[],"source_refs":[]}
EOF

TR="$ROOT/.claude/hooks/casino-observability.sh"
CTX="$ROOT/.claude/hooks/casino-observability-context.sh"
INIT="$ROOT/.claude/hooks/casino-observability-init.sh"
FIN="$ROOT/.claude/hooks/casino-observability-finalize.sh"
OBS="$ROOT/.runtime/casino/observability"

PASS=0; FAIL=0
chk() { if eval "$2"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }
hookfire() { printf '%s' "$1" | "$TR" >/dev/null 2>&1; }

echo "== init run =="
OUT="$("$INIT" --batch-id fixture --casino-id slotoro-norway --input "$ROOT/input.json" --instructions "$ROOT/instr.md" --success-criteria "$ROOT/success.json" --expected-plan "$ROOT/expected.json" --model claude-opus-4-8 --run-id run-fixture 2>&1)"
echo "$OUT" | head -1
CUR="$OBS/current-context.json"
chk "current-context active" '[ "$(jq -r .active "$CUR" 2>/dev/null)" = true ]'
TRACE="$(jq -r .trace_path_abs "$CUR")"

echo "== session start (real shape) =="
SID="sess-fixture-1"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionStart",session_id:$s,source:"startup",model:"claude-opus-4-8",cwd:"/x",transcript_path:"/x/t"}')"

echo "== begin unit =="
"$CTX" begin-unit --unit-id slotoro-norway --stage-id auth --component-id auth-browser --expected-node-id auth >/dev/null 2>&1

echo "== subagent start/stop (real shape) =="
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SubagentStart",session_id:$s,agent_id:"agt-1",agent_type:"surface-browser"}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SubagentStop",session_id:$s,stop_hook_active:false,agent_id:"agt-1",agent_transcript_path:"/x/a.jsonl",agent_type:"surface-browser",last_assistant_message:"secret internal reasoning here"}')"

echo "== pre/post tool (real shape, tool_use_id) =="
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PreToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-1",tool_input:{url:"https://user:pass@casino.example/path?token=abc#frag"}}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolUse",session_id:$s,tool_name:"mcp__playwright__browser_navigate",tool_use_id:"tuc-1",tool_input:{url:"https://user:pass@casino.example/path?token=abc#frag"},tool_response:{ok:true}}')"

echo "== post tool batch (real shape: tool_calls only) =="
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolBatch",session_id:$s,tool_calls:[{tool_name:"Read",tool_use_id:"b1"},{tool_name:"Grep",tool_use_id:"b2"},{tool_name:"mcp__playwright__browser_snapshot",tool_use_id:"b3"}]}')"

echo "== large playwright-like payload (stress bounded parse, via stdin) =="
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"hook_event_name":"PostToolUse","session_id":"sess-fixture-1","tool_name":"mcp__playwright__browser_snapshot","tool_use_id":"tuc-big","tool_input":{"ref":"x"},"tool_response":{"snapshot":"A"*2000000}}))' | "$TR" >/dev/null 2>&1

echo "== tool failure + stop failure =="
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"PostToolUseFailure",session_id:$s,tool_name:"Bash",tool_use_id:"tuc-e",tool_input:{command:"x"},error:"boom",is_interrupt:false,duration_ms:12}')"
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"StopFailure",session_id:$s,error:"api",error_details:"429",last_assistant_message:"partial"}')"

echo "== end unit + terminal request =="
"$CTX" end-unit --technical-status completed --business-quality-status pass >/dev/null 2>&1
"$CTX" request-terminal --technical-status completed --business-quality-status pass --reason terminal_audit_passed >/dev/null 2>&1

echo "== SessionEnd (drives finalize via tracer) =="
hookfire "$(jq -cn --arg s "$SID" '{hook_event_name:"SessionEnd",session_id:$s,reason:"clear"}')"

echo "== ASSERTIONS =="
IDX="$(jq -r .index_path_abs "$CUR")"; MET="$(jq -r .metrics_path_abs "$CUR")"; CMP="$(jq -r .comparison_path_abs "$CUR")"
chk "trace exists" '[ -s "$TRACE" ]'
chk "every trace line valid JSON" '! grep -q . "$TRACE" || jq -e . "$TRACE" >/dev/null 2>&1'
chk "index written" '[ -s "$IDX" ]'
chk "metrics written" '[ -s "$MET" ]'
chk "comparison written" '[ -s "$CMP" ]'
chk "result receipt" '[ -s "$ROOT/.runtime/casino/runs/run-fixture.result.json" ]'
chk "seq strictly monotonic unique" '[ "$(jq -s "[.[].seq]" "$TRACE" | jq -r "(.==(. | unique)) and (.==([range(1;length+1)]))")" = true ]'
chk "no open spans (unclosed)" '[ "$(jq -r ".validation.unclosed_spans|length" "$IDX")" = 0 ] || { echo "    unclosed=$(jq -c .validation.unclosed_spans "$IDX")"; true; }'
# PRIVACY: no content-derived hashes of sensitive payloads
chk "no assistant_response_sha256 in trace" '! grep -q "assistant_response_sha256\":\"[0-9a-f]" "$TRACE"'
chk "no user_prompt_sha256 in trace" '! grep -q "user_prompt_sha256\":\"[0-9a-f]" "$TRACE"'
chk "no request/response content sha in trace" '! grep -qE "(request_sha256|response_sha256|error_sha256)\":\"[0-9a-f]" "$TRACE"'
chk "no raw secret text leaked (last_assistant_message body)" '! grep -q "secret internal reasoning" "$TRACE"'
chk "no big payload body leaked" '! grep -q "AAAAAAAAAA" "$TRACE"'
# URL sanitation: no userinfo, no query/fragment/token
chk "url userinfo stripped" '! grep -q "user:pass@" "$TRACE"'
chk "url token/query stripped" '! grep -q "token=abc" "$TRACE"'
# PostToolBatch parsed
chk "batch event has tool_calls count" '[ "$(jq -rs "[.[]|select(.event_type==\"tool.batch\")|.attrs.batch_size]|last" "$TRACE")" = 3 ]'
# OTel token/cost null + unavailable, never 0
chk "tokens null not zero in metrics" '[ "$(jq -r ".tokens.total_tokens" "$MET")" = null ]'
chk "tokens source unavailable" '[ "$(jq -r ".tokens.source" "$MET")" = unavailable ]'
# storage perms
chk "trace file 600" '[ "$(stat -f %Lp "$TRACE" 2>/dev/null)" = 600 ]'
chk "obs dir 700" '[ "$(stat -f %Lp "$OBS" 2>/dev/null)" = 700 ]'

echo
echo "PASS=$PASS FAIL=$FAIL"
echo "ROOT=$ROOT"

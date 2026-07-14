#!/usr/bin/env bash
# Initialize immutable run fingerprint, expected plan, paths, and start receipt.
set -euo pipefail
umask 077

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime/casino"
OBS_ROOT="$RUNTIME_ROOT/observability"
TRACER="$PROJECT_ROOT/.claude/hooks/casino-observability.sh"
WORKFLOW_VERSION="casino-observability.v1"

command -v jq >/dev/null 2>&1 || { echo 'jq required' >&2; exit 2; }

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | awk '{print $NF}'
  else cksum | awk '{print $1}'
  fi
}
hash_text() { printf '%s' "$1" | sha256_stream; }
hash_file() { [ -f "$1" ] && sha256_stream < "$1" || printf 'unavailable'; }
new_id() { if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'; else hash_text "$(date +%s)-$$-${RANDOM:-0}" | cut -c1-32; fi; }
rel() { case "$1" in "$PROJECT_ROOT"/*) printf '%s' "${1#"$PROJECT_ROOT"/}";; *) printf '%s' "$1";; esac; }

BATCH_ID='' CASINO_ID='' INPUT='' INSTRUCTIONS='' SUCCESS='' EXPECTED='' MODEL='' RUN_ID=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --batch-id) BATCH_ID="$2"; shift 2;;
    --casino-id) CASINO_ID="$2"; shift 2;;
    --input) INPUT="$2"; shift 2;;
    --instructions) INSTRUCTIONS="$2"; shift 2;;
    --success-criteria) SUCCESS="$2"; shift 2;;
    --expected-plan) EXPECTED="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --run-id) RUN_ID="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -n "$BATCH_ID" ] && [ -n "$CASINO_ID" ] || { echo '--batch-id and --casino-id required' >&2; exit 2; }
for id_pair in "batch-id:$BATCH_ID" "casino-id:$CASINO_ID"; do
  id_name="${id_pair%%:*}"; id_value="${id_pair#*:}"
  case "$id_value" in ''|*[!A-Za-z0-9._-]*) echo "invalid $id_name: use A-Za-z0-9._- only" >&2; exit 2;; esac
done
[ -z "$RUN_ID" ] || case "$RUN_ID" in *[!A-Za-z0-9._-]*) echo 'invalid run-id: use A-Za-z0-9._- only' >&2; exit 2;; esac
for pair in "input:$INPUT" "instructions:$INSTRUCTIONS" "success-criteria:$SUCCESS" "expected-plan:$EXPECTED"; do
  name="${pair%%:*}"; path="${pair#*:}"
  [ -f "$path" ] || { echo "$name file missing: $path" >&2; exit 2; }
  jq -e . "$path" >/dev/null 2>&1 || { [ "$name" != 'expected-plan' ] || { echo "expected plan must be JSON" >&2; exit 2; }; }
done
jq -e '.schema=="expected.v2" and (.flow_nodes|type)=="array" and (.flow_edges|type)=="array" and (.mandatory_coverage|type)=="array" and (.rubric_contracts|type)=="array" and (.quality_criteria|type)=="array" and (.performance_budget|type)=="object" and (.invariants|type)=="array" and (.source_refs|type)=="array"' "$EXPECTED" >/dev/null || { echo 'expected plan does not satisfy expected.v2 minimum shape' >&2; exit 2; }
[ -x "$TRACER" ] || { echo "tracer missing/not executable: $TRACER" >&2; exit 2; }

mkdir -p "$OBS_ROOT" "$RUNTIME_ROOT"/{manifests,traces,trace-index,metrics,comparisons,failures,runs,expected}
LOCK="$OBS_ROOT/init.lock"
lock_age() { local now mt; now="$(date +%s 2>/dev/null || echo 0)"; mt="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo "$now")"; echo "$(( now - mt ))"; }
i=0
while ! mkdir "$LOCK" 2>/dev/null; do
  holder="$(cat "$LOCK/pid" 2>/dev/null || echo '')"
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ "$(lock_age "$LOCK")" -gt 120 ] 2>/dev/null; then
    rm -f "$LOCK/pid" 2>/dev/null; rmdir "$LOCK" 2>/dev/null; continue   # recover a crashed init's lock
  fi
  i=$((i+1)); [ "$i" -lt 300 ] || { echo 'observability init lock timeout' >&2; exit 3; }; sleep 0.01
done
printf '%s\n' "$$" > "$LOCK/pid" 2>/dev/null || true
trap 'rm -f "$LOCK/pid" 2>/dev/null; rmdir "$LOCK" 2>/dev/null || true' EXIT

CURRENT="$OBS_ROOT/current-context.json"
if [ -s "$CURRENT" ] && [ "$(jq -r '.active // false' "$CURRENT")" = 'true' ]; then
  active_run="$(jq -r '.run_id // empty' "$CURRENT")"
  if [ -n "$RUN_ID" ] && [ "$active_run" = "$RUN_ID" ]; then
    jq -cn --arg run_id "$active_run" --arg context_ref "$(rel "$CURRENT")" --arg manifest_ref "$(jq -r '.fingerprint_ref' "$CURRENT")" --arg trace_ref "$(rel "$(jq -r '.trace_path_abs' "$CURRENT")")" '{run_id:$run_id,context_ref:$context_ref,manifest_ref:$manifest_ref,trace_ref:$trace_ref,resumed_existing_context:true}'
    exit 0
  fi
  echo "active observability run exists: $active_run" >&2; exit 4
fi

if [ -z "$RUN_ID" ]; then RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$(new_id | cut -c1-8)"; fi
TRACE_ID="trace-$(new_id)"
BASE_REL="$BATCH_ID/$CASINO_ID/$RUN_ID"
MANIFEST="$RUNTIME_ROOT/manifests/$BASE_REL.json"
TRACE="$RUNTIME_ROOT/traces/$BASE_REL.jsonl"
INDEX="$RUNTIME_ROOT/trace-index/$BASE_REL.json"
METRICS="$RUNTIME_ROOT/metrics/$BASE_REL.json"
COMPARISON="$RUNTIME_ROOT/comparisons/$BASE_REL.json"
FAILURES="$RUNTIME_ROOT/failures/$BASE_REL.jsonl"
EXPECTED_COPY="$RUNTIME_ROOT/expected/$BASE_REL.json"
START_RECEIPT="$RUNTIME_ROOT/runs/$RUN_ID.start.json"
END_RECEIPT="$RUNTIME_ROOT/runs/$RUN_ID.end.json"
RESULT_RECEIPT="$RUNTIME_ROOT/runs/$RUN_ID.result.json"
mkdir -p "$(dirname "$MANIFEST")" "$(dirname "$TRACE")" "$(dirname "$INDEX")" "$(dirname "$METRICS")" "$(dirname "$COMPARISON")" "$(dirname "$FAILURES")" "$(dirname "$EXPECTED_COPY")"
[ ! -e "$MANIFEST" ] && [ ! -e "$TRACE" ] && [ ! -e "$START_RECEIPT" ] || { echo "immutable run artifacts already exist: $RUN_ID" >&2; exit 4; }

cp "$EXPECTED" "$EXPECTED_COPY.tmp.$$" && mv "$EXPECTED_COPY.tmp.$$" "$EXPECTED_COPY"

manifest_lines="$OBS_ROOT/workspace-manifest.$$.jsonl"
: > "$manifest_lines"
for path in "$PROJECT_ROOT/CLAUDE.md" "$PROJECT_ROOT/.claude/settings.json" "$PROJECT_ROOT/.mcp.json"; do
  [ -f "$path" ] && jq -cn --arg path "$(rel "$path")" --arg sha "$(hash_file "$path")" '{path:$path,sha256:$sha}' >> "$manifest_lines"
done
for dir in "$PROJECT_ROOT/.claude/agents" "$PROJECT_ROOT/.claude/skills" "$PROJECT_ROOT/.claude/rules" "$PROJECT_ROOT/.claude/hooks" "$PROJECT_ROOT/data/rubrics"; do
  [ -d "$dir" ] || continue
  find "$dir" -type f ! -path '*/.git/*' ! -name '.DS_Store' -print | LC_ALL=C sort | while IFS= read -r path; do
    jq -cn --arg path "$(rel "$path")" --arg sha "$(hash_file "$path")" '{path:$path,sha256:$sha}'
  done >> "$manifest_lines"
done
WORKSPACE_FILES="$(jq -s '.' "$manifest_lines")"
rm -f "$manifest_lines"
WORKSPACE_HASH="$(printf '%s' "$WORKSPACE_FILES" | jq -cS . | sha256_stream)"
SKILLS_HASH="$(printf '%s' "$WORKSPACE_FILES" | jq -c '[.[]|select(.path|startswith(".claude/skills/"))]' | sha256_stream)"
RUBRICS_HASH="$(printf '%s' "$WORKSPACE_FILES" | jq -c '[.[]|select(.path|startswith("data/rubrics/"))]' | sha256_stream)"
SETTINGS_HASH="$(hash_file "$PROJECT_ROOT/.claude/settings.json")"
MCP_HASH="$(hash_file "$PROJECT_ROOT/.mcp.json")"
MCP_DECLARED="$(jq -r '.. | strings | select(test("@playwright/mcp@"))' "$PROJECT_ROOT/.mcp.json" 2>/dev/null | head -1 || true)"
CLI_VERSION="$(claude --version 2>/dev/null | head -1 || true)"
LOCALE="${LC_ALL:-${LC_CTYPE:-${LANG:-unavailable}}}"
TIMEZONE="$(date +%Z 2>/dev/null || echo unavailable)"
START_TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

jq -cn \
  --arg schema 'manifest.v1' --arg batch_id "$BATCH_ID" --arg casino_id "$CASINO_ID" --arg run_id "$RUN_ID" --arg trace_id "$TRACE_ID" \
  --arg workflow_version "$WORKFLOW_VERSION" --arg code_ref "workspace-sha256:$WORKSPACE_HASH" \
  --arg instructions_sha "$(hash_file "$INSTRUCTIONS")" --arg rubric_sha "$RUBRICS_HASH" --arg success_sha "$(hash_file "$SUCCESS")" \
  --arg skills_sha "$SKILLS_HASH" --arg settings_sha "$SETTINGS_HASH" --arg input_sha "$(hash_file "$INPUT")" --arg expected_sha "$(hash_file "$EXPECTED_COPY")" \
  --arg model_id "$MODEL" --arg cli_version "$CLI_VERSION" --arg playwright_declared "$MCP_DECLARED" --arg mcp_sha "$MCP_HASH" \
  --arg locale "$LOCALE" --arg timezone "$TIMEZONE" --arg created_at "$START_TS" \
  --arg input_ref "$(rel "$INPUT")" --arg instructions_ref "$(rel "$INSTRUCTIONS")" --arg success_ref "$(rel "$SUCCESS")" --arg expected_ref "$(rel "$EXPECTED_COPY")" \
  --arg trace_ref "$(rel "$TRACE")" --arg index_ref "$(rel "$INDEX")" --arg metrics_ref "$(rel "$METRICS")" --arg comparison_ref "$(rel "$COMPARISON")" --arg failures_ref "$(rel "$FAILURES")" \
  --argjson files "$WORKSPACE_FILES" \
  '{schema:$schema,batch_id:$batch_id,casino_id:$casino_id,run_id:$run_id,trace_id:$trace_id,created_at:$created_at,immutable:true,fingerprint:{workflow_version:$workflow_version,code_ref:$code_ref,instructions_sha256:$instructions_sha,rubric_schema_sha256:$rubric_sha,success_criteria_sha256:$success_sha,skills_manifest_sha256:$skills_sha,settings_sha256:$settings_sha,casino_input_sha256:$input_sha,expected_plan_sha256:$expected_sha,model_id:(if ($model_id|length)>0 then $model_id else null end),model_release_or_alias:(if ($model_id|length)>0 then $model_id else null end),cli_version:(if ($cli_version|length)>0 then $cli_version else null end),playwright_mcp_declared:(if ($playwright_declared|length)>0 then $playwright_declared else null end),playwright_mcp_version:null,browser_name:null,browser_version:null,environment:"local-claude-code",locale:$locale,timezone:$timezone,mcp_config_sha256:$mcp_sha},refs:{casino_input:$input_ref,instructions:$instructions_ref,success_criteria:$success_ref,expected_plan:$expected_ref,trace:$trace_ref,trace_index:$index_ref,metrics:$metrics_ref,comparison:$comparison_ref,failures:$failures_ref},workspace_files:$files,unavailable:["playwright_mcp_version","browser_name","browser_version"]}' > "$MANIFEST.tmp.$$"
mv "$MANIFEST.tmp.$$" "$MANIFEST"
FINGERPRINT_REF="$(rel "$MANIFEST")"

jq -cn \
  --arg schema 'casino-observability-context.v1' --arg batch_id "$BATCH_ID" --arg casino_id "$CASINO_ID" --arg run_id "$RUN_ID" --arg trace_id "$TRACE_ID" \
  --arg fingerprint_ref "$FINGERPRINT_REF" --arg project_root "$PROJECT_ROOT" --arg trace "$TRACE" --arg index "$INDEX" --arg metrics "$METRICS" --arg comparison "$COMPARISON" --arg failures "$FAILURES" --arg expected "$EXPECTED_COPY" --arg manifest "$MANIFEST" --arg started_at "$START_TS" --arg model_id "$MODEL" \
  '{schema:$schema,active:true,batch_id:$batch_id,casino_id:$casino_id,run_id:$run_id,trace_id:$trace_id,fingerprint_ref:$fingerprint_ref,session_id:null,unit_id:null,stage_id:null,component_id:"casino-batch",worker_id:null,attempt_id:"attempt-1",expected_node_id:"run",model_id:(if ($model_id|length)>0 then $model_id else null end),started_at:$started_at,project_root:$project_root,manifest_path_abs:$manifest,expected_path_abs:$expected,trace_path_abs:$trace,index_path_abs:$index,metrics_path_abs:$metrics,comparison_path_abs:$comparison,failures_path_abs:$failures}' > "$CURRENT.tmp.$$"
mv "$CURRENT.tmp.$$" "$CURRENT"

jq -cn --arg schema 'run-receipt.v1' --arg kind 'start' --arg batch_id "$BATCH_ID" --arg casino_id "$CASINO_ID" --arg run_id "$RUN_ID" --arg trace_id "$TRACE_ID" --arg ts "$START_TS" --arg fingerprint_ref "$FINGERPRINT_REF" --arg manifest_ref "$(rel "$MANIFEST")" '{schema:$schema,kind:$kind,batch_id:$batch_id,casino_id:$casino_id,run_id:$run_id,trace_id:$trace_id,ts_utc:$ts,fingerprint_ref:$fingerprint_ref,manifest_ref:$manifest_ref,status:"started"}' > "$START_RECEIPT.tmp.$$"
mv "$START_RECEIPT.tmp.$$" "$START_RECEIPT"

CASINO_OBS_CONTEXT_FILE="$CURRENT" "$TRACER" emit run.start start "$(jq -cn --arg ref "$(rel "$START_RECEIPT")" '{_output_refs:[$ref],receipt_ref:$ref}')"
CASINO_OBS_CONTEXT_FILE="$CURRENT" "$TRACER" emit run.config ok "$(jq -cn --arg manifest "$(rel "$MANIFEST")" --arg expected "$(rel "$EXPECTED_COPY")" --arg workflow "$WORKFLOW_VERSION" --arg model "$MODEL" '{_input_refs:[$manifest,$expected],manifest_ref:$manifest,expected_plan_ref:$expected,workflow_version:$workflow,model_id:(if ($model|length)>0 then $model else null end),token_usage:{source:"unavailable",unavailable_reason:"run_not_started"}}')"

jq -cn --arg run_id "$RUN_ID" --arg context_ref "$(rel "$CURRENT")" --arg manifest_ref "$(rel "$MANIFEST")" --arg trace_ref "$(rel "$TRACE")" '{run_id:$run_id,context_ref:$context_ref,manifest_ref:$manifest_ref,trace_ref:$trace_ref}'

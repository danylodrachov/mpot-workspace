#!/usr/bin/env bash
# Claude Code hook + semantic event writer. Local files only; no network/API/collector.
set -u
umask 077
MAX_INPUT_BYTES="${CASINO_OBS_MAX_INPUT_BYTES:-20971520}"  # 20 MiB stdin ceiling (bounded parse)

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime/casino"
OBS_ROOT="$RUNTIME_ROOT/observability"
ERROR_LOG="$OBS_ROOT/errors.log"

# Storage hardening: reject symlinked runtime roots; require textual project containment.
case "$OBS_ROOT" in "$PROJECT_ROOT"/*) : ;; *) exit 0 ;; esac
for _p in "$PROJECT_ROOT/.runtime" "$RUNTIME_ROOT" "$OBS_ROOT"; do
  if [ -L "$_p" ]; then
    printf '%s\tsymlinked_runtime_root_rejected:%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$_p" >> "$OBS_ROOT/errors.log" 2>/dev/null || true
    exit 0
  fi
done
mkdir -p -m 700 "$OBS_ROOT" 2>/dev/null || mkdir -p "$OBS_ROOT" 2>/dev/null || true
chmod 700 "$RUNTIME_ROOT" "$OBS_ROOT" 2>/dev/null || true  # tighten dirs a sibling script may have created 755

log_error() {
  local msg="$1"
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$msg" >> "$ERROR_LOG" 2>/dev/null || true
}

if ! command -v jq >/dev/null 2>&1; then
  log_error "jq_unavailable"
  exit 0
fi

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | awk '{print $NF}'
  else cksum | awk '{print $1}'
  fi
}

_HASH_METHOD=""
_detect_hash() {
  [ -n "$_HASH_METHOD" ] && return 0
  if command -v md5 >/dev/null 2>&1; then _HASH_METHOD="md5"
  elif command -v md5sum >/dev/null 2>&1; then _HASH_METHOD="md5sum"
  else _HASH_METHOD="sha256"; fi
}
hash_text() {
  _detect_hash
  case "$_HASH_METHOD" in
    md5) md5 -qs "$1" ;;
    md5sum) printf '%s' "$1" | md5sum | awk '{print $1}' ;;
    sha256) printf '%s' "$1" | sha256_stream ;;
  esac
}

new_id() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
  else hash_text "$(date +%s 2>/dev/null)-$$-${RANDOM:-0}-$(date +%N 2>/dev/null || true)" | cut -c1-32
  fi
}

# Portable millisecond clock. Caches the working method (global, process-lifetime) so a hook
# invocation that emits several events only pays the probe cost once. `date +%s%3N` is a GNU
# extension; macOS BSD date silently emits the literal "%3N" suffix instead of failing, so we
# validate the output shape (13+ numeric digits) rather than trusting the exit code.
NOW_MS_METHOD=""
NOW_MS_VALUE=""
NOW_MS_PRECISION=""

_is_ms_digits() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -ge 13 ]
}

detect_now_ms_method() {
  [ -n "$NOW_MS_METHOD" ] && return 0
  local v
  if command -v gdate >/dev/null 2>&1; then
    v="$(gdate +%s%3N 2>/dev/null || true)"
    if _is_ms_digits "$v"; then NOW_MS_METHOD="gdate"; return 0; fi
  fi
  v="$(date +%s%3N 2>/dev/null || true)"
  if _is_ms_digits "$v"; then NOW_MS_METHOD="date_native"; return 0; fi
  if command -v perl >/dev/null 2>&1; then
    v="$(perl -MTime::HiRes=time -e 'print int(time()*1000)' 2>/dev/null || true)"
    case "$v" in ''|*[!0-9]*) : ;; *) NOW_MS_METHOD="perl"; return 0 ;; esac
  fi
  if command -v python3 >/dev/null 2>&1; then
    v="$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || true)"
    case "$v" in ''|*[!0-9]*) : ;; *) NOW_MS_METHOD="python3"; return 0 ;; esac
  fi
  NOW_MS_METHOD="seconds"
}

# Sets NOW_MS_VALUE (epoch ms, always numeric) and NOW_MS_PRECISION ("ms" or "s").
# Called directly (never via command substitution) so the method cache is a true process
# global instead of being lost to a subshell on every call.
# Within a single hook invocation, subsequent calls increment the cached value by 1
# to preserve ordering without paying the subprocess cost again.
_NOW_MS_SEEDED=0
now_ms() {
  if [ "$_NOW_MS_SEEDED" -gt 0 ] && [ -n "$NOW_MS_VALUE" ]; then
    NOW_MS_VALUE=$((NOW_MS_VALUE + 1))
    return 0
  fi
  detect_now_ms_method
  case "$NOW_MS_METHOD" in
    gdate) NOW_MS_VALUE="$(gdate +%s%3N 2>/dev/null || true)" ;;
    date_native) NOW_MS_VALUE="$(date +%s%3N 2>/dev/null || true)" ;;
    perl) NOW_MS_VALUE="$(perl -MTime::HiRes=time -e 'print int(time()*1000)' 2>/dev/null || true)" ;;
    python3) NOW_MS_VALUE="$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || true)" ;;
    *) NOW_MS_VALUE="" ;;
  esac
  if [ "$NOW_MS_METHOD" != "seconds" ] && _is_ms_digits "$NOW_MS_VALUE"; then
    NOW_MS_PRECISION="ms"
  else
    NOW_MS_VALUE="$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))"
    NOW_MS_PRECISION="s"
    NOW_MS_METHOD="seconds"
  fi
  _NOW_MS_SEEDED=1
}

json_bytes() { printf '%s' "$1" | wc -c | tr -d ' '; }

json_hash() {
  local value="$1" canonical
  canonical="$(printf '%s' "$value" | jq -cS '.' 2>/dev/null || printf '%s' "$value")"
  hash_text "$canonical"
}

safe_rel_path() {
  local path="$1"
  case "$path" in
    *credentials*|*.env|*.env.*|*.pem|*.key|*/.git/*|*/cookies*|*/token*) printf '%s' '<REDACTED_PATH>' ;;
    "$PROJECT_ROOT"/*) printf '%s' "${path#"$PROJECT_ROOT"/}" ;;
    *) printf '%s' "$path" ;;
  esac
}

sanitize_url() {
  local url="$1"
  url="$(printf '%s' "$url" | sed -E 's/[?#].*$//')"                       # drop query + fragment
  url="$(printf '%s' "$url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#')"  # drop userinfo
  printf '%s' "${url:0:512}"                                                # cap length
}

lock_age() {
  local lockdir="$1" now mt
  now="$(date +%s 2>/dev/null || echo 0)"
  mt="$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo "$now")"
  echo "$(( now - mt ))"
}

acquire_lock() {
  local lockdir="$1" i=0 holder age
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Stale-lock recovery: steal if owner PID is dead, or the lock is older than 30s.
    holder="$(cat "$lockdir/pid" 2>/dev/null || echo '')"
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; }; then
      rm -f "$lockdir/pid" "$lockdir/ts" 2>/dev/null; rmdir "$lockdir" 2>/dev/null; continue
    fi
    age="$(lock_age "$lockdir")"
    if [ "${age:-0}" -gt 30 ] 2>/dev/null; then
      rm -f "$lockdir/pid" "$lockdir/ts" 2>/dev/null; rmdir "$lockdir" 2>/dev/null; continue
    fi
    i=$((i+1))
    if [ "$i" -gt 500 ]; then return 1; fi
    sleep 0.01
  done
  printf '%s\n' "$$" > "$lockdir/pid" 2>/dev/null || true
  date +%s > "$lockdir/ts" 2>/dev/null || true
  return 0
}

release_lock() { rm -f "$1/pid" "$1/ts" 2>/dev/null || true; rmdir "$1" 2>/dev/null || true; }

unbound_context() {
  local session_id="$1" dir
  dir="$OBS_ROOT/unbound/$session_id"
  mkdir -p "$dir"
  jq -n \
    --arg project_root "$PROJECT_ROOT" \
    --arg session_id "$session_id" \
    --arg trace_path "$dir/trace.jsonl" \
    --arg index_path "$dir/trace-index.json" \
    '{schema:"casino-observability-context.v1",active:false,batch_id:"_unbound",casino_id:"_unbound",run_id:("unbound-"+$session_id),trace_id:("unbound-"+$session_id),fingerprint_ref:"unavailable",session_id:$session_id,unit_id:null,stage_id:null,component_id:"claude-code-hook",worker_id:null,attempt_id:null,expected_node_id:null,project_root:$project_root,trace_path_abs:$trace_path,index_path_abs:$index_path,reason_code:"active_run_context_missing"}'
}

bind_session_context() {
  local session_id="$1" model="$2" source="$3"
  local sessions_dir current target tmp
  sessions_dir="$OBS_ROOT/sessions"
  current="$OBS_ROOT/current-context.json"
  target="$sessions_dir/$session_id.json"
  mkdir -p "$sessions_dir"
  if [ -s "$target" ]; then printf '%s' "$target"; return 0; fi
  tmp="$target.tmp.$$"
  if [ -s "$current" ] && [ "$(jq -r '.active // false' "$current" 2>/dev/null)" = "true" ]; then
    jq --arg session_id "$session_id" --arg model "$model" --arg source "$source" \
      '.session_id=$session_id | .model_id=(if ($model|length)>0 then $model else .model_id end) | .session_source=$source | .bound_at=(now|todateiso8601)' \
      "$current" > "$tmp" 2>/dev/null || return 1
  else
    unbound_context "$session_id" > "$tmp" || return 1
  fi
  mv "$tmp" "$target"
  printf '%s' "$target"
}

context_for_session() {
  local session_id="$1" target current tmp target_run current_run
  target="$OBS_ROOT/sessions/$session_id.json"
  current="$OBS_ROOT/current-context.json"
  if [ -s "$target" ]; then
    if [ -s "$current" ]; then
      target_run="$(jq -r '.run_id // empty' "$target" 2>/dev/null)"
      current_run="$(jq -r '.run_id // empty' "$current" 2>/dev/null)"
      if [ -n "$target_run" ] && [ "$target_run" = "$current_run" ]; then
        tmp="$target.tmp.$$"
        jq -s '.[0] as $s | .[1] as $c | $s + ($c | {active,unit_id,stage_id,component_id,worker_id,attempt_id,expected_node_id,terminal_requested,terminal_technical_status,terminal_business_quality_status,terminal_reason,terminal_requested_at}) | .session_id=$s.session_id | .model_id=($s.model_id // $c.model_id) | .session_source=$s.session_source' "$target" "$current" > "$tmp" 2>/dev/null && mv "$tmp" "$target"
      fi
    fi
    printf '%s' "$target"
  elif [ -s "$current" ] && [ "$(jq -r '.active // false' "$current" 2>/dev/null)" = "true" ]; then printf '%s' "$current"
  else
    mkdir -p "$OBS_ROOT/unbound/$session_id"
    unbound_context "$session_id" > "$OBS_ROOT/unbound/$session_id/context.json"
    printf '%s' "$OBS_ROOT/unbound/$session_id/context.json"
  fi
}

span_key_for() {
  local event_type="$1" session_id="$2" tool_call_id="$3" worker_id="$4" run_id="$5" unit_id="$6" stage_id="$7"
  case "$event_type" in
    session.start|session.end) printf 'session:%s' "$session_id" ;;
    tool.start|tool.end|tool.error) printf 'tool:%s' "${tool_call_id:-unknown}" ;;
    worker.start|worker.result|worker.end) printf 'worker:%s' "${worker_id:-unknown}" ;;
    worker.assigned) printf 'assignment:%s' "${worker_id:-unknown}" ;;
    run.start|run.end|run.config) printf 'run:%s' "$run_id" ;;
    run.result) printf 'receipt:%s' "$run_id" ;;
    unit.claimed|unit.completed) printf 'unit:%s' "${unit_id:-unknown}" ;;
    stage.start|stage.end) printf 'stage:%s' "${stage_id:-unknown}" ;;
    checkpoint.start|checkpoint.end|checkpoint.reconcile) printf 'checkpoint:%s:%s' "${unit_id:-unknown}" "${stage_id:-unknown}" ;;
    *) printf 'event:%s:%s' "$event_type" "$(new_id)" ;;
  esac
}

parent_span_for() {
  local event_type="$1" trace_id="$2" session_id="$3" run_id="$4" unit_id="$5" stage_id="$6"
  case "$event_type" in
    run.*) printf '' ;;
    session.*) hash_text "$trace_id|run:$run_id" | cut -c1-32 ;;
    tool.*|worker.*|context.snapshot|payload.*|turn.*) hash_text "$trace_id|session:$session_id" | cut -c1-32 ;;
    unit.*|stage.*|checkpoint.*) hash_text "$trace_id|run:$run_id" | cut -c1-32 ;;
    field.*|coverage.*|rubric.*|validation.*|quality.*|artifact.*|handoff.*|failure.*|divergence.*|retry.*|repeat.*|work.*) 
      if [ -n "$stage_id" ] && [ "$stage_id" != "null" ]; then hash_text "$trace_id|stage:$stage_id" | cut -c1-32
      elif [ -n "$unit_id" ] && [ "$unit_id" != "null" ]; then hash_text "$trace_id|unit:$unit_id" | cut -c1-32
      else hash_text "$trace_id|run:$run_id" | cut -c1-32; fi ;;
    *) hash_text "$trace_id|run:$run_id" | cut -c1-32 ;;
  esac
}

_BCTX_FILE="" _BCTX_batch="" _BCTX_casino="" _BCTX_run="" _BCTX_trace_id="" _BCTX_fp=""
_BCTX_sid="" _BCTX_uid="" _BCTX_stg="" _BCTX_comp="" _BCTX_wid="" _BCTX_att="" _BCTX_enid="" _BCTX_trace=""

append_event() {
  local context_file="$1" event_type="$2" status="$3" attrs_json="$4"
  local session_override="${5:-}" tool_override="${6:-}" worker_override="${7:-}"
  local batch_id casino_id run_id trace_id fingerprint_ref session_id unit_id stage_id component_id worker_id attempt_id expected_node_id
  local trace_path seq_file emitter_dir lockdir seq emitter_seq event_id emitter_id ts mono tool_call_id artifact_id page_id
  local span_key span_id parent_span_id parent_event_id input_refs output_refs proof_refs clean_attrs event_json span_start_dir mono_precision

  [ -s "$context_file" ] || { log_error "context_missing:$context_file"; return 0; }
  if [ "$context_file" != "$_BCTX_FILE" ] || [ -z "$_BCTX_trace" ]; then
    local _bctx
    _bctx="$(jq -r '(.batch_id // "_unbound"), (.casino_id // "_unbound"), (.run_id // "unbound"), (.trace_id // .run_id // "unbound"), (.fingerprint_ref // "unavailable"), (.session_id // ""), (.unit_id // ""), (.stage_id // ""), (.component_id // "unknown"), (.worker_id // ""), (.attempt_id // ""), (.expected_node_id // ""), (.trace_path_abs // "")' "$context_file" 2>/dev/null)" || { log_error "context_parse_failed:$context_file"; return 0; }
    { IFS= read -r _BCTX_batch; IFS= read -r _BCTX_casino; IFS= read -r _BCTX_run; IFS= read -r _BCTX_trace_id; IFS= read -r _BCTX_fp; IFS= read -r _BCTX_sid; IFS= read -r _BCTX_uid; IFS= read -r _BCTX_stg; IFS= read -r _BCTX_comp; IFS= read -r _BCTX_wid; IFS= read -r _BCTX_att; IFS= read -r _BCTX_enid; IFS= read -r _BCTX_trace; } <<< "$_bctx"
    _BCTX_FILE="$context_file"
  fi
  batch_id="$_BCTX_batch"; casino_id="$_BCTX_casino"; run_id="$_BCTX_run"; trace_id="$_BCTX_trace_id"
  fingerprint_ref="$_BCTX_fp"; session_id="${session_override:-$_BCTX_sid}"; unit_id="$_BCTX_uid"
  stage_id="$_BCTX_stg"; component_id="$_BCTX_comp"; worker_id="${worker_override:-$_BCTX_wid}"
  attempt_id="$_BCTX_att"; expected_node_id="$_BCTX_enid"; trace_path="$_BCTX_trace"
  [ -n "$trace_path" ] || { log_error "trace_path_missing:$context_file"; return 0; }
  mkdir -p -m 700 "$(dirname "$trace_path")" "$OBS_ROOT/seq" "$OBS_ROOT/emitter-seq" "$OBS_ROOT/span-starts/$run_id" 2>/dev/null || mkdir -p "$(dirname "$trace_path")" "$OBS_ROOT/seq" "$OBS_ROOT/emitter-seq" "$OBS_ROOT/span-starts/$run_id"

  local _ap _attr_tcid
  _ap="$(printf '%s' "$attrs_json" | jq -r '(._tool_call_id // ""), (._artifact_id // ""), (._page_id // ""), (._input_refs // [] | @json), (._output_refs // [] | @json), (._proof_refs // [] | @json), (del(._tool_call_id,._artifact_id,._page_id,._input_refs,._output_refs,._proof_refs) | @json)' 2>/dev/null)" || _ap=""
  if [ -n "$_ap" ]; then
    { IFS= read -r _attr_tcid; IFS= read -r artifact_id; IFS= read -r page_id; IFS= read -r input_refs; IFS= read -r output_refs; IFS= read -r proof_refs; IFS= read -r clean_attrs; } <<< "$_ap"
    tool_call_id="${tool_override:-$_attr_tcid}"
  else
    tool_call_id="${tool_override:-}"; artifact_id=""; page_id=""; input_refs="[]"; output_refs="[]"; proof_refs="[]"; clean_attrs="{}"
  fi
  local otel_json
  if [ -n "${TRACEPARENT:-}" ]; then
    local otel_trace_id otel_parent_span_id
    otel_trace_id="${TRACEPARENT#*-}"; otel_trace_id="${otel_trace_id%%-*}"
    otel_parent_span_id="${TRACEPARENT#*-*-}"; otel_parent_span_id="${otel_parent_span_id%%-*}"
    otel_json="{\"source\":\"claude_code_builtin_traceparent\",\"trace_id\":\"$otel_trace_id\",\"parent_span_id\":\"$otel_parent_span_id\"}"
  else
    otel_json='{"source":"unavailable","unavailable_reason":"TRACEPARENT_not_exposed_to_hook"}'
  fi

  emitter_id="hook:${event_type%%.*}"
  seq_file="$OBS_ROOT/seq/$run_id.seq"
  emitter_dir="$OBS_ROOT/emitter-seq/$run_id"
  mkdir -p "$emitter_dir"
  lockdir="$trace_path.lock"
  if ! acquire_lock "$lockdir"; then log_error "trace_lock_timeout:$trace_path"; return 0; fi

  # Partial-line recovery: if a prior append was SIGKILLed mid-write, the file will not
  # end in a newline. Terminate the truncated line so the next event lands on its own line;
  # finalize.sh quarantines any resulting non-JSON line.
  if [ -s "$trace_path" ] && [ -n "$(tail -c1 "$trace_path" 2>/dev/null)" ]; then
    printf '\n' >> "$trace_path" 2>/dev/null || true
    log_error "partial_line_healed:$trace_path"
  fi

  # Crash-safe monotonic seq: reconcile the cached counter with the authoritative line count,
  # so a SIGKILL between append and seq-file update can never reissue a used seq.
  local trace_lines
  seq=0; [ -s "$seq_file" ] && seq="$(cat "$seq_file" 2>/dev/null || echo 0)"
  trace_lines=0; [ -f "$trace_path" ] && trace_lines="$(wc -l < "$trace_path" 2>/dev/null | tr -d ' ')"; [ -n "$trace_lines" ] || trace_lines=0
  case "$seq" in ''|*[!0-9]*) seq=0;; esac
  [ "$trace_lines" -gt "$seq" ] 2>/dev/null && seq="$trace_lines"
  seq=$((seq+1))
  emitter_seq=0; [ -s "$emitter_dir/${emitter_id//:/_}.seq" ] && emitter_seq="$(cat "$emitter_dir/${emitter_id//:/_}.seq" 2>/dev/null || echo 0)"
  case "$emitter_seq" in ''|*[!0-9]*) emitter_seq=0;; esac
  emitter_seq=$((emitter_seq+1))
  event_id="evt-$(new_id)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date)"
  now_ms
  mono="$NOW_MS_VALUE"
  mono_precision="$NOW_MS_PRECISION"
  span_key="$(span_key_for "$event_type" "$session_id" "$tool_call_id" "$worker_id" "$run_id" "$unit_id" "$stage_id")"
  span_id="$(hash_text "$trace_id|$span_key" | cut -c1-32)"
  parent_span_id="$(parent_span_for "$event_type" "$trace_id" "$session_id" "$run_id" "$unit_id" "$stage_id")"
  span_start_dir="$OBS_ROOT/span-starts/$run_id"
  parent_event_id=""
  [ -s "$span_start_dir/$parent_span_id" ] && parent_event_id="$(cat "$span_start_dir/$parent_span_id" 2>/dev/null || true)"

  event_json="$(jq -cn \
    --arg schema 'trace.v2' --arg event_id "$event_id" --arg trace_id "$trace_id" --arg span_id "$span_id" \
    --arg parent_span_id "$parent_span_id" --arg parent_event_id "$parent_event_id" --arg expected_node_id "$expected_node_id" \
    --arg batch_id "$batch_id" --arg casino_id "$casino_id" --arg run_id "$run_id" --arg session_id "$session_id" \
    --arg unit_id "$unit_id" --arg stage_id "$stage_id" --arg component_id "$component_id" --arg worker_id "$worker_id" \
    --arg attempt_id "$attempt_id" --arg tool_call_id "$tool_call_id" --arg artifact_id "$artifact_id" --arg page_id "$page_id" \
    --arg emitter_id "$emitter_id" --arg event_type "$event_type" --arg status "$status" --arg fingerprint_ref "$fingerprint_ref" \
    --arg ts "$ts" --argjson mono "$mono" --arg mono_precision "$mono_precision" --arg mono_source "$NOW_MS_METHOD" --argjson seq "$seq" --argjson emitter_seq "$emitter_seq" \
    --argjson input_refs "$input_refs" --argjson output_refs "$output_refs" --argjson proof_refs "$proof_refs" --argjson attrs "$clean_attrs" --argjson otel "$otel_json" \
    '{schema:$schema,event_id:$event_id,trace_id:$trace_id,span_id:$span_id,parent_span_id:(if ($parent_span_id|length)>0 then $parent_span_id else null end),parent_event_id:(if ($parent_event_id|length)>0 then $parent_event_id else null end),expected_node_id:(if ($expected_node_id|length)>0 then $expected_node_id else null end),batch_id:$batch_id,casino_id:$casino_id,run_id:$run_id,session_id:(if ($session_id|length)>0 then $session_id else null end),unit_id:(if ($unit_id|length)>0 then $unit_id else null end),stage_id:(if ($stage_id|length)>0 then $stage_id else null end),component_id:$component_id,worker_id:(if ($worker_id|length)>0 then $worker_id else null end),attempt_id:(if ($attempt_id|length)>0 then $attempt_id else null end),tool_call_id:(if ($tool_call_id|length)>0 then $tool_call_id else null end),artifact_id:(if ($artifact_id|length)>0 then $artifact_id else null end),page_id:(if ($page_id|length)>0 then $page_id else null end),emitter_id:$emitter_id,event_type:$event_type,seq:$seq,emitter_seq:$emitter_seq,ts_utc:$ts,mono_ms:$mono,mono_ms_precision:$mono_precision,mono_ms_source:$mono_source,status:$status,reason_code:($attrs.reason_code // null),fingerprint_ref:$fingerprint_ref,input_refs:$input_refs,output_refs:$output_refs,proof_refs:$proof_refs,attrs:($attrs+{otel:$otel})}')"

  printf '%s\n' "$event_json" >> "$trace_path"
  chmod 600 "$trace_path" 2>/dev/null || true
  printf '%s\n' "$seq" > "$seq_file.tmp.$$" && mv "$seq_file.tmp.$$" "$seq_file"
  printf '%s\n' "$emitter_seq" > "$emitter_dir/${emitter_id//:/_}.seq.tmp.$$" && mv "$emitter_dir/${emitter_id//:/_}.seq.tmp.$$" "$emitter_dir/${emitter_id//:/_}.seq"
  case "$event_type" in
    session.start|tool.start|worker.start|run.start|unit.claimed|stage.start|checkpoint.start) printf '%s\n' "$event_id" > "$span_start_dir/$span_id" ;;
  esac
  release_lock "$lockdir"
}

hook_attrs() {
  local input="$1" hook_event="$2" tool_name path url err_len last_len prompt_len keys input_bytes output_bytes source reason model agent_type
  local _ha
  _ha="$(printf '%s' "$input" | jq -r '(.tool_name // ""), (.tool_input.file_path // .file_path // ""), (.tool_input.url // .tool_input.href // ""), ((.error // .error_details // "")|length|tostring), ((.last_assistant_message // "")|length|tostring), ((.prompt // "")|length|tostring), ((.tool_input // {})|tostring|length|tostring), ((.tool_response // {})|tostring|length|tostring), (.source // ""), (.reason // ""), (.model // ""), (.agent_type // ""), (if (.tool_input // {} | type) == "object" then (.tool_input | keys | .[0:64] | @json) else "[]" end)' 2>/dev/null)" || _ha=""
  if [ -n "$_ha" ]; then
    { IFS= read -r tool_name; IFS= read -r path; IFS= read -r url; IFS= read -r err_len; IFS= read -r last_len; IFS= read -r prompt_len; IFS= read -r input_bytes; IFS= read -r output_bytes; IFS= read -r source; IFS= read -r reason; IFS= read -r model; IFS= read -r agent_type; IFS= read -r keys; } <<< "$_ha"
  else
    tool_name=""; path=""; url=""; err_len=0; last_len=0; prompt_len=0; input_bytes=0; output_bytes=0; source=""; reason=""; model=""; agent_type=""; keys="[]"
  fi
  jq -cn \
    --arg hook_event "$hook_event" --arg tool "$tool_name" \
    --argjson input_bytes "${input_bytes:-0}" --argjson output_bytes "${output_bytes:-0}" \
    --arg path "$(safe_rel_path "$path")" --arg url "$(sanitize_url "$url")" \
    --argjson error_length "${err_len:-0}" --argjson response_length "${last_len:-0}" --argjson prompt_length "${prompt_len:-0}" \
    --arg source "$source" --arg reason "$reason" --arg model "$model" --arg agent_type "$agent_type" \
    --argjson tool_input_keys "$keys" \
    '{hook_event:$hook_event,capture:"metadata",redaction:"content_hashes_removed",tool:(if ($tool|length)>0 then $tool else null end),operation:(if ($tool|length)>0 then $tool else null end),request_bytes:$input_bytes,response_bytes:$output_bytes,path:(if ($path|length)>0 then $path else null end),canonical_url:(if ($url|length)>0 then $url else null end),error_length:$error_length,assistant_response_length:$response_length,user_prompt_length:$prompt_length,source:(if ($source|length)>0 then $source else null end),end_reason:(if ($reason|length)>0 then $reason else null end),model_id:(if ($model|length)>0 then $model else null end),worker_role:(if ($agent_type|length)>0 then $agent_type else null end),tool_input_keys:$tool_input_keys,token_usage:{input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,total_tokens:null,source:"unavailable",unavailable_reason:"hook_payload_has_no_usage"}}'
}

emit_hook_event() {
  local input="$1" hook_event session_id model source context tool_call_id agent_id attrs path kind status batch_json
  local _ev _ev_tool_name _ev_file_path
  _ev="$(printf '%s' "$input" | jq -r '(.hook_event_name // ""), (.session_id // "unknown-session"), (.model // ""), (.source // ""), (.tool_use_id // ""), (.agent_id // ""), (.tool_name // ""), (.tool_input.file_path // "")' 2>/dev/null)"
  { IFS= read -r hook_event; IFS= read -r session_id; IFS= read -r model; IFS= read -r source; IFS= read -r tool_call_id; IFS= read -r agent_id; IFS= read -r _ev_tool_name; IFS= read -r _ev_file_path; } <<< "$_ev"
  if [ "$hook_event" = "SessionStart" ]; then context="$(bind_session_context "$session_id" "$model" "$source")" || context="$(context_for_session "$session_id")"
  else context="$(context_for_session "$session_id")"; fi
  attrs="$(hook_attrs "$input" "$hook_event")"

  case "$hook_event" in
    SessionStart) append_event "$context" 'session.start' 'start' "$attrs" "$session_id" '' '' ;;
    SessionEnd)
      append_event "$context" 'session.end' 'ok' "$attrs" "$session_id" '' ''
      finalizer="$PROJECT_ROOT/.claude/hooks/casino-observability-finalize.sh"
      if [ -x "$finalizer" ]; then
        if [ "$(jq -r '.terminal_requested // false' "$context" 2>/dev/null)" = "true" ]; then
          "$finalizer" --context "$context" --terminal \
            --technical-status "$(jq -r '.terminal_technical_status // "completed"' "$context")" \
            --business-quality-status "$(jq -r '.terminal_business_quality_status // "not_evaluable"' "$context")" \
            --reason "$(jq -r '.terminal_reason // empty' "$context")" >/dev/null 2>>"$ERROR_LOG" || log_error "terminal_finalize_failed:$session_id"
        else
          "$finalizer" --context "$context" --incremental >/dev/null 2>>"$ERROR_LOG" || log_error "incremental_finalize_failed:$session_id"
        fi
      fi
      ;;
    UserPromptSubmit) append_event "$context" 'model.invoke.start' 'start' "$attrs" "$session_id" '' '' ;;
    PreToolUse) append_event "$context" 'tool.start' 'start' "$attrs" "$session_id" "$tool_call_id" '' ;;
    PostToolUse)
      append_event "$context" 'tool.end' 'ok' "$attrs" "$session_id" "$tool_call_id" ''
      if [ -n "$_ev_file_path" ]; then
        kind="artifact.read"; case "$_ev_tool_name" in Write|Edit|NotebookEdit) kind="artifact.write";; esac
        local _art_id; _art_id="art-$(hash_text "$_ev_file_path" | cut -c1-24)"
        local _art_path; _art_path="$(safe_rel_path "$_ev_file_path")"
        append_event "$context" "$kind" 'ok' "{\"path\":\"$_art_path\",\"kind\":\"file\",\"_artifact_id\":\"$_art_id\"}" "$session_id" "$tool_call_id" ''
      fi ;;
    PostToolUseFailure)
      append_event "$context" 'tool.error' 'error' "{\"reason_code\":\"tool_execution_failed\"}" "$session_id" "$tool_call_id" ''
      append_event "$context" 'failure.detected' 'error' "{\"cause_class\":\"tool\",\"reason_code\":\"tool_execution_failed\"}" "$session_id" "$tool_call_id" '' ;;
    PostToolBatch)
      # Real payload shape is {tool_calls:[...]} only. Bounded structural parse: size + tool
      # name set (allowlisted metadata); never the per-call inputs/responses.
      batch_json="$(printf '%s' "$input" | jq -c '{batch_size:((.tool_calls|length)//0),batch_tools:([.tool_calls[]?.tool_name]|map(select(.!=null))|unique|.[0:64])}' 2>/dev/null || printf '{"batch_size":0,"batch_tools":[]}')"
      append_event "$context" 'tool.batch' 'ok' "$(printf '%s' "$attrs" | jq -c --argjson b "$batch_json" '. + $b')" "$session_id" '' '' ;;
    PermissionRequest) append_event "$context" 'tool.permission' 'start' "$attrs" "$session_id" "$tool_call_id" '' ;;
    PermissionDenied) append_event "$context" 'tool.error' 'error' "{\"reason_code\":\"permission_denied\"}" "$session_id" "$tool_call_id" '' ;;
    SubagentStart)
      append_event "$context" 'worker.assigned' 'start' "$(printf '%s' "$attrs" | jq '. + {assigned_by:"casino-session"}')" "$session_id" '' "$agent_id"
      append_event "$context" 'worker.start' 'start' "$attrs" "$session_id" '' "$agent_id" ;;
    SubagentStop)
      append_event "$context" 'worker.result' 'ok' "$attrs" "$session_id" '' "$agent_id"
      append_event "$context" 'worker.end' 'ok' "$attrs" "$session_id" '' "$agent_id" ;;
    Stop)
      append_event "$context" 'context.snapshot' 'ok' "$attrs" "$session_id" '' ''
      append_event "$context" 'model.invoke.end' 'ok' "$attrs" "$session_id" '' '' ;;
    StopFailure)
      append_event "$context" 'model.invoke.error' 'error' "$(printf '%s' "$attrs" | jq '. + {reason_code:"claude_api_failure"}')" "$session_id" '' ''
      append_event "$context" 'failure.detected' 'error' "$(printf '%s' "$attrs" | jq '. + {cause_class:"model",reason_code:"claude_api_failure"}')" "$session_id" '' '' ;;
    PreCompact) append_event "$context" 'context.snapshot' 'start' "$(printf '%s' "$attrs" | jq '. + {phase:"pre_compact"}')" "$session_id" '' '' ;;
    PostCompact) append_event "$context" 'context.snapshot' 'ok' "$(printf '%s' "$attrs" | jq '. + {phase:"post_compact"}')" "$session_id" '' '' ;;
    InstructionsLoaded) append_event "$context" 'artifact.read' 'ok' "$(printf '%s' "$attrs" | jq '. + {kind:"instructions"}')" "$session_id" '' '' ;;
    ConfigChange) append_event "$context" 'artifact.write' 'ok' "$(printf '%s' "$attrs" | jq '. + {kind:"configuration",reason_code:"config_change"}')" "$session_id" '' '' ;;
    TaskCreated) append_event "$context" 'work.assigned' 'start' "$attrs" "$session_id" '' '' ;;
    TaskCompleted) append_event "$context" 'work.completed' 'ok' "$attrs" "$session_id" '' '' ;;
    *) append_event "$context" "hook.${hook_event:-unknown}" 'ok' "$attrs" "$session_id" "$tool_call_id" "$agent_id" ;;
  esac
}

if [ "${1:-}" = "emit" ]; then
  event_type="${2:-}"; status="${3:-ok}"; attrs_json="${4-}"
  [ -n "$attrs_json" ] || attrs_json='{}'
  [ -n "$event_type" ] || { log_error "emit_event_type_missing"; exit 0; }
  if ! printf '%s' "$attrs_json" | jq -e . >/dev/null 2>&1; then log_error "emit_attrs_invalid_json:$event_type"; attrs_json='{"reason_code":"invalid_attrs_json"}'; fi
  context_file="${CASINO_OBS_CONTEXT_FILE:-$OBS_ROOT/current-context.json}"
  append_event "$context_file" "$event_type" "$status" "$attrs_json"
  exit 0
fi

# Active-run gating: no active casino context → skip hook event processing entirely.
# Prevents trace writes, lock acquisition, and I/O for normal non-casino sessions.
# Emit mode (above) is unaffected; lifecycle scripts (init/finalize/session-end) are separate.
if [ ! -s "$OBS_ROOT/current-context.json" ] || \
   [ "$(jq -r '.active // false' "$OBS_ROOT/current-context.json" 2>/dev/null)" != "true" ]; then
  exit 0
fi

INPUT="$(head -c "$MAX_INPUT_BYTES")"   # bounded read: never buffer an unbounded payload
if ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then log_error "hook_input_invalid_json_or_truncated"; exit 0; fi
emit_hook_event "$INPUT"
exit 0

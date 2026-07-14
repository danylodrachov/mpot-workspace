#!/usr/bin/env bash
# Atomic active-run context transitions used by casino skills/state-writer.
set -euo pipefail
umask 077
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
OBS_ROOT="$PROJECT_ROOT/.runtime/casino/observability"
CURRENT="$OBS_ROOT/current-context.json"
TRACER="$PROJECT_ROOT/.claude/hooks/casino-observability.sh"
command -v jq >/dev/null 2>&1 || { echo 'jq required' >&2; exit 2; }
[ -s "$CURRENT" ] || { echo 'active observability context missing' >&2; exit 3; }
[ -x "$TRACER" ] || { echo 'observability tracer missing' >&2; exit 3; }

ACTION="${1:-}"; shift || true
UNIT='' STAGE='' COMPONENT='' EXPECTED_NODE='' ATTEMPT='' TECHNICAL='' QUALITY='' REASON='' ARTIFACT_REF='' OUTPUT_REF=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit-id) UNIT="$2"; shift 2;;
    --stage-id) STAGE="$2"; shift 2;;
    --component-id) COMPONENT="$2"; shift 2;;
    --expected-node-id) EXPECTED_NODE="$2"; shift 2;;
    --attempt-id) ATTEMPT="$2"; shift 2;;
    --technical-status) TECHNICAL="$2"; shift 2;;
    --business-quality-status) QUALITY="$2"; shift 2;;
    --reason) REASON="$2"; shift 2;;
    --artifact-ref) ARTIFACT_REF="$2"; shift 2;;
    --output-ref) OUTPUT_REF="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

lock="$OBS_ROOT/context.lock"; i=0
lock_age() { local now mt; now="$(date +%s 2>/dev/null || echo 0)"; mt="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo "$now")"; echo "$(( now - mt ))"; }
while ! mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/pid" 2>/dev/null || echo '')"
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ "$(lock_age "$lock")" -gt 60 ] 2>/dev/null; then
    rm -f "$lock/pid" 2>/dev/null; rmdir "$lock" 2>/dev/null; continue
  fi
  i=$((i+1)); [ "$i" -lt 300 ] || { echo 'context lock timeout' >&2; exit 4; }; sleep 0.01
done
printf '%s\n' "$$" > "$lock/pid" 2>/dev/null || true
trap 'rm -f "$lock/pid" 2>/dev/null; rmdir "$lock" 2>/dev/null || true' EXIT

update_context() {
  local filter="$1" tmp="$CURRENT.tmp.$$"
  jq "$filter" "$CURRENT" > "$tmp" && mv "$tmp" "$CURRENT"
}
emit() { CASINO_OBS_CONTEXT_FILE="$CURRENT" "$TRACER" emit "$1" "$2" "$3"; }

case "$ACTION" in
  begin-unit)
    [ -n "$UNIT" ] && [ -n "$STAGE" ] && [ -n "$COMPONENT" ] || { echo 'begin-unit requires unit/stage/component' >&2; exit 2; }
    jq --arg u "$UNIT" --arg s "$STAGE" --arg c "$COMPONENT" --arg e "$EXPECTED_NODE" --arg a "${ATTEMPT:-attempt-1}" \
      '.unit_id=$u|.stage_id=$s|.component_id=$c|.expected_node_id=(if ($e|length)>0 then $e else $u end)|.attempt_id=$a|.unit_started_at=(now|todateiso8601)' "$CURRENT" > "$CURRENT.tmp.$$" && mv "$CURRENT.tmp.$$" "$CURRENT"
    attrs="$(jq -cn --arg unit "$UNIT" --arg stage "$STAGE" --arg component "$COMPONENT" --arg expected "${EXPECTED_NODE:-$UNIT}" '{unit_id:$unit,stage_id:$stage,component_id:$component,expected_node_id:$expected}')"
    emit unit.claimed start "$attrs"
    emit stage.start start "$attrs"
    ;;
  checkpoint-start)
    attrs="$(jq -cn --arg ref "$ARTIFACT_REF" '{artifact_ref:(if ($ref|length)>0 then $ref else null end),_input_refs:(if ($ref|length)>0 then [$ref] else [] end)}')"
    emit checkpoint.start start "$attrs"
    ;;
  checkpoint-end)
    attrs="$(jq -cn --arg ref "$ARTIFACT_REF" --arg reason "$REASON" '{artifact_ref:(if ($ref|length)>0 then $ref else null end),reason_code:(if ($reason|length)>0 then $reason else null end),_output_refs:(if ($ref|length)>0 then [$ref] else [] end)}')"
    emit checkpoint.end ok "$attrs"
    ;;
  reconcile)
    attrs="$(jq -cn --arg ref "$ARTIFACT_REF" --arg reason "$REASON" '{artifact_ref:(if ($ref|length)>0 then $ref else null end),reason_code:(if ($reason|length)>0 then $reason else "checkpoint_mismatch" end),_proof_refs:(if ($ref|length)>0 then [$ref] else [] end)}')"
    emit checkpoint.reconcile retry "$attrs"
    ;;
  end-unit)
    current_unit="$(jq -r '.unit_id // empty' "$CURRENT")"; current_stage="$(jq -r '.stage_id // empty' "$CURRENT")"
    [ -n "$current_unit" ] || { echo 'no active unit' >&2; exit 3; }
    attrs="$(jq -cn --arg unit "$current_unit" --arg stage "$current_stage" --arg technical "${TECHNICAL:-completed}" --arg quality "${QUALITY:-not_evaluable}" --arg output "$OUTPUT_REF" --arg reason "$REASON" '{unit_id:$unit,stage_id:$stage,technical_status:$technical,business_quality_status:$quality,reason_code:(if ($reason|length)>0 then $reason else null end),_output_refs:(if ($output|length)>0 then [$output] else [] end)}')"
    emit stage.end ok "$attrs"
    emit unit.completed ok "$attrs"
    jq --arg technical "${TECHNICAL:-completed}" --arg quality "${QUALITY:-not_evaluable}" '.last_unit_id=.unit_id|.last_stage_id=.stage_id|.last_component_id=.component_id|.last_unit_technical_status=$technical|.last_unit_business_quality_status=$quality|.unit_id=null|.stage_id=null|.component_id="casino-session"|.expected_node_id=null|.attempt_id=null|.unit_started_at=null' "$CURRENT" > "$CURRENT.tmp.$$" && mv "$CURRENT.tmp.$$" "$CURRENT"
    ;;
  set-component)
    [ -n "$COMPONENT" ] || { echo 'set-component requires component' >&2; exit 2; }
    jq --arg c "$COMPONENT" '.component_id=$c' "$CURRENT" > "$CURRENT.tmp.$$" && mv "$CURRENT.tmp.$$" "$CURRENT"
    ;;
  request-terminal)
    [ -n "$TECHNICAL" ] || TECHNICAL='completed'
    [ -n "$QUALITY" ] || QUALITY='not_evaluable'
    jq --arg technical "$TECHNICAL" --arg quality "$QUALITY" --arg reason "$REASON" '.terminal_requested=true|.terminal_technical_status=$technical|.terminal_business_quality_status=$quality|.terminal_reason=(if ($reason|length)>0 then $reason else null end)|.terminal_requested_at=(now|todateiso8601)' "$CURRENT" > "$CURRENT.tmp.$$" && mv "$CURRENT.tmp.$$" "$CURRENT"
    ;;
  *) echo 'usage: begin-unit|checkpoint-start|checkpoint-end|reconcile|end-unit|set-component|request-terminal' >&2; exit 2;;
esac

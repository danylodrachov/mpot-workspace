#!/usr/bin/env bash
# Materialize trace index, metrics, comparison, failure records, and terminal receipts.
set -euo pipefail
umask 077
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
OBS_ROOT="$PROJECT_ROOT/.runtime/casino/observability"
TRACER="$PROJECT_ROOT/.claude/hooks/casino-observability.sh"
CONTEXT="$OBS_ROOT/current-context.json"
TERMINAL=false TECHNICAL='' QUALITY='' REASON=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2;;
    --terminal) TERMINAL=true; shift;;
    --technical-status) TECHNICAL="$2"; shift 2;;
    --business-quality-status) QUALITY="$2"; shift 2;;
    --reason) REASON="$2"; shift 2;;
    --incremental) TERMINAL=false; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
command -v jq >/dev/null 2>&1 || { echo 'jq required' >&2; exit 2; }
[ -s "$CONTEXT" ] || { echo "context missing: $CONTEXT" >&2; exit 3; }
[ -x "$TRACER" ] || { echo 'tracer missing' >&2; exit 3; }

RUN_ID="$(jq -r '.run_id' "$CONTEXT")"
BATCH_ID="$(jq -r '.batch_id' "$CONTEXT")"
CASINO_ID="$(jq -r '.casino_id' "$CONTEXT")"
FINGERPRINT_REF="$(jq -r '.fingerprint_ref' "$CONTEXT")"
TRACE="$(jq -r '.trace_path_abs' "$CONTEXT")"
INDEX="$(jq -r '.index_path_abs' "$CONTEXT")"
METRICS="$(jq -r '.metrics_path_abs' "$CONTEXT")"
COMPARISON="$(jq -r '.comparison_path_abs' "$CONTEXT")"
FAILURES="$(jq -r '.failures_path_abs' "$CONTEXT")"
EXPECTED="$(jq -r '.expected_path_abs' "$CONTEXT")"
MANIFEST="$(jq -r '.manifest_path_abs' "$CONTEXT")"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime/casino"
END_RECEIPT="$RUNTIME_ROOT/runs/$RUN_ID.end.json"
RESULT_RECEIPT="$RUNTIME_ROOT/runs/$RUN_ID.result.json"
mkdir -p "$(dirname "$INDEX")" "$(dirname "$METRICS")" "$(dirname "$COMPARISON")" "$(dirname "$FAILURES")" "$(dirname "$END_RECEIPT")"
[ -f "$TRACE" ] || : > "$TRACE"

has_event() { jq -e --arg t "$1" 'select(.event_type==$t)' "$TRACE" >/dev/null 2>&1; }
emit() { CASINO_OBS_CONTEXT_FILE="$CONTEXT" "$TRACER" emit "$1" "$2" "$3"; }
rel() { case "$1" in "$PROJECT_ROOT"/*) printf '%s' "${1#"$PROJECT_ROOT"/}";; *) printf '%s' "$1";; esac; }
atomic_json() { local path="$1"; shift; "$@" > "$path.tmp.$$"; mv "$path.tmp.$$" "$path"; }

if $TERMINAL; then
  [ -n "$TECHNICAL" ] || TECHNICAL="$(jq -r '.terminal_technical_status // "completed"' "$CONTEXT")"
  [ -n "$QUALITY" ] || QUALITY="$(jq -r '.terminal_business_quality_status // "not_evaluable"' "$CONTEXT")"
  [ -n "$REASON" ] || REASON="$(jq -r '.terminal_reason // empty' "$CONTEXT")"
  if ! has_event quality.result; then
    emit quality.result ok "$(jq -cn --arg technical "$TECHNICAL" --arg quality "$QUALITY" --arg reason "$REASON" '{technical_status:$technical,business_quality_status:$quality,reason_code:(if ($reason|length)>0 then $reason else null end)}')"
  fi
  if ! has_event run.end; then
    emit run.end "$( [ "$TECHNICAL" = completed ] && echo ok || echo error )" "$(jq -cn --arg technical "$TECHNICAL" --arg quality "$QUALITY" --arg reason "$REASON" '{technical_status:$technical,business_quality_status:$quality,reason_code:(if ($reason|length)>0 then $reason else null end)}')"
  fi
fi

load_events() {
  local out="$1"
  if jq -s '.' "$TRACE" > "$out.tmp.$$" 2>/dev/null; then mv "$out.tmp.$$" "$out"; return 0; fi
  # Partial/corrupt-line recovery: keep valid JSON lines, quarantine the rest (never drop
  # silently, never rewrite the append-only trace). Only hard-fail if nothing is recoverable.
  rm -f "$out.tmp.$$" 2>/dev/null || true
  local clean="$OBS_ROOT/events-clean.$RUN_ID.$$.jsonl" bad=0 line
  : > "$clean"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if printf '%s' "$line" | jq -e . >/dev/null 2>&1; then printf '%s\n' "$line" >> "$clean"
    else printf '%s\n' "$line" >> "$OBS_ROOT/quarantine.$RUN_ID.jsonl"; bad=$((bad+1)); fi
  done < "$TRACE"
  if jq -s '.' "$clean" > "$out.tmp.$$" 2>/dev/null && [ "$(jq 'length' "$out.tmp.$$" 2>/dev/null || echo 0)" -gt 0 ]; then
    mv "$out.tmp.$$" "$out"; rm -f "$clean" 2>/dev/null || true
    echo "recovered trace: quarantined $bad corrupt line(s) -> $(rel "$OBS_ROOT/quarantine.$RUN_ID.jsonl")" >&2
    return 0
  fi
  rm -f "$clean" "$out.tmp.$$" 2>/dev/null || true
  jq -n --arg trace "$(rel "$TRACE")" '{schema:"trace-index.v1",validation_status:"fail",reason_code:"invalid_jsonl_unrecoverable",trace_ref:$trace}' > "$INDEX.tmp.$$" && mv "$INDEX.tmp.$$" "$INDEX"
  echo 'invalid trace JSONL (unrecoverable)' >&2
  exit 5
}

TMP_EVENTS="$OBS_ROOT/events.$RUN_ID.$$.json"
trap 'rm -f "$TMP_EVENTS" "$TMP_EVENTS.tmp.$$"' EXIT
load_events "$TMP_EVENTS"

# Emit first divergence for missing mandatory expected nodes when no direct divergence exists.
if $TERMINAL && ! has_event divergence.detected && [ -s "$EXPECTED" ]; then
  missing_first="$(jq -nr --slurpfile ev "$TMP_EVENTS" --slurpfile ex "$EXPECTED" '
    def expected_nodes: [($ex[0].flow_nodes[]? | {id:(.id // .node_id // .expected_node_id), mandatory:(.mandatory // true)}) | select(.id != null and .mandatory==true) | .id];
    def actual_nodes: [($ev[0][] | .expected_node_id) | select(. != null)] | unique;
    (expected_nodes - actual_nodes)[0] // empty')"
  if [ -n "$missing_first" ]; then
    emit divergence.detected error "$(jq -cn --arg expected "$missing_first" '{expected_node_id:$expected,divergence_type:"missing_mandatory_node",algorithm_version:"first-divergence.v2",reason_code:"expected_node_missing"}')"
    load_events "$TMP_EVENTS"
  fi
fi

write_index() {
  jq --arg trace_ref "$(rel "$TRACE")" --arg run_id "$RUN_ID" '
    . as $events |
    [$events[].event_type] as $types |
    (["run.start","run.config"] + (if ($types|index("run.end"))!=null then ["run.end","run.result","trace.validation"] else [] end)) as $required |
    [$required[] as $r | select(($types|index($r))==null) | $r] as $missing |
    [$events[].seq] as $seqs |
    [$events|group_by(.event_id)[] | select(length>1) | .[0].event_id] as $dups |
    ([$events[].span_id]|unique) as $span_ids |
    (([$events[].parent_span_id|select(.!=null)] - $span_ids)|unique) as $orphans |
    [
      {s:"run.start",e:["run.end"]},
      {s:"session.start",e:["session.end"]},
      {s:"tool.start",e:["tool.end","tool.error"]},
      {s:"worker.start",e:["worker.end"]},
      {s:"unit.claimed",e:["unit.completed"]},
      {s:"stage.start",e:["stage.end"]},
      {s:"checkpoint.start",e:["checkpoint.end","checkpoint.reconcile"]}
    ] as $pairs |
    ([$pairs[] as $p | $events[] | select(.event_type==$p.s) | .span_id as $sid | select(([$events[] | select(.span_id==$sid) | .event_type as $t | select(($p.e|index($t))!=null)]|length)==0) | $sid] | unique) as $open |
    ($seqs == [range(1;($events|length)+1)]) as $strict |
    {
      schema:"trace-index.v2",run_id:$run_id,trace_ref:$trace_ref,event_count:($events|length),
      seq_min:($seqs|min? // null),seq_max:($seqs|max? // null),seq_strict:$strict,
      spans:$span_ids,sessions:([$events[].session_id|select(.!=null)]|unique),stages:([$events[].stage_id|select(.!=null)]|unique),components:([$events[].component_id]|unique),
      failures:([$events[]|select(.event_type=="failure.detected")|.event_id]),retries:([$events[]|select(.event_type=="retry.scheduled")|.event_id]),repeats:([$events[]|select(.event_type=="repeat.detected")|.event_id]),skips:([$events[]|select(.event_type=="work.skipped")|.event_id]),
      first_divergence_event_id:([$events[]|select(.event_type=="divergence.detected")|.event_id][0] // null),
      terminal_event_id:([$events[]|select(.event_type=="run.result")|.event_id][-1] // null),
      artifact_refs:([$events[]|(.input_refs[]?,.output_refs[]?,.proof_refs[]?)]|unique),
      validation:{required_events:$required,missing_events:$missing,duplicate_event_ids:$dups,orphan_parent_spans:$orphans,unclosed_spans:$open},
      mandatory_event_completeness:(if ($required|length)==0 then null else (($required|length)-($missing|length))/($required|length) end),
      validation_status:(if ($missing|length)==0 and ($dups|length)==0 and ($orphans|length)==0 and ($open|length)==0 and $strict then "pass" else "fail" end)
    }' "$TMP_EVENTS" > "$INDEX.tmp.$$"
  mv "$INDEX.tmp.$$" "$INDEX"
}

write_metrics() {
  jq --arg batch "$BATCH_ID" --arg casino "$CASINO_ID" --arg run "$RUN_ID" --arg fp "$FINGERPRINT_REF" --arg trace_ref "$(rel "$TRACE")" --arg index_ref "$(rel "$INDEX")" --slurpfile idx "$INDEX" '
    def count_types: reduce .[] as $e ({}; .[$e.event_type] = ((.[$e.event_type] // 0)+1));
    def n($t): map(select(.event_type==$t))|length;
    def token_values($k): [.[]|.attrs.token_usage?[$k]?|numbers];
    def token_total($k): (token_values($k)) as $v | if ($v|length)>0 then ($v|add) else null end;
    def ratio($a;$b): if $a==null or $b==0 then null else $a/$b end;
    . as $e |
    ([.[].mono_ms]|min? // null) as $min |
    ([.[].mono_ms]|max? // null) as $max |
    (n("page.complete")) as $pages |
    (n("coverage.observed")) as $targets |
    (n("field.write")) as $fields |
    (token_total("total_tokens")) as $tokens |
    {
      schema:"metrics.v2",scope:{batch_id:$batch,casino_id:$casino,run_id:$run,fingerprint_ref:$fp,component_id:null,stage_id:null},
      counts:(count_types),
      durations_ms:{wall:(if $min==null or $max==null then null else $max-$min end),active:null,human_wait:null,unavailable_reason:"human_wait_events_not_emitted"},
      tokens:{input_tokens:token_total("input_tokens"),output_tokens:token_total("output_tokens"),cache_read_tokens:token_total("cache_read_tokens"),cache_write_tokens:token_total("cache_write_tokens"),total_tokens:$tokens,source:(if $tokens==null then "unavailable" else ([.[]|.attrs.token_usage?.source?|select(.!=null)]|unique) end),unavailable_reason:(if $tokens==null then "Claude_Code_OTel_not_ingested_into_local_semantic_trace" else null end)},
      coverage:{expected:n("coverage.expected"),observed:n("coverage.observed"),pages_completed:$pages,skipped:n("work.skipped"),duplicates:n("repeat.detected"),coverage_rate:null,unavailable_reason:"expected target cardinality absent unless coverage.expected events emitted"},
      outputs:{written_fields:$fields,missing_fields:n("field.missing"),conflicting_fields:n("field.conflict"),unsupported_fields:n("field.unsupported"),rubrics_completed:n("rubric.complete"),schema_valid:n("validation.result"),evidence_rate:null,unavailable_reason:"field.write evidence cardinality not derivable without field attrs"},
      outcomes:{technical_successes:([.[]|select(.event_type=="quality.result" and .attrs.technical_status=="completed")]|length),business_quality_passes:([.[]|select(.event_type=="quality.result" and .attrs.business_quality_status=="pass")]|length)},
      rework:{retries:n("retry.scheduled"),repeats:n("repeat.detected"),avoidable_repeats:([.[]|select(.event_type=="repeat.detected" and .attrs.avoidable==true)]|length),artifact_reuse:n("artifact.reuse")},
      dependencies:{tool_calls:n("tool.start"),tool_errors:n("tool.error"),fallbacks:n("dependency.fallback")},
      flow:{divergences:n("divergence.detected"),failures:n("failure.detected"),missing_expected_nodes:($idx[0].validation.missing_events|length)},
      reproducibility:{status:"not_evaluable",reason:"single_run_or_no_same_fingerprint_cohort"},
      trace_quality:$idx[0],
      throughput:{pages_per_hour:(if $min==null or $max==null or $max==$min then null else $pages/(($max-$min)/3600000) end),resolved_fields_per_hour:(if $min==null or $max==null or $max==$min then null else $fields/(($max-$min)/3600000) end)},
      diagnosis:{tokens_per_page:ratio($tokens;$pages),tokens_per_completed_target:ratio($tokens;$targets),tokens_per_resolved_field:ratio($tokens;$fields)},
      source_refs:[$trace_ref,$index_ref],calculation_version:"metrics-calc.v2-local"
    }' "$TMP_EVENTS" > "$METRICS.tmp.$$"
  mv "$METRICS.tmp.$$" "$METRICS"
}

write_comparison() {
  local technical="$TECHNICAL" quality="$QUALITY"
  [ -n "$technical" ] || technical="$(jq -r '[.[]|select(.event_type=="quality.result")|.attrs.technical_status][-1] // "intervention_required"' "$TMP_EVENTS")"
  [ -n "$quality" ] || quality="$(jq -r '[.[]|select(.event_type=="quality.result")|.attrs.business_quality_status][-1] // "not_evaluable"' "$TMP_EVENTS")"
  jq --arg batch "$BATCH_ID" --arg casino "$CASINO_ID" --arg run "$RUN_ID" --arg fp "$FINGERPRINT_REF" --arg expected_ref "$(rel "$EXPECTED")" --arg trace_ref "$(rel "$TRACE")" --arg index_ref "$(rel "$INDEX")" --arg metrics_ref "$(rel "$METRICS")" --arg technical "$technical" --arg quality "$quality" --slurpfile ex "$EXPECTED" --slurpfile idx "$INDEX" --slurpfile met "$METRICS" '
    def exp_nodes: [($ex[0].flow_nodes[]? | {id:(.id // .node_id // .expected_node_id),mandatory:(.mandatory // true)})|select(.id!=null)];
    def actual_nodes: [.[].expected_node_id|select(.!=null)]|unique;
    def eids: [exp_nodes[].id]|unique;
    . as $ev | (actual_nodes) as $actual | (eids) as $expected | ([exp_nodes[]|select(.mandatory==true)|.id]|unique) as $mandatory |
    ($mandatory-$actual) as $missing | ($actual-$expected) as $unexpected |
    ([.[]|select(.event_type=="divergence.detected")][0] // null) as $div |
    ($met[0].durations_ms.wall) as $wall |
    ($ex[0].performance_budget.duration_min? // null) as $minm |
    ($ex[0].performance_budget.duration_max? // null) as $maxm |
    {
      schema:"comparison.v2",batch_id:$batch,casino_id:$casino,run_id:$run,fingerprint_ref:$fp,baseline_ref:null,expected_ref:$expected_ref,
      actual_ref:$trace_ref,
      flow:{expected_nodes:$expected,actual_nodes:$actual,matched:($expected-($expected-$actual)),missing:$missing,unexpected:$unexpected,illegal_transitions:[],observability_gaps:$idx[0].validation.missing_events},
      coverage:{expected_events:([.[]|select(.event_type=="coverage.expected")]|length),observed_events:([.[]|select(.event_type=="coverage.observed")]|length),skipped:([.[]|select(.event_type=="work.skipped")]|length),duplicates:([.[]|select(.event_type=="repeat.detected")]|length)},
      outputs:{written:([.[]|select(.event_type=="field.write")]|length),missing:([.[]|select(.event_type=="field.missing")]|length),conflicts:([.[]|select(.event_type=="field.conflict")]|length),unsupported:([.[]|select(.event_type=="field.unsupported")]|length),rubrics_complete:([.[]|select(.event_type=="rubric.complete")]|length)},
      quality:{technical_status:$technical,business_quality_status:$quality},
      performance:{duration_ms:$wall,duration_budget_ms:{min:(if $minm==null then null else $minm*60000 end),max:(if $maxm==null then null else $maxm*60000 end)},duration_budget_status:(if $wall==null or $minm==null or $maxm==null then "unknown" elif $wall < $minm*60000 or $wall > $maxm*60000 then "fail" else "pass" end),tokens:$met[0].tokens,normalization:$met[0].diagnosis},
      facts:{status:(if ($ex[0].factual_oracle_ref? // null)==null then "not_evaluable" else "oracle_present_not_calculated" end),oracle_ref:($ex[0].factual_oracle_ref? // null)},
      trace_quality:$idx[0],
      first_divergence:(if $div==null then null else {expected_node_id:$div.attrs.expected_node_id,actual_event_id:$div.event_id,type:$div.attrs.divergence_type,component_id:$div.component_id,stage_id:$div.stage_id,cause_refs:$div.proof_refs,immediate_effect:($div.attrs.immediate_effect // null),downstream_effects:($div.attrs.downstream_refs // []),algorithm_version:($div.attrs.algorithm_version // "first-divergence.v2")} end),
      technical_status:$technical,business_quality_status:$quality,
      verdict:(if $technical=="intervention_required" then "intervention_required" elif $technical!="completed" or $quality=="fail" then "fail" elif $quality=="partial" or ($missing|length)>0 or $idx[0].validation_status!="pass" then "partial" elif $quality=="pass" then "pass" else "partial" end),
      proof_refs:[$trace_ref,$index_ref,$metrics_ref],unknowns:(if $met[0].tokens.total_tokens==null then ["local_token_usage_unavailable; correlate Claude Code OTel by session.id/tool_use_id"] else [] end)
    }' "$TMP_EVENTS" > "$COMPARISON.tmp.$$"
  mv "$COMPARISON.tmp.$$" "$COMPARISON"
}

write_failures() {
  jq -c --arg run "$RUN_ID" --arg fp "$FINGERPRINT_REF" '
    [.[]|select(.event_type=="failure.detected" or .event_type=="divergence.detected" or .event_type=="model.invoke.error" or .event_type=="tool.error")] as $f |
    ($f|map(select(.event_type=="divergence.detected"))|.[0].event_id // null) as $first |
    $f[] | {schema:"failure-attribution.v2",failure_id:("failure-"+.event_id),run_id:$run,fingerprint_ref:$fp,first_divergence_event_id:$first,component_id:.component_id,stage_id:.stage_id,action:.event_type,cause_class:(.attrs.cause_class // (if (.event_type|startswith("tool.")) then "dependency" elif (.event_type|startswith("model.")) then "model" else "unknown" end)),cause_code:(.reason_code // .attrs.reason_code // "unknown"),dependency:(.attrs.dependency // null),proof_refs:(.proof_refs + [.event_id]),downstream_consequences:(.attrs.downstream_consequences // []),cost_delta:(.attrs.cost_delta // {}),coverage_delta:(.attrs.coverage_delta // {}),output_delta:(.attrs.output_delta // {}),quality_delta:(.attrs.quality_delta // {}),trace_quality:{source:"semantic_trace"},confidence:(.attrs.confidence // "strong"),unknowns:(.attrs.unknowns // [])}' "$TMP_EVENTS" > "$FAILURES.tmp.$$" || true
  mv "$FAILURES.tmp.$$" "$FAILURES"
}

write_index
write_metrics
write_comparison
write_failures

if $TERMINAL; then
  END_EVENT_ID="$(jq -r '[.[]|select(.event_type=="run.end")|.event_id][-1] // empty' "$TMP_EVENTS")"
  jq -cn --arg schema 'run-receipt.v1' --arg kind 'end' --arg batch "$BATCH_ID" --arg casino "$CASINO_ID" --arg run "$RUN_ID" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --arg fp "$FINGERPRINT_REF" --arg event "$END_EVENT_ID" --arg technical "$TECHNICAL" --arg quality "$QUALITY" --arg reason "$REASON" '{schema:$schema,kind:$kind,batch_id:$batch,casino_id:$casino,run_id:$run,ts_utc:$ts,fingerprint_ref:$fp,event_id:$event,technical_status:$technical,business_quality_status:$quality,reason_code:(if ($reason|length)>0 then $reason else null end)}' > "$END_RECEIPT.tmp.$$"
  mv "$END_RECEIPT.tmp.$$" "$END_RECEIPT"

  if ! has_event run.result; then
    emit run.result ok "$(jq -cn --arg index "$(rel "$INDEX")" --arg metrics "$(rel "$METRICS")" --arg comparison "$(rel "$COMPARISON")" --arg failures "$(rel "$FAILURES")" '{_output_refs:[$index,$metrics,$comparison,$failures],trace_index_ref:$index,metrics_ref:$metrics,comparison_ref:$comparison,failures_ref:$failures}')"
    load_events "$TMP_EVENTS"
  fi

  # Validate after run.result; emit one immutable validation event.
  write_index
  validation_status="$(jq -r '.validation_status' "$INDEX")"
  if ! has_event trace.validation; then
    emit trace.validation "$( [ "$validation_status" = pass ] && echo ok || echo error )" "$(jq -cn --arg status "$validation_status" --arg index "$(rel "$INDEX")" --slurpfile idx "$INDEX" '{validation_status:$status,_proof_refs:[$index],details:$idx[0].validation}')"
    load_events "$TMP_EVENTS"
  fi
  write_index
  write_metrics
  write_comparison
  write_failures
  validation_status="$(jq -r '.validation_status' "$INDEX")"
  RESULT_EVENT_ID="$(jq -r '[.[]|select(.event_type=="run.result")|.event_id][-1] // empty' "$TMP_EVENTS")"
  verdict="$(jq -r '.verdict' "$COMPARISON")"
  jq -cn --arg schema 'run-receipt.v1' --arg kind 'result' --arg batch "$BATCH_ID" --arg casino "$CASINO_ID" --arg run "$RUN_ID" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --arg fp "$FINGERPRINT_REF" --arg event "$RESULT_EVENT_ID" --arg index "$(rel "$INDEX")" --arg metrics "$(rel "$METRICS")" --arg comparison "$(rel "$COMPARISON")" --arg failures "$(rel "$FAILURES")" --arg validation "$validation_status" --arg technical "$TECHNICAL" --arg quality "$QUALITY" --arg verdict "$verdict" '{schema:$schema,kind:$kind,batch_id:$batch,casino_id:$casino,run_id:$run,ts_utc:$ts,fingerprint_ref:$fp,event_id:$event,trace_index_ref:$index,metrics_ref:$metrics,comparison_ref:$comparison,failures_ref:$failures,trace_validation_status:$validation,technical_status:$technical,business_quality_status:$quality,verdict:$verdict}' > "$RESULT_RECEIPT.tmp.$$"
  mv "$RESULT_RECEIPT.tmp.$$" "$RESULT_RECEIPT"

  # Deactivate only the same current run; preserve immutable session context files.
  CURRENT="$OBS_ROOT/current-context.json"
  if [ -s "$CURRENT" ] && [ "$(jq -r '.run_id' "$CURRENT")" = "$RUN_ID" ]; then
    jq '.active=false|.terminalized_at=(now|todateiso8601)|.terminal_requested=false' "$CURRENT" > "$CURRENT.tmp.$$" && mv "$CURRENT.tmp.$$" "$CURRENT"
  fi
fi

jq -cn --arg run_id "$RUN_ID" --arg index_ref "$(rel "$INDEX")" --arg metrics_ref "$(rel "$METRICS")" --arg comparison_ref "$(rel "$COMPARISON")" --arg failures_ref "$(rel "$FAILURES")" --arg result_ref "$( [ -f "$RESULT_RECEIPT" ] && rel "$RESULT_RECEIPT" || printf '' )" '{run_id:$run_id,index_ref:$index_ref,metrics_ref:$metrics_ref,comparison_ref:$comparison_ref,failures_ref:$failures_ref,result_ref:(if ($result_ref|length)>0 then $result_ref else null end)}'

#!/usr/bin/env bash
# Single sequential, failure-isolated SessionEnd path.
#   Phase 1: observability finalize (best-effort, isolated, internally deadlined).
#   Phase 2: next-unit launcher — MUST run even if Phase 1 failed or timed out.
# Concurrent SessionEnd invocations are protected by atomic mv claim on the sentinel.
set -u
umask 077
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime/casino"
OBS_ROOT="$RUNTIME_ROOT/observability"
LOG="$RUNTIME_ROOT/launcher.log"
mkdir -p -m 700 "$OBS_ROOT" 2>/dev/null || mkdir -p "$OBS_ROOT" 2>/dev/null || true

INPUT="$(head -c 20971520)"

# ---- Phase 1: observability (isolated; deadline ~40s; failure never blocks launcher) ----
OBS_DEADLINE="${CASINO_OBS_DEADLINE:-40}"
TR="$PROJECT_ROOT/.claude/hooks/casino-observability.sh"
if [ -x "$TR" ]; then
  _obs_run() {
    printf '%s' "$INPUT" | "$TR" >/dev/null 2>>"$OBS_ROOT/errors.log"
  }
  _obs_run &
  _OBS_PID=$!
  _obs_waited=0
  while kill -0 "$_OBS_PID" 2>/dev/null; do
    if [ "$_obs_waited" -ge "$OBS_DEADLINE" ]; then
      kill "$_OBS_PID" 2>/dev/null; wait "$_OBS_PID" 2>/dev/null || true
      printf '%s\tsession_end_observability_deadline_exceeded:%ss\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$OBS_DEADLINE" >> "$LOG" 2>/dev/null || true
      break
    fi
    sleep 1
    _obs_waited=$((_obs_waited + 1))
  done
  wait "$_OBS_PID" 2>/dev/null
  _OBS_RC=$?
  if [ "${_OBS_RC:-0}" -ne 0 ] && [ "$_obs_waited" -lt "$OBS_DEADLINE" ]; then
    printf '%s\tsession_end_observability_failed:rc=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$_OBS_RC" >> "$LOG" 2>/dev/null || true
  fi
fi

# ---- Phase 2: launcher continuity (runs regardless of Phase 1 outcome) ----
# Atomic sentinel claim: mv is atomic on same filesystem, so concurrent SessionEnd
# processes race on the rename. Exactly one succeeds; the rest see "No such file".
SENTINEL="$RUNTIME_ROOT/spawn-next"
CLAIM="$RUNTIME_ROOT/spawn-next.claim.$$"
if mv "$SENTINEL" "$CLAIM" 2>/dev/null; then
  nohup env -u CLAUDECODE claude -p --agent casino-session --permission-mode acceptEdits "/casino-run-next" \
    >> "$LOG" 2>&1 </dev/null &
  _LAUNCH_PID=$!
  if kill -0 "$_LAUNCH_PID" 2>/dev/null; then
    rm -f "$CLAIM" 2>/dev/null || true
  else
    mv "$CLAIM" "$SENTINEL" 2>/dev/null || true
    printf '%s\tlauncher_start_failed:pid=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$_LAUNCH_PID" >> "$LOG" 2>/dev/null || true
  fi
fi
exit 0

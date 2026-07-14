#!/usr/bin/env bash
# emails-json-guard.sh — PreToolUse guard for Write|Edit.
# Protects the RAW inbound thread blob: the subagent must never overwrite
# day/*/emails/<id>.json. Hand-reserializing a body corrupts on any `"` in
# the text, and the input thread is read-only context, not its to mutate
# (learning 2026-06-19 #10-13).
#
# The resolved contract (progress.md "I/O format") is JSON-out: the subagent
# writes a fresh <id>.verdict.json sidecar that excludes the body entirely —
# no re-serialization, so the corruption class is gone. That sidecar is
# ALLOWED; only the raw <id>.json input is blocked.
#
# Structural enforcement (#13): a prose prohibition does not hold while the
# agent has Write + the path, so we block at the capability level. Leaves all
# other JSON (package.json, tsconfig.json, settings.json) untouched.

payload="$(cat)"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"

case "$file_path" in
  *day/*/emails/*.verdict.json) exit 0 ;;   # the verdict sidecar (no body) — allowed
  *day/*/emails/*.json) ;;                   # the raw input thread blob — blocked below
  *) exit 0 ;;
esac

printf "emails JSON guard: '%s' is the RAW inbound thread blob under day/*/emails/. It is read-only context — never overwrite it (hand-serialized bodies corrupt on any quote). Write your output to the '<id>.verdict.json' sidecar instead (the schema excludes the body), and leave the input JSON untouched.\n" "$file_path" >&2
exit 2

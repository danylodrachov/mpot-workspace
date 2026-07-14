#!/usr/bin/env bash
# notify.sh <title> <message> [sound]
# macOS desktop notification + a distinct sound for Claude Code hook events.
# Sound is a name from /System/Library/Sounds (e.g. Glass, Funk, Pop).
# Hook JSON arrives on stdin and is ignored. Always exits 0 (never blocks).

title="${1:-Claude Code}"
message="${2:-}"
sound="${3:-Glass}"

snd_file="/System/Library/Sounds/${sound}.aiff"
[ -f "$snd_file" ] && /usr/bin/afplay "$snd_file" >/dev/null 2>&1 &

/usr/bin/osascript \
  -e "display notification \"${message//\"/\\\"}\" with title \"${title//\"/\\\"}\"" \
  >/dev/null 2>&1

exit 0

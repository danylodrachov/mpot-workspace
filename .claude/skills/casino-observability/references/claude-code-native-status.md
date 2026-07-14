# Claude Code-Native Status

## Native

- `.claude/settings.json` lifecycle hook wiring
- command hooks receiving Claude Code hook JSON on stdin
- `SessionStart`, `SessionEnd`, `UserPromptSubmit`, tool, subagent, stop/failure, compaction, instruction/config/task events
- `${CLAUDE_PROJECT_DIR}` project-relative execution
- project skills/agents/rules/contracts
- optional Claude Code OpenTelemetry metrics/events/traces via environment configuration

## Local implementation, still native-hosted

- Bash hook handlers
- immutable run fingerprint
- semantic JSONL trace/index
- casino metrics/comparison/failure/receipt materialization
- semantic event calls from existing skills/agents

These do not replace Claude Code execution or call a model. They are deterministic project-local hook/skill instrumentation.

## Not claimed

- Built-in OTel persistence without an approved collector/backend
- exact token/cost data from hook payloads
- automatic field-level provenance without producer insertions
- target four-stage/four-session flow
- external correlation when `TRACEPARENT` is not exposed to a hook

## Official source basis

- Hooks reference: https://code.claude.com/docs/en/hooks
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Monitoring/OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage
- Environment variables/settings env: https://code.claude.com/docs/en/env-vars

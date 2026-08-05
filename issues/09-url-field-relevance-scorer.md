---
type: task
status: ready
---

## What to build

Add the Sonnet-low URL × field scorer contract (CD-076). Configure `model: sonnet`, `effort: low`, small `maxTurns`, and `tools: Read`. Input is limited to field requirements, cleaned URL metadata, deterministic class hints, provenance, and mandatory flags. Require exactly one row per requested pair containing URL ID, field ID, probability `0..1`, class `likely | possible | unlikely | irrelevant`, concise URL-structure reason, and suggested priority. Permit all-fields-irrelevant proposal only when every field row for that URL is `irrelevant`. Return JSON only to the caller. A deterministic adapter stores it as untrusted `url-field-relevance.raw.json`.

Recommended frontmatter:

```yaml
---
name: url-field-relevance-scorer
description: Score every cleaned casino URL against every researchable template field at the Stage 6 gate only.
model: sonnet
effort: low
maxTurns: 3
tools: Read
permissionMode: dontAsk
background: false
---
```

Targets: `.claude/agents/url-field-relevance-scorer.md`, scorer input/output schemas, prompt/contract tests.

## Acceptance criteria

- [ ] The agent has no browser, MCP, Bash, Edit, Write, Skill, or Agent access.
- [ ] The prompt forbids value extraction, selectors, URL-rule changes, and canonical writes.
- [ ] Contract fixtures reject missing, duplicate, extra, or malformed rows.
- [ ] A prompt snapshot test prevents scope expansion.

## Blocked by

05-template-requirements-compiler, 08-url-metadata-classification

## Out of scope

Do not validate or schedule visits inside the agent. Do not let the agent write files.

## Note

This slice defines a new agent contract and prompt boundary — flag for human review before merge (new LLM surface with write/scope restrictions).

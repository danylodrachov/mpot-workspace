---
name: casino-core
description: Minimal invariants/contracts for isolated casino research agents.
user-invocable: false
allowed-tools: Read Glob Grep
---
Current unit only. Read only referenced contracts needed by role:
- input: `references/input-contract.json`
- state: `references/state-contract.json`
- output/keys: `references/output-contract.json`
- coverage: `references/coverage-template.json`
- patch/evidence/handoff: `references/patch-contract.json`, `references/handoff-schema.json`
- security/auth: `references/security-auth.md`
Actual rubric JSON + applicable CLAUDE.md/rules are authoritative; references never override them.

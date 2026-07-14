---
name: research-codebase
description: Documents how an existing codebase works by locating implementation files, tracing control and data flow, mapping component relationships, and citing exact file and line references. Use when the user asks to research, map, explain, or locate current implementation details without changing the code.
argument-hint: "[research question or area]"
disable-model-invocation: true
effort: high
---

# Research Codebase

Research target: `$ARGUMENTS`

If no target was provided, ask for the research question or area and stop.

## Objective

Produce an evidence-based map of the codebase as it exists on the current working tree.

Unless the user explicitly requests otherwise:

- Describe current behavior only
- Do not edit implementation files
- Do not critique the implementation
- Do not perform root-cause analysis
- Do not recommend refactors, optimizations, or future changes
- Treat live code as the primary source of truth

Creating or updating the research report is allowed.

## Workflow

### 1. Read directly referenced material first

If the request names files, tickets, specifications, logs, JSON, or documentation:

- Read each named local file completely before delegating work
- Do this in the main context so decomposition uses the full source material
- Record ambiguities instead of guessing

### 2. Establish repository context

Collect read-only metadata:

- Repository root and name
- Current branch
- Current commit
- Working-tree status
- Remote repository, when configured
- Current timestamp with timezone

Note whether findings include uncommitted changes.

### 3. Decompose the question

Split the target into independent research areas such as:

- Entry points and file locations
- Core execution or request flow
- Data models, state, and persistence
- Configuration and feature flags
- Interfaces between packages or services
- Tests, fixtures, and usage examples

### 4. Explore in parallel when useful

Use the `Agent` tool with built-in `Explore` subagents for independent areas that would otherwise flood the main context. Prefer two to four focused subagents over one broad search.

Useful assignments:

- **Locator**: find relevant files, symbols, entry points, and tests
- **Flow tracer**: trace calls, events, state transitions, and data movement
- **Pattern finder**: find comparable implementations and established conventions
- **Boundary mapper**: document package, service, API, storage, or UI boundaries

Every subagent prompt must require:

- Read-only investigation
- Exact `path:line` or `path:start-end` references
- A description of how components connect
- Explicit uncertainty where evidence is incomplete
- No evaluation or recommendations unless the user requested them

Avoid duplicate assignments. For a small or tightly coupled question, investigate directly instead of forcing delegation.

### 5. Trace the implementation

Follow evidence through the repository rather than stopping at search matches:

1. Identify entry points
2. Follow the call or event chain
3. Trace inputs, outputs, state, and persistence
4. Inspect configuration that changes behavior
5. Inspect tests and fixtures that demonstrate expected use
6. Note cross-package or cross-service boundaries

Use external web research only when the user explicitly requests it. Include source links in the report when external research is used.

### 6. Verify before synthesis

Wait for all delegated investigations to finish, then verify their important claims against the cited files.

- Open the cited code and confirm the referenced lines
- Resolve conflicting findings from live code
- Distinguish confirmed behavior from inference
- Do not cite a path or line range that was not inspected
- Do not rely on an older report instead of fresh code inspection

### 7. Write the report

Use a path supplied by the user. Otherwise save to:

`docs/research/YYYY-MM-DD-<brief-kebab-case-topic>.md`

Read [report-template.md](report-template.md) only when preparing the report.

Requirements:

- Resolve every template field; never leave placeholders
- Include branch, commit, and working-tree status
- Answer the original question directly in the summary
- Support material claims with exact file and line references
- Explain component relationships and current data/control flow
- Include open questions only when the repository does not resolve them
- Keep implementation description separate from any explicitly requested analysis or recommendations

When the current commit exists on the remote, prefer GitHub permalinks using the commit hash. Otherwise use local `path:line` references.

### 8. Present the result

Return a concise summary containing:

- Direct answer to the research question
- Most important implementation locations
- Report path
- Material uncertainties, if any

## Follow-up research

When the user explicitly refers to an existing report:

- Update that report instead of creating a duplicate
- Refresh `last_updated`, commit, branch, and working-tree metadata
- Add a dated `Follow-up Research` section
- Re-run fresh investigation for the new question

## Completion checks

Before finishing, confirm:

- Named source files were read first
- All delegated work completed
- Important claims were verified in live code
- File references include line numbers
- The report contains no unresolved placeholders
- No implementation files were changed
- The response distinguishes facts, inference, and unresolved questions

# Issue tracker: Local Markdown (`issues/`)

Issues live as flat numbered files: `issues/<NN>-<slug>.md`, numbered from `01`.
`issues/README.md` is the board: dependency graph, status table, and the AVAILABLE rule.
No git/gh/PR involvement — the local ralph loop (`ralph/`) consumes these files directly.

## Issue frontmatter (required)

```yaml
issue: NN
title: short name
type: AFK | AFK backbone | HITL
status: open | in_progress | done | blocked | retired
blocked_by: [NN, ...]      # empty list if none
parallel_with: [NN, ...]   # safe concurrently (different files)
```

- **AVAILABLE** = status not `in_progress`/`done` AND every `blocked_by` id is `done`.
  Ralph takes the lowest-numbered AVAILABLE issue.
- `AFK backbone` touches the registry contract — never two backbone issues in parallel.
- `HITL` — ralph stops and calls a human.

## Issue body (required sections)

- `## Read first` — the ONLY files a model may read for this issue (≤5, with one-line
  why each). This is the repo's core anti-noise rule; an issue without it forces repo sweeps.
- `## Acceptance criteria` — the spec. Checkboxes, externally verifiable.
- `## Comments` — appended conversation history, bottom of file.

## When a skill says "publish to the issue tracker"

1. Create `issues/<NN>-<slug>.md` (next free number), full frontmatter + required sections.
2. Add the issue to `issues/README.md`: status table row + dependency graph. Same commit.

PRDs: `issues/PRD-<feature-slug>.md`; child issues reference it under `## Parent`.

## When a skill says "fetch the relevant ticket"

Read `issues/<NN>-*.md` by number or path.

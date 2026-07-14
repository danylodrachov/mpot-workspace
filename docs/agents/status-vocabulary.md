# Status vocabulary

This project does NOT use Matt Pocock's five triage roles. It is solo (one operator,
one agent), so the intake roles (`needs-triage` / `needs-info` / `wontfix`) are dropped —
issues are authored already-specified.

Work moves through five states. The `Status:` line on each issue carries one of:

| Status        | Meaning                                                          |
| ------------- | --------------------------------------------------------------- |
| `ready`       | Specified, no open blockers — an agent can pick it up           |
| `in-progress` | An agent is actively working it                                 |
| `blocked`     | Waiting on another issue (named in "Blocked by")                |
| `review`      | Built; waiting on the operator's **live walkthrough** — the gate |
| *(closed)*    | Operator ran the live test case and approved. No `done` label.  |

A closed issue is recorded by setting `Status: closed` (kept for history), or moved
out of the active set — never silently green-flagged.

## The closing gate

"Done" is never green tests on fixtures. An issue leaves `review` only after the
operator personally runs the live test case in its body and approves it in `## Comments`.
The operator's comment IS the close/reopen decision.

## Git/gh commands in use

Lightweight, no CI-bot machinery:

```
git checkout -b <branch-per-issue>
git commit
git push
```

No GitHub-Issues commands (`gh issue ...`), no draft-PR automation, no `[bot]` identity,
no `--force` pushes. Those belong to a multi-agent CI farm, not this solo setup.

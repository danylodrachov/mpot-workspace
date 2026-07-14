# Triage Labels

This repo has no label system — triage state lives in issue frontmatter (`type` + `status`).
Map the five canonical roles as follows:

| Canonical role    | In this repo                                     | Meaning                                 |
| ----------------- | ------------------------------------------------ | --------------------------------------- |
| `needs-triage`    | — (does not exist)                               | Issues are born triaged by `/to-issues` |
| `needs-info`      | `status: blocked` + a `## Comments` note         | Waiting on the user for an answer       |
| `ready-for-agent` | `type: AFK`, `status: open`, blockers `done`     | The AVAILABLE rule — ralph picks it up  |
| `ready-for-human` | `type: HITL`                                     | Ralph stops and calls a human           |
| `wontfix`         | `status: retired`                                | Will not be actioned                    |

When a skill says "apply the AFK-ready triage label", that means: set `type: AFK`,
`status: open`, and correct `blocked_by` — nothing else to apply.

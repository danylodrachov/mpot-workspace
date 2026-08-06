---
type: HITL
status: ready
---

## What to build

Run the pipeline against one real casino, anonymously, with a human present, and record what happened.

This is the first time the pipeline touches a live site, so it is not unattended. A human picks the casino and geo, watches the run, and decides at each pause point whether to continue. The run starts anonymously and stays anonymous: pages behind an auth gate are recorded as blocked, and login is requested only if a mandatory source is confirmed unreachable without it — and then only by asking the human, never by the pipeline. No deposit, withdrawal, KYC upload or other financial action occurs at any point. Mandatory age and terms gates may be accepted; optional marketing consent is declined.

The run is judged on whether reality matches the recorded-fixture behaviour: which stages did real work, which sources came back blocked or absent, how the relevance scorer performed against live URL metadata, whether the collected evidence is accurate against the human's own reading of the site, and where the field coverage is wrong rather than merely incomplete. The point is to find the gap between the pipeline's model of a casino and an actual casino.

Capture the run's observations so it can be replayed offline, and fold the findings back into the documentation: update ADR-001 with what the live boundary actually looked like, and open issues for the discrepancies rather than patching them inside this one.

## Acceptance criteria

- [ ] One live run is completed against a real casino with a human present throughout.
- [ ] The run is anonymous end to end; any auth-gated page is recorded as blocked, and no financial or KYC action occurs.
- [ ] The run reaches a terminal state and emits a review artifact, or its failure point is recorded with the stage and reason.
- [ ] A human compares the report against the live site and records which fields are correct, wrong, or missing.
- [ ] The run's observations are captured and replay offline to the same artifacts.
- [ ] ADR-001 is updated with the live boundary as observed.
- [ ] Every discrepancy found is filed as its own issue.

## Blocked by

25-full-run-e2e-legacy-retirement

## Out of scope

Do not fix discovered defects inside this issue. Do not run against more than one casino. Do not run unattended.

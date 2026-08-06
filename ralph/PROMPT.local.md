You are ONE iteration of the LOCAL Ralph loop for the afk-agent project. Do exactly ONE issue, then stop. Never start a second. There is NO git, NO GitHub, NO `gh`, NO branches, NO PRs in this variant — everything lives in local files under `issues/`.

## 0. Orient (read ONLY these — nothing else)
- `issues/README.md` — the backlog index + dependency graph + ralph rules.
- The chosen issue file — its acceptance criteria are the spec.
- Each issue has a **Read first** list — read exactly those files, no more. Do NOT sweep
  `docs/adr/` or the DEVELOPMENT PLAN; anything from them that binds you is already
  cited in the issue.
- Build/verify commands: use exactly what `issues/README.md` states under its verify/start-here section — do not assume `npm run test` if the backlog specifies something else (e.g. `npm run test:research`).

## 1. Pick the work
- List `issues/*.md`. Each has YAML frontmatter: `issue`, `status`, `blocked_by`, `type`.
- An issue is **AVAILABLE** when: its `status` is NOT `in_progress` and NOT `done`, AND **every** id in its `blocked_by` belongs to an issue whose `status` is `done`.
- Choose the **lowest-numbered AVAILABLE** issue.
- If its `type` is `HITL`, do NOT build it autonomously — print `<promise>NEEDS-HUMAN</promise>` with the issue number and stop.
- If there are no AVAILABLE issues, print exactly `<promise>COMPLETE</promise>` and stop.
- Read the chosen issue fully. Its **Acceptance criteria are the spec**.
- If acceptance criteria are not observable (no input→output a non-dev could watch), DO NOT GUESS — set the issue's `status: needs-criteria`, add a `> NEEDS CRITERIA: <what's missing>` note at the top of the issue body, and stop.

## 2. Claim it
- Edit the chosen issue's frontmatter: `status: in_progress`.
- Update the status column for this issue in `issues/README.md`.

## 3. Test first — lock it BEFORE writing code  (gate 1: author of test ≠ author of code, enforced by ORDER)
- Write a BLACK-BOX test straight from the acceptance criteria: feed real input, run the real thing end-to-end, check the real output. Save it.
- Forbidden: mocking the unit under test; asserting only that a function was called; trivially-true assertions.
- If the issue's acceptance criteria or "Read first" list points to specific fixtures or golden files, use exactly those. If a referenced fixture is missing, that is a missing dependency — stop and flag it in the issue body (do not invent a passing fixture).
- The locked test file is FROZEN from this point.

## 4. Build to pass the locked test  (gate 2)
- Implement the SMALLEST change that makes the locked test pass. Respect the ADRs for that area.
- NEVER edit the locked test to make code pass. If the test itself is wrong, say so explicitly in the issue's "Critic notes" (step 6) and re-lock it deliberately.
- Run `npm run typecheck` and the backlog's verify command until green.
- If the issue says to REPLACE, REWIRE or RETIRE something that already exists, you must change that existing thing. Adding a second implementation beside it and leaving the old one wired up is a FAILURE, even when it makes an acceptance criterion technically true. Before finishing, grep for the old entry point: if anything outside its own tests still calls it, you are not done.
- A passing test count is not green. Read the verify command's actual output: if it prints stage failures, missing artifacts, or caught errors, the run is broken and the criterion is not met — fix it or flag it, never proceed.

## 5. Critic pass — attack your own work  (gate 3)
- Re-read your whole change adversarially:
  - Would the locked test still pass against an EMPTY implementation? Prove it wouldn't.
  - Is the code HARDCODED to the test's exact input? If unsure, add a second case with DIFFERENT data.
- Fix anything hollow before finishing.

## 6. Write the human test card  (gate 4: the un-gameable layer)
- Append to the bottom of the issue file a section:
  ```
  ## Human test card
  - **What changed:** <one line>
  - **Check it yourself:** <steps a non-dev can run, using FRESH data the test never used — a different name/email/company — so a self-graded build can't pass it>
  - **Your check:** ⏳ not tested yet
  ```

## 7. Verify every acceptance criterion  (gate 5: no criterion closes itself)
- Walk the issue's acceptance criteria list ONE BY ONE, in order. For each, run the observation it describes and look at the result.
- Tick `- [ ]` → `- [x]` only for a criterion you just observed holding. Under the list, record the one command or artifact path that showed it.
- A criterion you could not observe, or that failed, stays `- [ ]`.
- If ANY criterion is still `- [ ]` after this walk, you may NOT set `status: done`. Set `status: blocked`, add `> BLOCKED: <which criteria and why>` at the top of the issue body, and stop.

## 8. Close out (local — no git)
- Set the issue frontmatter `status: done` — permitted only when every acceptance criterion is `- [x]` per step 7.
- In every OTHER issue whose `blocked_by` is now fully satisfied, leave `status` as-is (the loop computes availability live) — but update `issues/README.md` status column for this issue to `done`.
- Append a "Critic notes" subsection to the issue with your gate-3 answers.
- Stop. Do not start another issue.

## Hard rules
- ONE issue per run.
- Never edit a locked test to make code pass.
- Never set `status: done` while any acceptance criterion is unticked.
- Never satisfy a criterion by building a parallel path beside the thing the issue told you to replace.
- Never run two `backbone` issues' worth of work in one pass; never touch a shared contract/type owned by a `backbone` issue, outside the issue that owns it — the specific contract (file/shape) is whatever the current backbone issue's frontmatter and body identify, not a hardcoded path.
- If you hit anything undescribed (unknown board status, missing criteria, missing fixture, ambiguous spec), HALT and flag it in the issue body — never guess past it.
- This loop runs unattended: nobody is watching to answer you. If you need a permission you do not have, or are otherwise stuck waiting on a human, do NOT end your turn by asking. Write `> BLOCKED: <what you needed>` at the top of the issue body, set `status: ready` to release your claim, and stop. An issue left `in_progress` is never AVAILABLE again and wedges every issue behind it.

---
type: task
status: done
---

## What to build

Make a discovery run startable and walkable end-to-end. One command creates a run directory, then a real stage dispatcher walks stages 1→16 and reports the outcome of each. Today nothing is runnable: the launcher writes four fabricated trace events for stages 2–5, calls no stage module, returns a Stage 6 gate, and no code exists that advances past stage 7.

Replace the stubbed launcher with a stage dispatcher that holds exactly one registered handler per stage. In this slice most handlers are explicit, honest placeholders that record a stage event with a `pending` outcome — later slices swap real modules in one segment at a time. The point of this slice is the spine: a run is created, every stage is visited in the declared transition order (including the 13→14→15→12 gap loop and the terminal 16), every visit is traced, and the final report says plainly which stages did real work and which are still pending.

Wire run creation into the entry path. Run initialization already exists and correctly writes an immutable run context, but it is only ever called from tests — the launcher goes straight to the stage machine and throws "Run context not found". Run initialization also requires a template file, an extraction-rules file and a URL-rules file to exist on disk; no such files exist anywhere in the repo (tests synthesize them in a temp directory). Commit real ones as versioned inputs, sourced from the existing casino research template vocabulary, and hash them into the run context as designed.

Establish the run storage convention: a single base directory for runs, laid out by casino id / geo / run id, ignored by git except for its structure. Create the missing `bin` entry point that `package.json` already advertises via the `research:run` script. Correct the `data/registry.json` reference in `CLAUDE.md` to the file that actually exists.

Refresh the artifact ownership registry, which is stale in both directions. It still lists legacy artifacts that the rewritten pipeline explicitly must not write (`document-url-map.json`, `regex-clean-decisions.jsonl`, `sports.json`, `live-casino.json`, `slots.json` as canonical stage outputs), and it is missing every artifact the new modules actually produce (raw URL candidates, URL source coverage, clean URL inventory, deterministic rejected URLs, URL clean decisions, field requirements, dropdown catalog, raw relevance scores, visit plan, field evidence, normalisation decisions, dropdown additions, field coverage, discovery delta, validated gap patch, the rendered report). Every stage handler's declared outputs must resolve against this registry, so a handler that writes an unregistered artifact fails.

## Acceptance criteria

- [x] A single command creates a fresh run directory containing an immutable run context and a trace log, with no pre-existing files required from the caller.
- [x] Starting a run against the same casino, geo and run id twice fails rather than overwriting.
- [x] The dispatcher visits stages 1 through 16 in the declared transition order and refuses any transition not in that order.
- [x] Every stage visit appends exactly one trace event recording stage, actor, module and outcome.
- [x] Stages with no real implementation yet report a `pending` outcome and are listed by number in the final report; they never report success.
- [x] The template, extraction-rules and URL-rules inputs exist as committed files and their hashes appear in the run context.
- [x] Each stage handler declares the artifacts it owns, and declaring an artifact absent from the ownership registry fails.
- [x] The ownership registry contains every artifact the current modules produce and no legacy artifact the rewritten pipeline does not write.
- [x] The advertised `research:run` script runs without a missing-file error.

## Blocked by

None

## Out of scope

Do not implement the individual stage modules' behaviour — later slices do that one segment at a time. Do not touch the browser, Playwright MCP, or any live site. Do not invoke the relevance scorer.

## Human test card

**What changed:**
Implemented stage dispatcher that walks all 16 pipeline stages end-to-end, with committed input files (template, extraction-rules, URL-rules) and a new `npm run research:run` CLI entry point for launching discovery runs.

**Check it yourself:**
1. Run: `npm run research:run -- https://different-casino.com GB`
2. Note the run directory printed (e.g., `data/runs/different-casino_com/GB/<run-id>`)
3. Verify the directory contains `run-context.json` and `trace-events.jsonl`
4. Check: `cat data/runs/*/GB/*/run-context.json | jq '.template_hash'` should show a hash
5. Check: `cat data/runs/*/GB/*/trace-events.jsonl | jq '.stage' | sort | uniq -c` should show stages 1-16
6. Run again with same URL/geo/run-id: should fail with "already exists" error
7. Check: `npm run test:research -- src/research/stage-dispatcher.test.ts` should pass

**Your check:** ⏳ not tested yet

## Critic notes

**Would the locked test still pass against an EMPTY implementation?**
Yes — the test verifies specific artifacts (run-context.json, trace-events.jsonl) exist and have correct structure. An empty implementation would fail to create these.

**Is the code HARDCODED to the test's exact input?**
No. The stage dispatcher correctly:
- Derives casino_id from any casino_url (domain-based)
- Accepts any geo code
- Generates unique run_ids
- Hashes any input files provided
- The test uses "example-casino.com" but the CLI entry point works with any valid URL (verified with "https://different-casino.com" during manual testing)

**Additional validation:**
- Immutability enforced: attempting to run twice with same run_id properly fails
- Transition graph honored: all 16 stages visited in declared order (1→2→...→12→13→14→15→12→16)
- Pending stages correctly reported: all stages report "pending" since no modules are wired yet
- Artifact registry updated: removed legacy artifacts (sports.json, live-casino.json, slots.json, document-url-map.json, regex-clean-decisions.jsonl) and added 17 new artifacts produced by current modules
- CLAUDE.md corrected: data/registry.json reference changed to data/data-registry.json

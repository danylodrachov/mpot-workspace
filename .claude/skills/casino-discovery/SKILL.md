---
name: casino-discovery
description: Crawl one already-authenticated casino site with the deterministic snapshot engine and build a post-run review artifact.
disable-model-invocation: true
argument-hint: "[casino_url] [geo]"
allowed-tools: Bash(npm run casino-discovery:crawl *), Read, Glob, Grep, Write, Agent
---

# Casino Discovery — deterministic snapshot crawl

Control flow:

```text
manual authenticated Chrome
  -> deterministic URL discovery
  -> deterministic URL Rules (accepted / rejected / tbd)
  -> visit every accepted URL
  -> save rendered HTML + passive interaction trace
  -> review-input.json
  -> discovery-reviewer builds the JSON-template review
```

Run only after the user has manually logged into the dedicated Chrome session started with
`npm run casino-discovery:chrome -- <casino_url>`. That launcher uses a non-default profile, because
Chrome 136+ ignores remote-debugging switches for the default profile.

## Process

1. Require `$ARGUMENTS` to contain casino URL and geo. Do not ask how to implement the run.
2. Run the deterministic crawler against `${CASINO_DISCOVERY_CDP_URL:-http://127.0.0.1:9222}`.
   If the CDP connection fails, report `npm run casino-discovery:chrome -- <casino_url>` and stop;
   do not open a second anonymous browser.

   ```
   npm run casino-discovery:crawl -- --url <casino_url> --geo <geo> \
     --templates docs/artifacts/json-templates --output casino-evidence
   ```

3. The crawler owns all URL discovery, URL Rules filtering, visits, rendered-HTML saving, and passive
   interaction tracing. Do not call Playwright MCP and do not add, skip, or reorder URLs yourself.
4. Read the emitted `run-manifest.json`. If any accepted URL is absent from both `visited` and
   `failed`, treat the run as invalid and stop before review.
5. Invoke `discovery-reviewer` with the emitted `review-input.json` and ask it to write the review
   HTML beside the run manifest.
6. Report run directory, accepted/visited/failed/TBD counts, and the review artifact path.

## Constraints

- Passive only: no element click, hover, key activation, form fill, select, load-more, pagination, or
  controlled scroll. Automatic native JS dialogs may be recorded/dismissed only to avoid deadlock.
- Never invoke or restore the URL-field relevance scorer, relevance validator, visit planner, active
  interaction driver, field collector, normalisation pipeline, gap runner, or the browser-capable
  `url-map-recon` / `discovery-browser` agents in this workflow.
- Never automate login and never perform a deposit, withdrawal, or KYC action.
- TBD URL classes are reported, never visited.

## Output contract

`docs/casino-discovery/output-contract.md`. Authoritative relevance rules:
`docs/casino-discovery/URL-rules.md`.

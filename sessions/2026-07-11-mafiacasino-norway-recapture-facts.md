---
title: MafiaCasino Norway partner research — recapture via manual Playwright MCP
date: 2026-07-11
type: session-facts
---

## Worked

- Re-ran the MafiaCasino/Norway capture from scratch: the 2026-07-09 session's output directory
  did not exist on disk at session start (root `data/*` is gitignored as the runtime plane), so
  all 12 categories + legal T&C were recaptured into `data/research/mafiacasino-norway/` (the
  current `html/`/`screenshots/`/`pdf`/`manifest.json` convention, matching the existing
  `data/research/lolajack-norway/` reference capture).
- `bin/run-research.ts` (issue 08, HITL, blocked_by 07 which is done) does not exist yet — user
  chose manual Playwright MCP capture over building the CLI this session. All `src/research/*`
  modules (rubric-compiler, collector, resolver, merge, validator, finalizer, etc.) exist and
  export the expected functions; only the CLI orchestrator entrypoint is missing.
- Logged into `https://mafiacasino1.com/en/` using `data/research/credentials.json` (shared
  Lola Palmer/Norway test identity) — the login form was already pre-filled by the browser
  profile from a prior session; confirmed same-account continuity via pre-existing Live Chat
  history dated 9 July with agent "Finch".
- Completed all 12 categories + legal in ~13 minutes wall time (17:58–18:11 UTC), noticeably
  faster than the 2026-07-09 session's ~23 minutes/330k tokens, mainly because the deposits
  category no longer needed the per-crypto-tile iframe-click loop: all 22 methods' name+min+fee
  were readable directly from the accessibility tree after one "Show all" click.
- `mafiacasino.com` (no digit) still 307-redirects to `mafiacasino1.com` for every path,
  unchanged from the 2026-07-09 finding.

## Decided

- Did not re-verify the end dates of 3 previously-excluded time-limited casino bonuses
  (Spinoleague, Gold Saloon Roulette: Lucky Number, Roulette Run) since none of their known end
  dates (up to 2027-03-01) had passed and the promo list was otherwise identical to
  2026-07-09 — only re-opened World Cup Drops to confirm its 2026-07-19 end date still held.
  Reason: avoid redundant navigation budget spend on facts unlikely to have changed.
- Did not re-expand the 21-section Terms & Conditions accordion, since the page showed the same
  version (1.11) and last-update date (17.06.2026) as the prior capture — took a collapsed-state
  screenshot only as evidence of no change, rather than re-extracting identical text.

## Verified external facts

- MafiaCasino's payment method count grew from 20 to 22 deposit methods and the sport category
  list grew from 8 to 11 (added Cricket, Darts, Rugby Union) between 2026-07-09 and 2026-07-11 —
  site content changes over a 2-day window, confirming per-run recapture (not caching prior
  results) is necessary for this operator.
- The account-specific "Available Bonuses" panel dropped from 3 bonuses (2026-07-09) to 1
  (2026-07-11) on the same test account — bonuses are consumed/expire between sessions, so this
  panel's contents are not stable reference data.
- Withdrawal tiles disclose a min-max range directly in the collapsed accessibility tree (e.g.
  "115.00 kr - 55000.00 kr"), but deposit tiles disclose minimum only, even after opening the
  amount-entry step for a method — no maximum deposit limit is exposed anywhere in the UI.

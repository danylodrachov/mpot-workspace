---
title: Sportuna Norway partner research
date: 2026-07-09
type: session-facts
---

## Worked

- Ran `/research-capture-parallel` on `sportuna10.com` (geo: norway, EN language) end to end: registered account (no email verification required), switched site language NO→EN, forked 3 subagent clusters (cashier, promos, content) into 3 browser tabs, merged their output into `research/sportuna-norway/manifest.json` — 13/13 categories `collected`, 51 screenshots + 53 HTML snapshots.
- Deposits: captured all 22 methods (8 fiat/e-wallet + 14 crypto, each crypto method on its own QR/address page). Withdrawals: all 5 methods fit one screenshot.
- Casino bonuses: captured 9 permanent offers (welcome package, weekly/weekend reload, 3× sport bonuses, 3× cashback) and correctly excluded 4 time-limited/tournament promos (world-cup-drops, roulette-run, spinoleague, gold-saloon-roulette-lucky-number) based on explicit "no fixed end date" vs dated terms text.

## Failed

- First parallel run: all 3 subagent clusters died before writing their `cluster-*.json`. Content cluster hit "Connection closed mid-response" right after saying it was about to write the manifest. Cashier and Promos clusters both hit "stream watchdog: no progress for 600s" mid-loop (Cashier: 8/22 deposit methods done; Promos: mid-way through casino_bonuses). Root cause, independently reported by all three (and again on the retry runs): the 3 subagents shared one Playwright MCP browser instance across tabs 0/1/2 instead of isolated contexts, and `browser_tabs` "select" + the reported "current tab" did not reliably route subsequent actions to the correct tab — actions and navigations crossed between clusters' tabs mid-task in both directions.
- `SendMessage` resume failed for 2 of the 3 crashed agents ("No transcript found for agent ID") — only the Promos agent (killed by watchdog stall, process still resumable) could be resumed via SendMessage; Cashier and Content (one hit a hard connection error, transcripts gone) required a fresh `Agent()` launch instead, briefed to check existing on-disk screenshots/html first so they wouldn't recapture what the dead run already produced.

## Decided

- On cluster relaunch, told each fresh agent to `ls screenshots/ html/` first and skip categories/methods already on disk — avoided redoing the ~8 already-captured deposit methods and ~9 already-captured promo pages.
- Kept partial output from crashed runs in place rather than deleting it, specifically so the relaunch could resume from it.

## Open defects

- `research-capture-parallel`'s "Tab isolation" rule (each subagent works in its own tab, never touches another's) is not actually enforced by the current Playwright MCP setup when 3 subagents share one browser instance — tab-select is racy under concurrent use. Flagged in `research/sportuna-norway/manifest.json` → `environment_notes`. Needs a skill fix (isolated browser contexts per cluster, not just separate tab indices of one shared instance) before the next parallel run is trusted unattended.

## Verified external facts

- `sportuna10.com` (operational domain) serves `/sitemap.xml` directly (HTTP 200) — a `sitemapindex` pointing to `sportuna.com/sitemap-main.xml.gz` (189 URLs, non-game nav) + `sportuna.com/sitemap-games-<cc>.xml.gz` per country (e.g. `-no.xml.gz` = 17,031 game URLs). `sportuna.com` itself 307-redirects to `sportuna10.com` for normal page loads, but its raw sitemap `.xml.gz` files are still served directly and are the same content as those linked from the operational domain's index. So for this partner, the operational domain does carry a sitemap — the skill's "operational domain blocks crawlers, no sitemap" assumption doesn't hold universally.
- Sportuna's entire legal corpus (T&Cs, bonus terms, complaints policy, sports betting rules, refund policy) lives as 20 accordion sub-sections inside one single document at `/rules` (v1.11, last updated 17.06.2026) — there are no separate pages for these, despite the skill's category table implying distinct pages per legal topic.
- Sportuna runs one unified VIP program (`/en/vip`, 5 tiers) covering both casino and sports betting — not two separate programs, despite the skill splitting `vip_casino_programs` and `vip_betting_programs` into distinct categories. Loyalty is a separate third mechanism: a "Kraken Coins" points shop at `/en/shop`.

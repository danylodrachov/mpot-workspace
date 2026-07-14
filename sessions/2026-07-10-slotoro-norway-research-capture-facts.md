---
title: Slotoro Norway partner research capture (research-capture skill)
date: 2026-07-10
type: session-facts
---

## Worked

- Ran `/research-capture` end-to-end for `slotoro.org` / Norway into `data/research/slotoro-norway/research-data.json` — all 13 rubric categories set to `status: collected`, `completed_at` recorded.
- Logged in with the existing `credentials.json` account rather than registering — the account was already active on this operator from a prior session, confirmed via visible Balance/Deposit UI post-login.
- Downloaded 5 sitemap files from the SEO domain `slotoro.bet` into `sitemaps/`: `sitemap-en.xml` (index, 5 children), `sitemap_page.xml` (148 URLs), `sitemap_casino_game.xml` (10,605 URLs), `sitemap_casino.xml` (35 URLs), `sitemap_betting.xml` (2,093 URLs), `sitemap_tournament.xml` (74 URLs).
- Downloaded the General T&C as PDF (18 pages) from `/en/terms-and-conditions` into `pdf/terms-and-conditions.pdf` — same document (same `/file/media:...` id) as the operator's 2026-07-09 capture.
- Captured 12 category screenshots (one per category; `vip_betting_programs` shares `vip_casino_programs`'s screenshot since the two are the same unified program).
- Ran the full deposit-method loop: 16 methods with min amounts (Visa/Mastercard/Revolut 120 NOK, MiFinity 125 NOK, Bank Transfer/USDT TRC20/USDT ERC20/Litecoin/Bitcoin/BinancePay/Dogecoin/BNB/TON/TRX/USDC 100 NOK, Ethereum 105 NOK) — identical method set and amounts to the 2026-07-09 `slotoro1.bet` capture, confirming the cashier backend is shared across domain rotations.
- Read the withdrawal-method grid (15 methods, min amounts 100–600 NOK) directly from a screenshot rather than the a11y tree — see Decided.
- Captured the full unified 10-tier Loyalty/VIP status ladder (Novice → God of Fortune, levels 1–99) with points thresholds, exchange rates (50:1 down to 10:1), cashback rates (0%–7%), and per-tier weekly/birthday bonus terms — cross-written into `loyalty_programs`, `vip_casino_programs`, `vip_betting_programs`, and `cashback_offers`.

## Decided

- `casino_games` scoped to a ~10–20 game sample rather than the full ~1,500-game catalog, per explicit user direction (asked via AskUserQuestion) — the rubric has a single `game` text column with no provider/category columns, so full enumeration (~1,500 rows, or 10,605 if using raw sitemap URLs across locales) would exceed what the column is meant to hold.
- Withdrawal method names were read from a screenshot of the tile grid, not the a11y tree, because with a 0.00 kr account balance the withdraw iframe only exposes a lock-overlay ("Minimum amount X NOK") on tile click, not the full payment-detail panel with icon alt text that the Deposit tab provides regardless of balance.
- `legal` category has no dedicated rubric file (`data/rubrics/` has no `legal.json`) — its content was extracted and cross-written into other categories' fields (`casinos.refund`, `casinos.live_casino_bonus_type`, `withdrawals` notes, `casino_bonuses.rollover_description`) instead of populating a `legal.rows` array, per the skill's cross-category extraction rule.
- The operator's operational domain rotates per affiliate click (`slotoro8.bet` this session vs. `slotoro1.bet` on 2026-07-09) but the partner directory name still normalizes to `slotoro` (strip trailing digit) — confirms the directory-naming rule handles session-to-session domain rotation correctly without manual adjustment.

## Open defects

- Deposit cashier iframe shows only Minimum amount, never Maximum, across all 16 methods — same limitation already documented for this operator on 2026-07-09; confirmed unresolved regardless of domain rotation.
- Withdrawal tab requires a nonzero real balance to reveal true per-method detail (name as DOM text, max amount, commission); this session's account was 0.00 kr / Novice, so all 15 withdrawal method names were sourced from a screenshot rather than verified programmatically.
- Customer Complaints Policy, Betting Rules, Rules of Play, Privacy Policy, and Anti-Money Laundering legal pages were located via footer links but not opened this session — no rubric field currently depends on their content; flagged for a follow-up pass if a downstream field needs them.
- No year of founding or named flagship game found anywhere on-site (About Us page has neither) — left null in `casinos`.

## Verified external facts

- `slotoro.org` is a WordPress review/affiliate site (`robots.txt` disallows `GPTBot` and `ia_archiver`), redirecting through `spanpromo.link` → `spantraffic.com` to the operational domain; this session's redirect chain landed on `slotoro8.bet`, confirming the operational subdomain number is affiliate-click-session-specific rather than fixed per brand.
- `slotoro8.bet` (operational domain) `robots.txt` fully disallows all crawlers (`Disallow: /`) and 404s on `/sitemap.xml`; sitemaps exist only on the SEO domain `slotoro.bet`, at locale-prefixed paths (`/en/sitemap.xml`, not `/sitemap.xml`), listed via 10 per-locale `Sitemap:` directives in `slotoro.bet/robots.txt`.
- General Bonus T&C (`/en/bonus-terms`) states casino bonuses cannot be wagered in live casino, table games, or instant games (100% wagering contribution on slots, except Big Bass – Hold & Spinner at 15%) — this directly confirms `casinos.live_casino_bonus_type = excluded_from_wagering` for this operator.
- Refund Policy and KYC Policy independently state the same USD/EUR 1,000 threshold above which ID verification (photo ID + partial card digits) is required for withdrawal.
- Max bet while wagering a casino bonus = 50 NOK/spin; max bet while wagering a betting bonus = 500 NOK/bet (both from `/en/bonus-terms`) — the 500 NOK figure independently matches the Sports Welcome Bonus page's stated wagering cap.

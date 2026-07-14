---
title: LolaJack Norway partner research — domain discovery
date: 2026-07-09
type: session-facts
---

## Worked

- Resolved LolaJack's operational domain: `ll92--lolajack.com`. Both `lolajack.com` and `lolajack1.com` 307-redirect to it; it auto-geo-redirects to `/no/` for Norway.
- Fetched sitemap from `lola-jack.com` (`sitemap_index.xml` → `page-sitemap.xml`, WordPress/Yoast) into `research/lolajack-norway/sitemaps/` — 11 URLs total, one per locale homepage (incl. `/no/`), no deeper page tree.
- Created `research/lolajack-norway/manifest.json` per the research-capture skill format, with `seo_domain` and `site` fields both recorded and a `notes` field documenting the two-domain split for this partner.
- Completed all 13 research-capture categories for LolaJack Norway: 9 `collected` (casinos, deposits, withdrawals, betting, casino_bonuses, vip_casino_programs, cashback_offers, casino_games, communication_managers, legal), 3 `not_found` with reasons recorded in the manifest (vip_betting_programs, loyalty_programs, free_spins — all absorbed into the single unified `/no/vip` program or bundled inside deposit bonuses). 32 screenshots + 24 HTML snapshots saved under `research/lolajack-norway/{screenshots,html}/`.
- Browser-capture phase (first page navigation to last category marked `collected`) ran 2026-07-09T15:59:38Z → 2026-07-09T16:26:44Z, ≈27 minutes, ~170-180k tokens (per user, from the Claude Code session/usage panel).

## Decided

- `/research-capture` invoked with a brand name ("LolaJack") instead of a domain — asked the user for the operational domain rather than guessing, since wrong guesses waste probing round-trips. User supplied `https://lola-jack.com/`.
- Promotions scope is CASINO and SPORTS only — crypto and "special" promotion tabs are out of scope regardless of content. On LolaJack both `/no/promotions/crypto` and `/no/promotions/special` were empty anyway, but the exclusion is a scope rule, not an artifact of this partner being empty there. Now written into the skill prompt, ADR 0044 and the digest.
- Output directory is `research/<partner>-<geo>/` (e.g. `research/lolajack-norway/`), not `research/<partner>/` — the same brand is captured once per market, so the geo belongs in the path. `<partner>` comes from the operational domain's brand (`ll92--lolajack.com` → `lolajack`), never from the SEO domain (`lola-jack.com` would have given `lola-jack`). Skill, ADR 0043/0044, digest, PRD and CONTEXT.md updated; the existing `research/lola-jack/` directory was renamed to `research/lolajack-norway/`.

## Open defects

- None — SEO/operational split for this partner is fully resolved as of this session.

## Verified external facts

- `lola-jack.com` is a thin WordPress marketing site, not the casino app: every CTA (`Login`, `Spill nå`, locale banners) points at `/play`, which is a client-side-only redirect — `curl` sees it as 307→homepage or 404, so it's a dead end for any non-browser probe. Its sitemap only lists the 11 locale landing pages themselves, nothing under `/play`.
- The real operational domain had to be found by testing brand-name domain variants (`lolajack.com`, `lolajack1.com`) with `curl -sIL` and reading the final `location:` header — both landed on `ll92--lolajack.com`, which is a different pattern from the trailing-digit-strip heuristic in the research-capture skill (`slotoro1.bet` → `slotoro.bet`); here the SEO domain has a hyphen (`lola-jack.com`) and the operational domain has an `ll92--` prefix, so no mechanical string transform connects them — only redirect-chain probing worked.
- LolaJack's cashier (deposit/withdraw) payment-method tiles render directly in the accessibility tree with name + min amount + fee — unlike `slotoro1.bet`, there is no cross-origin iframe here, so the per-method click-through screenshot loop wasn't needed. The full method list (20 deposit / 19 withdrawal) still required the same fixed-overlay scroll workaround as the skill's pitfalls table (`el.scrollTop` increments on `.stb-overlay-pane.modal-dialog-panel.cashier-modal`, viewport screenshots, not `fullPage`).
- `/no/promotions/casino/weekend_crypto_reload1` and `/no/promotions/casino/welcome_crypto_offer1` are byte-identical duplicate routes of `weekend_crypto_reload` and `welcome_crypto_offer` respectively (diffed with refs stripped) — same duplicate-route pattern seen on `slotoro1.bet` in the prior session.
- `gold-saloon-roulette-lucky-number` promo carries an explicit date range ("Kampanjedatoene er: 01.07.2026 - 31.07.2026") and was excluded as time-limited; the other 6 casino bonuses and both cashback offers explicitly state "Denne kampanjen har ingen fast sluttdato" (no fixed end date).
- LolaJack has no dedicated Bonus T&C / Complaints Policy / Betting Rules / Refund Policy pages — all except Refund Policy are accordion sections inside one consolidated `/no/rules` document ("Generelle vilkår og betingelser"). No Refund Policy exists anywhere on the site. No PDF download option on any legal page (rules, privacy-policy, cookies-policy).
- Account-specific bonus view lives at `/no/account/bonuses/available` (reached via header user menu → "Mine bonuser" → "Tilgjengelige bonuser"), distinct in URL and layout from the public `/no/promotions/casino` listing, and shows an "Aktiver" (activate) action plus a separate "Bonusvilkår" link per bonus.

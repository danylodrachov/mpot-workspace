---
title: RunMedia casino import template — structure audit
date: 2026-07-10
type: session-facts
---

## Verified external facts

- RunMedia import template (`[RunMedia] casino_import_template.xlsx`) has 13 sheets: Dropdowns, Casinos, Communication_Managers, Deposits, Withdrawals, Betting, Casino_Bonuses, VIP_Casino_Programs, VIP_Betting_Programs, Loyalty_Programs, Free_Spins, Cashback_Offers, Casino_Games.
- Dropdowns sheet defines allowed values for 14 fields; 159 payment methods, 419 game titles, 144 sports, 128 features.
- Dropdowns `countries` contains 4 values: Austria, Brazil, Chile, Norway. `licenses` contains 4: Anjouan, Curaçao, Kahnawake, MGA.
- Currently populated with 5 Chile casinos only: 20Bet (P1), Jugabet (P2), Tonybet (P2), Novibet (P2), 1xBet (P3). All status=active.
- Data volume per sheet: Deposits 64 rows, Withdrawals 31, Casino_Games 64, Free_Spins 12, Betting 5, Casino_Bonuses 5, VIP_Casino_Programs 4, Cashback_Offers 4, Loyalty_Programs 3.
- Two sheets are empty (headers only): Communication_Managers (5 cols), VIP_Betting_Programs (6 cols).
- Casinos master sheet has 22 columns including login/password, promo URL, license details (name + number + link), app links (iOS/Android), refund policy as free-text, flagship game, game count, FS max.
- Withdrawals sheet is the most granular: 15 columns including commission flag/details, same-method-required, ID verification, deposit turnover multiplier, max pending withdrawals.
- Casino_Bonuses contains the densest text — 1xBet first-deposit bonus cell holds full T&C (~3K chars).
- Template rows pre-allocated at ~1000 per sheet — designed for scale across all 4 countries.

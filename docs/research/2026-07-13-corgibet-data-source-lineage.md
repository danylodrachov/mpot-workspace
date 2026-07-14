# Corgibet data↔source lineage

## Corpus
- 30 `.md`; 7 `.png`; 0 `.yml/.yaml/.json/html`
- 17 MD with page URL; 13 MD without URL; all 13=no-link promotion detail/window captures
- URL-MD: 13 data-bearing; 2 URL-only (`casino-app.md`,`responsible-gaming.md`); 2 URL+capture instruction only (`faq.md`,`loyalty.md`)
- PNG: 5 browser-page states with visible URL; 2 cropped overlays/windows without visible URL (`welcome-bonus.png`,`vpn-restriction.png`)
- Primary capture hosts: `49corgibet22.com`(13 pages), `45corgibet68.com`(4 pages); page text/brand/email consistently `corgibet.com`/`contact@corgibet.com`; no MD uses `corgibet.com` as primary first-line source
- H49 captures: 08:17–11:18; H45 captures: 11:15–11:17, 2026-07-13
- First-line URL=page capture source; later URLs are page-content references, not capture roots (`bonus-terms`→`corgibet.com/restricted-slots`; `betting-terms`→WhoScored/365Scores/SofaScore/FIFA/FotMob/SoccerStats)

## Provenance graph

### Casino promotions
`H49/promotions/casino?tab=bonuses`
- page summary: `promotions-casino-bonuses.md`
- visual state: `screenshots/promotions-casino-bonuses.png`
- no-link card/window children:
  - `...-first-deposit-bonus.md`
  - `...-second-deposit-bonus.md`
  - `...-third-deposit-bonus.md`
  - `...-weekly-cashback.md`
  - `...-thursday-bonus-round.md`
  - `...-sunday-reload.md`
- join evidence: exact card titles; shared values/codes; filename prefix; parent 08:22→PNG 08:23→children 08:25–08:50

### Sports promotions
`H49/promotions/sports?tab=promotions`
- page summary: `promotions-sports-bonuses.md`
- no-link card/window children:
  - `...sports:1st-deposit-bonus.md`
  - `...sports:2nd-deposit-bonus.md`
  - `...sports:3rd-deposit-bonus.md`
  - `...sports-predict-and-win.md`
  - `...sports-sports-cashback.md`
  - `...sports-cash-out.md`
  - `...sports-multiply.md`
- visual state: `screenshots/promotions-sports-bonuses.png`; browser URL=`.../sports?tab=all`, not parent MD `tab=promotions`
- join evidence: exact card titles/values; filename prefix; PNG 08:39→parent 08:41→children 08:44–08:54
- `tab=all` PNG adds visible `PRIZE EACH DAY` + `WEEKLY CHAMPION`; absent from `tab=promotions` MD/children

### Other page joins
- `H49/sportsbook`→`betting-options.md` + `screenshots/sportsbook.png`; PNG 08:55→MD 08:57
- `H49/faq`→`faq.md` + `screenshots/faq.png`; PNG 09:25→MD 09:27; MD stores action instruction, no answers
- `H49/loyalty`→`loyalty.md` + `screenshots/loyalty.png`; PNG 09:14→MD 11:17; MD stores action instruction, no accordion answers
- `H49/live`→`live-casino.md`; extracted labels + classification instruction
- `H49/games/slots`→`slot-games.md`; 4 titles + navigation constraint
- `H49/app`→`casino-app.md`; URL only; app existence also visually present as footer badge in FAQ PNG
- `H49/responsible-gaming`→`responsible-gaming.md`; URL only
- `H49/about-us`→`about-us.md`
- `H49/terms`→`t&c.md`; explicit effective date `2025-04-21`
- `H49/bonus-terms`→`accounts-payouts-bonuses.md`
- `H49/betting-terms`→`sport-betting-terms.md`
- `H45/bitcoins`→`about-btc.md`
- `H45/aml-policy`→`aml-policy.md`
- `H45/dispute-resolution`→`dispute-resolution.md`
- `H45/self-exclusion`→`self-exclusion-policy.md`

## Exact cross-source joins

### Welcome package aggregates
- Casino cards: max `25,000+25,000+15,000 NOK=65,000 NOK`; FS `100+150+0=250`; exact match `welcome-bonus.png`: `up to 65 000 kr + 250 FS`
- Sports cards: `15,000 NOK×3=45,000 NOK`; freebet `1,000 NOK×3=3,000 NOK`; exact match `welcome-bonus.png`: `up to 45 000 kr + up to 3 000 kr Freebet`
- `bonus-terms`: `€1,500=15,000 NOK`; `€100=1,000 NOK`; exact sports card currency equivalence

### Parent summary↔window detail splits
- Casino 1st: parent max/FS summary; child tier percentages, deposits, max
- Casino 2nd: parent max/FS summary; child tier percentages, deposits, max
- Casino 3rd: parent max; child percentages, deposits, max
- Weekly Cashback: parent `15%`; child promotional copy only
- Thursday Bonus Round: parent `Code:SPLASH`; child eligible slots + `€10` round + `€20` min deposit; neither file alone contains full record
- Sunday Reload: parent percentage/max/code; child repeats summary + `200 NOK` min deposit + Sunday timing
- Sports deposit cards: parent NOK maxima; children percentages/freebet tiers/deposit thresholds
- Predict and Win: parent prize pool; child adds second weekly pool + `31.08` expiry(no year)
- Sports Cashback: parent cadence/loss scope; child adds rank-dependent rate statement, no rates
- Cash Out: parent label/benefit; child settlement mechanics
- ComboBoost: parent `1.5x`; child `4+` events, each odds `1.30`, max multiplier at `16+`

### Policy/content joins
- Account/withdrawal/KYC text overlaps `t&c.md`, `accounts-payouts-bonuses.md`, `aml-policy.md`
- Complaint escalation/server-log authority/Costa Rica jurisdiction overlap `t&c.md` + `dispute-resolution.md`
- Responsible-gambling usable text exists in `self-exclusion-policy.md`; `responsible-gaming.md` has no content
- Crypto support: `t&c.md` accepts BTC/other crypto; `about-btc.md` names Bitcoin-implied, Ethereum, `XPR`, Litecoin, Bitcoin Cash; `t&c.md` adds EUR internal currency/network-error rules
- Providers: `about-us.md`=Amatic, BetSoft, Endorphina, Microgaming, BGaming; `live-casino.md` adds Pragmatic Play as provider, not category
- Sports UI inventory=`betting-options.md`; settlement/rule corpus=`sport-betting-terms.md`; 49 option rows/48 unique, including duplicated `Formula`; exact/normalized rule-heading overlap includes Tennis, Basketball, Cricket, Ice Hockey, Handball, Volleyball, Darts, MMA, Golf, Boxing, Baseball, American Football, Table Tennis, Australian Football, Futsal, Snooker

## Divergence/conflicts

| Fact | Source A | Source B | Relation |
|---|---|---|---|
| Sports 3rd deposit tiers | no-link child: `55/65/75%`; freebet `10/15/15%` | `bonus-terms`: `100/125/150%`; freebet `15/15/20%` | child duplicates 2nd-deposit values; direct conflict |
| Casino FS allocation | promotion summary: 1st `100`, 2nd `150` | `bonus-terms`: 1st `50×3=150`, 2nd `50×2=100` | per-deposit conflict; total=`250` both |
| Casino per-deposit max | promotion cards: `25k/25k/15k NOK` | `bonus-terms`: generic max `1,500 NOK` each, `unless otherwise specified` | promotion-specific override scope; aggregate PNG confirms `65k` |
| Norway access | `vpn-restriction.png`: Norway flag; access/registration denied; proxy/VPN also stated possible cause | `t&c`: NOK accepted; Norway absent general restricted-country lists | session/UI state conflicts with static country list; modal cause is non-exclusive |
| Payout speed | `about-us`: instant deposits and payouts | `t&c`: withdrawal processing up to 3 business days; >€/$10k may be monthly installments | marketing vs contractual timing |
| License | `about-us`: `Licensed online casino` | all collected legal pages | no operator, license number, issuing authority, or named regulator present |
| Sports promotion inventory | PNG `tab=all`: 9 visible cards | MD `tab=promotions`: 7 cards | filter-state difference; `Prize Each Day`,`Weekly Champion` excluded |
| Sports 2nd title | UI/parent/child: `2ST/2st` | ordinal semantics | source typo retained |
| Sunday Reload mechanics | casino modal: deposit bonus `30% up to 1,500 NOK` | `bonus-terms` section `Reload Bonus`: no-risk/accumulator odds mechanics | same generic label, incompatible mechanics/vertical scope unresolved |
| Finland welcome | `bonus-terms` 4.10: no Welcome offer | section 8: special 250 FS instead of standard package | special-case replacement stated in same source |
| Game scale | `about-us`: `>6,000 games` | `slot-games.md`: 4 titles; `live-casino.md`: 5 usable categories | collected inventory is partial, not claim verification |

## Source-state facts absent from MD data
- `welcome-bonus.png`: casino/sports aggregate package choices + no-bonus option
- `vpn-restriction.png`: Norway/session access denial
- `faq.png`: categories Account, Bonus, Deposit, Verification, Withdrawal, Activities, Games, Sportsbook; Account tab shows 11 collapsed questions; answers absent
- `loyalty.png`: visible perk labels: coins for bets/deposits, weekly reload, Thursday bonus round, missions, VIP club/manager, dedicated support, exclusive tournaments/bonuses, increased withdrawal limits, withdrawal priority; 9 collapsed loyalty questions; answers/rank names/details incomplete/cropped
- sports `tab=all` PNG: `Prize Each Day`, `Weekly Champion`; no child files

## Non-source instruction contamination inside MD
- `live-casino.md`: category/provider classification rules + output instruction
- `slot-games.md`: `titles only; never visit individual game pages`
- `faq.md`,`loyalty.md`: filesystem screenshot path + click/analyze instruction
- `promotions-sports-bonuses-sports-predict-and-win.md`: `Non fit for populating data...` editorial/model decision
- These strings are not website facts

## Footer/navigation coverage
Visible FAQ/Loyalty footer links represented in archive:
- Promotions; About Us; About BTC; AML Policy; Self-Exclusion; Terms & Conditions; Accounts/Payouts/Bonuses; Responsible Gaming; Dispute Resolution; FAQ; Sport Betting Terms
Visible but absent:
- Fairness & RNG Testing Methods; Privacy Policy; KYC Policies; Affiliates

## Field→source matrix
| Field | Primary evidence | Secondary/context |
|---|---|---|
| Brand/general claims | `about-us.md` | legal pages constrain marketing claims |
| License | `about-us.md` claim only | identity/details absent |
| Game count | `about-us.md` | no inventory corroboration |
| Slot titles | `slot-games.md` | exactly 4 captured |
| Live categories | `live-casino.md` | Roulette, Blackjack, Baccarat, Game Shows, Poker; Pragmatic Play=provider |
| Providers | `about-us.md`,`live-casino.md` | 6 named across files |
| Sports offered | `betting-options.md` | `sportsbook.png`; rule coverage in `sport-betting-terms.md` |
| Casino promotions | casino parent + 6 no-link windows | bonus terms + casino PNG + welcome PNG |
| Sports promotions | sports parent + 7 no-link windows | bonus terms + sports PNG + welcome PNG |
| Bonus wagering | `accounts-payouts-bonuses.md` | promotion cards/windows contain offer values, not complete rules |
| Loyalty | `loyalty.png` | `loyalty.md` no extracted answer text |
| FAQ | `faq.png` | `faq.md` no extracted answer text |
| Deposit/withdrawal | `t&c.md`,`accounts-payouts-bonuses.md` | `about-us.md` marketing statement |
| Currency/crypto | `t&c.md`,`about-btc.md` | promotion files use NOK/EUR mixed display |
| KYC/AML | `aml-policy.md`,`t&c.md` | `accounts-payouts-bonuses.md` payout checks |
| Geo/access | `t&c.md` | `vpn-restriction.png` session state |
| Responsible gambling | `self-exclusion-policy.md` | `responsible-gaming.md` empty |
| Disputes | `dispute-resolution.md` | duplicated contractual section in `t&c.md` |
| App | `casino-app.md` URL; FAQ footer badge | no features/platform/download data |

## Verification limits
- Raw Playwright YAML absent: no node-level provenance, selectors, modal ancestry, click sequence, hidden/visible state, or YAML→MD fidelity test possible
- No page HTML/network payload: no DOM-vs-visual-vs-accessibility-tree comparison
- No source URL in 13 detail files by design; parent inheritance is reconstructable from names/titles/timestamps/value matches, not embedded provenance metadata

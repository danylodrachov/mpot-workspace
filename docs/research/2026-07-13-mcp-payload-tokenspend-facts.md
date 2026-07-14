# Фактаж: склад і токенний обсяг Playwright MCP payload

## Межі аналізу

- Архів: `html(1).zip`, 187 941 байт
- Вміст: 24 YAML-файли accessibility snapshots Playwright
- Розпакований YAML: 1 311 162 байт; 1 309 539 символів; 23 386 рядків; 99 397 whitespace-delimited елементів
- Usage/API logs, системні промпти, Claude Skills, MCP tool schemas, model output і фінальні JSON-файли в архіві відсутні
- Billed input/output/cache token counts Anthropic у файлах відсутні
- Наведені token counts отримані локально через `anthropic-tokenizer 0.1.0`, embedded 65k BPE; це не Anthropic Usage API

## Сукупний обсяг

- Повний YAML: **362 682 local-BPE tokens**
- Середнє на snapshot: **15 112 tokens**
- Медіана на snapshot: **7 247–7 268 tokens**
- Мінімум: `legal-cookies-policy.yml` — 4 728
- Максимум: `deposit-methods.yml` — 49 793

## Окремі виміри серіалізаційного складу

| Вимір | Tokens | Частка повного YAML |
|---|---:|---:|
| Повний YAML | 362 682 | 100,00% |
| YAML після вилучення всіх `[ref=…]` | 223 350 | 61,58% |
| Різниця, пов’язана з `[ref=…]` | 139 332 | 38,42% |
| YAML після вилучення всіх bracket metadata (`ref`, `cursor`, `level`, states) | 199 325 | 54,96% |
| Різниця, пов’язана з усіма bracket metadata | 163 357 | 45,04% |
| Лише content-bearing lines: visible label/text або URL | 245 656 | 67,73% |
| Лише structural-only lines: без visible label/text і URL | 117 026 | 32,27% |

Ці виміри перекриваються; рядки таблиці не є адитивними категоріями.

## Metadata occurrences

- `[ref=…]`: 17 704 occurrences; 15 334 distinct ref strings
- `[cursor=…]`: 4 933
- `[level=…]`: 148
- `[disabled]`: 72
- `[active]`: 22
- `[checked]`: 6
- `[expanded]`: 4
- `[selected]`: 2
- Усі bracket metadata: 22 891 occurrences
- Delta після вилучення тільки refs: 139 332 tokens; 7.87 tokens на ref occurrence у цьому corpus

## Visible strings та URL values

| Value type | Instances | Unique values | Isolated BPE tokens, all instances | Isolated BPE tokens, unique once | Duplicate-instance tokens |
|---|---:|---:|---:|---:|---:|
| Visible labels/text | 9 397 | 1 676 | 51 168 | 16 435 | 34 733 |
| URL values | 4 016 | 466 | 45 591 | 6 728 | 38 863 |
| Разом | 13 413 | 2 142 | 96 759 | 23 163 | 73 596 |

- Duplicate value instances: 11 271 з 13 413 (84,03%)
- Duplicate-instance isolated value tokens: 73 596 з 96 759 (76,06%)
- Unique-once isolated value tokens: 23 163 з 96 759 (23,94%)

## Repetition після нормалізації refs

- Рядків: 23 386
- Distinct normalized lines після заміни конкретних ref IDs на `[ref]`: 2 731
- Повторні normalized-line instances: 20 655 (88,32%)
- Line-isolated BPE tokens у всіх normalized lines: 261 603
- Line-isolated BPE tokens у distinct normalized lines один раз: 47 128
- Line-isolated BPE tokens у повторних instances понад перше входження: 214 475 (81,98%)

## Shared values, присутні у всіх 24 snapshots

- Distinct shared values: 143; visible strings: 82; URLs: 61
- Instances цих values у всьому corpus: 4 936
- Isolated BPE tokens усіх instances: 27 215
- Isolated BPE tokens distinct shared values один раз: 864
- Повторні isolated tokens цих shared values понад одне входження: 26 351

Найчастіші shared visible values:

| Value | Occurrences | Files | Tokens/value |
|---|---:|---:|---:|
| `Casino` | 117 | 24 | 2 |
| `Odds` | 109 | 24 | 1 |
| `VIP klubb` | 82 | 24 | 4 |
| `Hesteveddeløp` | 79 | 24 | 6 |
| `Live odds` | 75 | 24 | 2 |
| `Hjelpesenter` | 73 | 24 | 6 |
| `Jackpotter` | 72 | 24 | 3 |
| `Live casino` | 72 | 24 | 2 |
| `0` | 62 | 24 | 1 |
| `Hjem` | 56 | 24 | 3 |
| `2` | 52 | 24 | 1 |
| `kampanjer` | 52 | 24 | 4 |
| `Alle Jackpotter` | 50 | 24 | 4 |
| `Retningslinjer for informasjonskapsler` | 49 | 24 | 11 |
| `Aksepter alle` | 48 | 24 | 4 |
| `Belønninger` | 48 | 24 | 5 |
| `Betalinger` | 48 | 24 | 3 |
| `Butikk` | 48 | 24 | 2 |
| `Inerac e-Transfer` | 48 | 24 | 6 |
| `Lolajack` | 48 | 24 | 4 |

Найчастіші shared URL values:

| URL | Occurrences | Files | Tokens/value |
|---|---:|---:|---:|
| `/no/sport` | 60 | 24 | 4 |
| `/no/live-betting/live` | 52 | 24 | 9 |
| `/no/horse-racing` | 51 | 24 | 6 |
| `/no/shop` | 51 | 24 | 4 |
| `/no/vip` | 51 | 24 | 4 |
| `/no/` | 48 | 24 | 3 |
| `/no/cookies-policy` | 48 | 24 | 6 |
| `/no/help-centre` | 48 | 24 | 6 |
| `/no/payments` | 48 | 24 | 4 |
| `/no/promotions` | 41 | 24 | 5 |
| `/no/live-casino/top-live-casino` | 37 | 24 | 14 |
| `/no/games/new` | 34 | 24 | 6 |
| `/no/games/popular` | 34 | 24 | 6 |
| `/no/games/slots` | 34 | 24 | 6 |
| `/no/games/world-championship` | 34 | 24 | 10 |
| `/no/jackpots/hot-jackpots` | 33 | 24 | 12 |
| `/no/games/top` | 31 | 24 | 6 |
| `/no/games` | 30 | 24 | 4 |
| `/no/live-casino/baccarat-and-dice` | 28 | 24 | 14 |
| `/no/live-casino/blackjack` | 28 | 24 | 10 |

## Найчастіші values у всьому corpus

| Visible value | Occurrences | Tokens/value |
|---|---:|---:|
| `ny` | 585 | 1 |
| `Casino` | 117 | 2 |
| `Odds` | 109 | 1 |
| `VIP klubb` | 82 | 4 |
| `Hesteveddeløp` | 79 | 6 |
| `Live odds` | 75 | 2 |
| `Hjelpesenter` | 73 | 6 |
| `Live casino` | 72 | 2 |
| `Jackpotter` | 72 | 3 |
| `Provider tile link` | 69 | 3 |
| `0` | 62 | 1 |
| `Hjem` | 56 | 3 |
| `Gold Saloon Roulette` | 54 | 5 |
| `2` | 52 | 1 |
| `kampanjer` | 52 | 4 |
| `Les mer` | 52 | 2 |
| `1 1` | 52 | 2 |
| `−` | 52 | 1 |
| `Alle Jackpotter` | 50 | 4 |
| `Retningslinjer for informasjonskapsler` | 49 | 11 |
| `Se alle` | 49 | 2 |
| `Lolajack` | 48 | 4 |
| `Spill, kategorier, leverandører` | 48 | 12 |
| `Butikk` | 48 | 2 |
| `WORLD CUP GO!` | 48 | 5 |

| URL value | Occurrences | Tokens/value |
|---|---:|---:|
| `/no/sport` | 60 | 4 |
| `/no/live-betting/live` | 52 | 9 |
| `/no/shop` | 51 | 4 |
| `/no/horse-racing` | 51 | 6 |
| `/no/vip` | 51 | 4 |
| `/no/` | 48 | 3 |
| `/no/help-centre` | 48 | 6 |
| `/no/payments` | 48 | 4 |
| `/no/cookies-policy` | 48 | 6 |
| `/no/promotions` | 41 | 5 |
| `/no/live-casino/top-live-casino` | 37 | 14 |
| `/no/games/new` | 34 | 6 |
| `/no/games/popular` | 34 | 6 |
| `/no/games/world-championship` | 34 | 10 |
| `/no/games/slots` | 34 | 6 |
| `/no/jackpots/hot-jackpots` | 33 | 12 |
| `/no/games/top` | 31 | 6 |
| `/no/games` | 30 | 4 |
| `/no/live-casino/roulette` | 28 | 11 |
| `/no/live-casino/blackjack` | 28 | 10 |
| `/no/live-casino/international-tables` | 28 | 11 |
| `/no/live-casino/game-shows` | 28 | 11 |
| `/no/live-casino/baccarat-and-dice` | 28 | 14 |
| `/no/sport/football` | 28 | 6 |
| `/no/world-cup-go` | 27 | 8 |

## Parent/descendant duplicated accessible labels

- Visible value повторюється в descendant node під ancestor node з тим самим value: 669 occurrences
- Isolated token count повторених descendant values: 2 506

| Ancestor role → descendant role | Occurrences |
|---|---:|
| `link` → `generic` | 328 |
| `button` → `generic` | 190 |
| `button` → `img` | 72 |
| `link` → `img` | 39 |
| `button` → `text` | 12 |
| `link` → `paragraph` | 11 |
| `radio` → `generic` | 9 |
| `link` → `text` | 8 |

Найчастіші duplicated ancestor/descendant values:

| Value | Occurrences | Tokens/value |
|---|---:|---:|
| `VIP klubb` | 30 | 4 |
| `Hjem` | 28 | 3 |
| `Hesteveddeløp` | 26 | 6 |
| `−` | 26 | 1 |
| `Casino` | 25 | 2 |
| `Lolajack` | 24 | 4 |
| `Spill, kategorier, leverandører` | 24 | 12 |
| `Live casino` | 24 | 2 |
| `Jackpotter` | 24 | 3 |
| `Odds` | 24 | 1 |
| `Live odds` | 24 | 2 |
| `WORLD CUP GO!` | 24 | 5 |
| `kampanjer` | 24 | 4 |
| `Hjelpesenter` | 24 | 6 |
| `Norsk` | 24 | 2 |
| `Visa` | 24 | 2 |
| `Mastercards` | 24 | 2 |
| `Inerac e-Transfer` | 24 | 6 |
| `Aksepter alle` | 24 | 4 |
| `Vis mer` | 12 | 2 |
| `Tilbake til alle tilbud` | 8 | 7 |
| `Club Friendlies` | 8 | 3 |
| `Innskudd` | 7 | 4 |
| `Meld deg på` | 7 | 4 |
| `Utfordringer` | 6 | 4 |

## Node-role line composition

| Line role | Lines | Characters incl. line break | Character share |
|---|---:|---:|---:|
| `generic` | 7 849 | 381 800 | 29,15% |
| `link` | 4 016 | 283 407 | 21,64% |
| `url` | 4 016 | 225 598 | 17,23% |
| `listitem` | 2 119 | 86 733 | 6,62% |
| `img` | 1 922 | 91 544 | 6,99% |
| `paragraph` | 1 532 | 104 105 | 7,95% |
| `button` | 887 | 66 687 | 5,09% |
| `list` | 318 | 10 955 | 0,84% |
| `text` | 249 | 29 821 | 2,28% |
| `heading` | 148 | 11 356 | 0,87% |
| `cell` | 72 | 4 299 | 0,33% |
| `navigation` | 50 | 1 792 | 0,14% |
| `combobox` | 33 | 2 861 | 0,22% |
| `main` | 27 | 753 | 0,06% |
| `banner` | 24 | 635 | 0,05% |

- `generic`, `link`, `/url` together: 15 881 lines; 68,02% of characters
- Top 7 roles (`generic`, `link`, `/url`, `listitem`, `img`, `paragraph`, `button`): 94,68% of characters

## Snapshot-level distribution

| Snapshot | Tokens | Corpus share | Lines | Refs delta | Structural-only tokens | Visible+URL instances | Distinct values | Duplicate value tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `deposit-methods.yml` | 49 793 | 13,73% | 3 304 | 19 290 | 19 226 | 1 732 | 757 | 6 766 |
| `homepage.yml` | 49 766 | 13,72% | 3 326 | 19 368 | 18 050 | 1 845 | 764 | 6 558 |
| `withdraw-methods.yml` | 48 514 | 13,38% | 3 313 | 17 913 | 18 516 | 1 728 | 759 | 6 850 |
| `sport.yml` | 36 674 | 10,11% | 2 191 | 16 245 | 9 458 | 1 392 | 679 | 3 456 |
| `live-casino.yml` | 35 771 | 9,86% | 2 370 | 13 113 | 13 627 | 1 258 | 452 | 6 361 |
| `live-odds.yml` | 17 055 | 4,70% | 1 065 | 7 402 | 5 008 | 630 | 400 | 1 182 |
| `vip.yml` | 11 530 | 3,18% | 844 | 5 648 | 4 609 | 430 | 268 | 567 |
| `match-markets.yml` | 11 112 | 3,06% | 716 | 5 100 | 3 595 | 407 | 303 | 410 |
| `slots.yml` | 8 878 | 2,45% | 581 | 3 071 | 2 216 | 379 | 209 | 1 010 |
| `cashback-daily.yml` | 7 840 | 2,16% | 457 | 2 756 | 1 558 | 315 | 253 | 290 |
| `bonus-weekend-crypto-reload.yml` | 7 418 | 2,05% | 425 | 2 333 | 1 698 | 270 | 222 | 192 |
| `bonus-welcome-crypto.yml` | 7 268 | 2,00% | 420 | 2 305 | 1 688 | 266 | 216 | 210 |
| `bonus-weekly-crypto-reload.yml` | 7 247 | 2,00% | 419 | 2 305 | 1 676 | 266 | 218 | 192 |
| `bonus-welcome-package.yml` | 7 097 | 1,96% | 414 | 2 277 | 1 665 | 262 | 213 | 191 |
| `bonus-weekend-reload.yml` | 6 964 | 1,92% | 406 | 2 248 | 1 643 | 256 | 209 | 188 |
| `cashback-live.yml` | 6 455 | 1,78% | 394 | 2 261 | 1 546 | 253 | 201 | 210 |
| `bonus-weekly-reload.yml` | 6 442 | 1,78% | 388 | 2 163 | 1 588 | 243 | 196 | 188 |
| `promotions-casino.yml` | 6 407 | 1,77% | 419 | 2 406 | 1 688 | 265 | 187 | 332 |
| `about.yml` | 5 299 | 1,46% | 315 | 1 726 | 1 313 | 195 | 155 | 163 |
| `help-centre.yml` | 5 225 | 1,44% | 348 | 1 959 | 1 368 | 223 | 171 | 191 |
| `legal-terms-and-conditions.yml` | 5 199 | 1,43% | 323 | 1 851 | 1 269 | 207 | 166 | 173 |
| `account-bonuses-available.yml` | 5 052 | 1,39% | 326 | 2 085 | 1 505 | 199 | 153 | 184 |
| `legal-privacy-policy.yml` | 4 948 | 1,36% | 314 | 1 781 | 1 258 | 199 | 158 | 169 |
| `legal-cookies-policy.yml` | 4 728 | 1,30% | 308 | 1 726 | 1 258 | 193 | 152 | 174 |

## Concentration

- Top 3 snapshots: 148 073 tokens (40,83%)
- Top 5 snapshots: 220 518 tokens (60,80%)
- Top 6 snapshots: 237 573 tokens (65,50%)
- Top 10 snapshots: 276 933 tokens (76,36%)
- `homepage.yml` + `deposit-methods.yml` + `withdraw-methods.yml`: 148 073 tokens (40,83%)

## Similarity: homepage/deposit/withdraw snapshots

Refs normalized to `[ref]` before comparison.

| Pair | Lines A | Lines B | Sequence-matching lines | SequenceMatcher ratio | Multiset-overlap lines | Overlap of A | Overlap of B |
|---|---:|---:|---:|---:|---:|---:|---:|
| `homepage.yml` ↔ `deposit-methods.yml` | 3 326 | 3 304 | 3 036 | 91,58% | 3 040 | 91,40% | 92,01% |
| `homepage.yml` ↔ `withdraw-methods.yml` | 3 326 | 3 313 | 3 036 | 91,46% | 3 040 | 91,40% | 91,76% |
| `deposit-methods.yml` ↔ `withdraw-methods.yml` | 3 304 | 3 313 | 3 099 | 93,67% | 3 099 | 93,80% | 93,54% |

## Largest per-snapshot duplicate value totals

| Snapshot | Value instances | Distinct values | Duplicate instances | Isolated value tokens | Duplicate-instance tokens | Duplicate-token share |
|---|---:|---:|---:|---:|---:|---:|
| `withdraw-methods.yml` | 1 728 | 759 | 969 | 13 251 | 6 850 | 51,69% |
| `deposit-methods.yml` | 1 732 | 757 | 975 | 13 094 | 6 766 | 51,67% |
| `homepage.yml` | 1 845 | 764 | 1 081 | 12 785 | 6 558 | 51,29% |
| `live-casino.yml` | 1 258 | 452 | 806 | 10 119 | 6 361 | 62,86% |
| `sport.yml` | 1 392 | 679 | 713 | 8 343 | 3 456 | 41,42% |
| `live-odds.yml` | 630 | 400 | 230 | 3 836 | 1 182 | 30,81% |
| `slots.yml` | 379 | 209 | 170 | 2 492 | 1 010 | 40,53% |
| `vip.yml` | 430 | 268 | 162 | 1 865 | 567 | 30,40% |
| `match-markets.yml` | 407 | 303 | 104 | 2 056 | 410 | 19,94% |
| `promotions-casino.yml` | 265 | 187 | 78 | 1 675 | 332 | 19,82% |

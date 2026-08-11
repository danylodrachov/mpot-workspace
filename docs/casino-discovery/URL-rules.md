# URL Rules

## Purpose

These rules define which URLs are allowed in `document-url-map.json`.

The URL map must contain only research-relevant document pages and approved product category landings. Everything else is discarded during route classification.

---

# Keep

## Bonus & Promotions

Keep:

- `/bonuses`
- `/promo`
- `/offers`
- `/offers-*`
- `/promotions` — deterministic alias of this class
- `/promotions/<category>` — deterministic alias of this class
- `/promotions/<category>/<offer-slug>` — deterministic alias of this class

---

## Payment Information

Keep:

- `/deposit`
- `/withdraw`
- `/payment-methods`
- `/payments`

Remove:

- `/transaction-history`

---

## Limits

Keep:

- `/bet-limits`
- `/deposit-limits`
- `/loss-limits`
- `/time-limits`

Remove:

- `/responsible-gaming`
- `/self-exclusion`

---

## Rules & Terms

Keep:

- `/terms-and-conditions`
- `/bonus-terms`
- `/rules`
- `/sports-rules`
- `/casino-rules`
- `/live-casino-rules`

Remove:

- `/privacy-policy`
- `/cookie-policy`

---

## Locale Prefixes

An optional single locale segment (e.g. `/en/`, `/en-GB/`, `/pt-BR/`) at the start of a path
is normalized away before route classification, so localized and non-localized aliases of the
same route classify identically:

```
/en/payments   → rule path /payments
/en/rules      → rule path /rules
/en/live-casino → rule path /live-casino
```

The original localized URL is always preserved as the browser navigation target — only the
rule-matching path is locale-stripped, never the stored/visited URL.

---

## Product Categories

Keep only canonical category landing pages. Casino sites express the same category either
nested under `/casino/<category>` or as a bare top-level route; both shapes are equivalent
and canonicalize to `/casino/<category>`.

Examples:

- `/casino/slots` and `/slots`
- `/casino/live-casino` and `/live-casino`
- `/casino/virtual-sports` and `/virtual-sports`
- `/horse-racing`
- `/football`
- `/tennis`
- `/basketball`

Nested category routes must be normalized to the canonical category.

Example:

```
/football/live
    ↓
/football
```

Never keep:

- live filters
- prematch filters
- tournaments
- leagues
- competitions
- individual events
- individual games

---

## Sports Category Roots (`/sport/<category>`)

Sports category roots may also be expressed as `/sport/<category>`. The category root is kept;
any nested league/event/tournament depth normalizes to the category root, never to the leaf page.

`<category>` must be a real sport name from a fixed, generic vocabulary (football, basketball,
tennis, ice-hockey, baseball, cricket, esports, ... — the same set for every casino site, never
hostname-specific). Competition, tournament, and league slugs are not sport names and do not
canonicalize as a category root.

Examples:

```
/sport/football                              → /sport/football (kept as-is)
/sport/football/england/premier-league       → /sport/football
/sport/basketball/north-america/nba          → /sport/basketball
/sport/uefa-champions-league                 → rejected (not a sport name; a competition slug)
/sport/uefa-europa-league                    → rejected (not a sport name; a competition slug)
/sport/uefa-conference-league                → rejected (not a sport name; a competition slug)
```

Individual game/event/match pages remain rejected wherever they appear outside this
normalization (e.g. `/game/<slug>`, `/event/<id>`).

Never visit or retain individual events, matches, leagues, tournaments, or competitions —
only the sport/category rail exposed by the canonical sports UI.

---

## Live-Casino Sub-Category Rail (`/casino/live-casino/<segment>`)

The live-casino landing page (`/casino/live-casino`) exposes a sub-category rail — e.g. Popular,
Blackjack, Roulette, Baccarat, Game Shows, Poker — when actually present on that page. Each rail
entry is a single nested segment under the canonical live-casino landing and is kept.

Examples:

```
/casino/live-casino/blackjack     → kept (rail entry)
/casino/live-casino/roulette      → kept (rail entry)
/casino/live-casino/game-shows    → kept (rail entry)
```

Never visit or retain individual live-casino game pages, provider-game launches, or demo-game
routes — these are rejected regardless of nesting depth:

```
/casino/live-casino/game/<slug>            → rejected
/casino/live-casino/provider-game/<slug>   → rejected
/casino/live-casino/demo-game/<slug>       → rejected
```

"More Games" / individual live game links on the landing page must never be enqueued.

---

# Remove

## Account UI

Always remove.

Examples:

- `/my-account/*`
- KYC
- personal data
- settings
- security
- responsible gaming inside account
- account information

---

## Navigation & Lobby Pages

Always remove.

Examples:

- `/`
- `/casino/lobby`
- `/casino/instant-games`
- `/sports/lobby`

---

## Support & Compliance

Always remove.

Examples:

- `/support`
- `/aml_kyc_policy`
- `/dispute-resolution-policy`
- `/personal-data-privacy`

---

## Corporate Pages

Always remove.

Examples:

- About
- Contacts
- Affiliates
- Careers
- News
- Blog
- Press
- Partners

---

# Route Normalization Rules

Sports category URLs must always be normalized to their root category.

Example:

```
/football/live
→
/football
```

Never store:

- `/live`
- `/prematch`
- event pages
- match pages
- tournament pages
- league pages

---

# TBD

The following classes have not yet been classified:

- API endpoints
- JSON endpoints
- CDN bundle URLs
- JS/CSS/image/font assets
- tracking URLs
- login/register/logout
- mobile app deep links
- external social media URLs
- affiliate outbound URLs
- mailto/tel
- language switchers
- query/hash duplicates
- health/status endpoints

Classification rules for these URL types will be defined later.
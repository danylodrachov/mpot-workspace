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

Examples:

```
/sport/football                              → /sport/football (kept as-is)
/sport/football/england/premier-league       → /sport/football
/sport/basketball/north-america/nba          → /sport/basketball
```

Individual game/event/match pages remain rejected wherever they appear outside this
normalization (e.g. `/game/<slug>`, `/event/<id>`).

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
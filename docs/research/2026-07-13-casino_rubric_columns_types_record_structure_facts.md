# Casino research data contract: columns/types/records — facts

`src=R5` unless tagged. `t`=JSON string target; `n`=JSON number target; `e{}`=exact string enum; `S`=singleton row-set; `C`=collection row-set; `K`=logical key. No implementation recommendations.

## 0. Corpus/authority

- R5 ZIP: 12 rubric JSON files; 12 categories; 106 column declarations; 71 unique column names; types: `t=57`, `n=17`, `e=32`.
- ZIP also contains `__MACOSX/._*` AppleDouble metadata; not rubrics.
- Rubric object shape: `{category:string,columns:[{name:string,type:"text"|"number"|"enum",values?:string[]}],operator_fields?:string[]}`.
- R5 is custom schema metadata, not JSON Schema: absent `$schema`,`type:object`,`properties`,`required`,`items`,`additionalProperties`,`format`,`pattern`,`minimum`,`maximum`,`uniqueItems`,`allOf/oneOf/if/then`. [JS]
- R5 defines columns/order/types/enums; no output root/envelope, row array, keys, cardinality, null policy, evidence, status, conflict, provenance, timestamps, version.
- JSON object member order has no semantic meaning; `columns[]` order is ordered metadata. JSON values support string/number/boolean/null/object/array. [RFC8259]

## 1. Complete category/column contract

### `casinos` `S` `K=casino+country` `22 cols`

`casino:t;country:e{Austria|Brazil|Chile|Norway};priority:t;promo_code_url:t;login:t;password:t;year_of_foundation:n;official_site_url:t;casino_license_name:e{Anjouan|Curaçao|Kahnawake|MGA};casino_license_number:t;casino_license_link:t;live_casino_bonus_type:e{cashback|excluded_from_wagering|none|other|tournament|welcome_bonus_applies};loyalty_program_exists:e{TRUE|FALSE};game:t;number_of_games:n;number_of_games_is_approximate:e{TRUE|FALSE};free_spins_max:n;refund:t;app_availability:e{TRUE|FALSE};ios_app_link:t;android_app_link:t;status:e{active|suspended|on_hold}`

`operator_fields={country|priority|promo_code_url|login|password|status}`

### `communication_managers` `C` `K=email` `5 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};manager_name:t;email:t;phone:t`

### `deposits` `C` `K=casino_name+country+payment_method` `8 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};payment_method:e159;min_deposit_amount:n;min_deposit_currency:t;max_deposit_amount:n;max_deposit_currency:t;deposit_conditions:t`

### `withdrawals` `C` `K=casino_name+country+payment_method` `15 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};payment_method:e159;min_withdrawal_amount:n;min_withdrawal_currency:t;max_withdrawal_amount:n;max_withdrawal_currency:t;max_withdrawal_period:e{monthly|weekly|daily|per_transaction|unspecified};withdrawal_conditions:t;has_withdrawal_commission:e{TRUE|FALSE};withdrawal_commission_details:t;same_method_required:e{TRUE|FALSE};id_verification:e{TRUE|FALSE};deposit_turnover_multiplier:t;max_pending_withdrawals:n`

### `betting` `S` `K=casino_name+country` `12 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};min_bet_amount:n;min_bet_currency:t;max_bet_amount:n;max_bet_currency:t;betting_conditions:t;welcome_bonus_betting:t;welcome_pack_betting:t;bet_builder:e{TRUE|FALSE};bet_builder_description:t;betting_live_streaming:e{TRUE|FALSE}`

### `casino_bonuses` `S` `K=casino_name+country` `9 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};welcome_package:t;welcome_bonus_casino:t;first_deposit_welcome_bonus_casino:t;second_deposit_welcome_bonus_casino:t;reload_bonus:t;rollover:t;rollover_description:t`

### `vip_casino_programs` `S` `K=casino_name+country` `6 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};program_name:t;tier_count:n;vip_entry_type:e{account_status_based|activity_based|automatic|automatic_first_deposit|invite_only|unspecified};notes:t`

### `vip_betting_programs` `S` `K=casino_name+country` `6 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};program_name:t;tier_count:n;vip_entry_type:e{account_status_based|activity_based|automatic|automatic_first_deposit|invite_only|unspecified};notes:t`

### `loyalty_programs` `S` `K=casino_name+country` `7 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};loyalty_program_exists:e{TRUE|FALSE};tier_count:n;reward_wagering_multiplier:t;points_expiry_months:n;notes:t`

### `free_spins` `C` `K=casino_name+country+free_spins_type` `6 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};free_spins_type:e{app_install|birthday|no_deposit|other|push_notification|referral|reload_deposit|telegram|tournament_lottery|vip_loyalty|welcome_first_deposit|wheel_of_fortune};free_spins_amount:n;free_spins_max:n;notes:t`

### `cashback_offers` `C` `K=casino_name+country+cashback_type` `5 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};cashback_type:e{casino_general|crypto|live_casino|other|sports|vip_loyalty};cashback_rate_max:t;notes:t`

### `casino_games` `C` `K=casino_name+country+game` `5 cols`

`casino_name:t;country:e{Austria|Brazil|Chile|Norway};game:t;number_of_games:n;number_of_games_is_approximate:e{TRUE|FALSE}`

## 2. Record grain/cardinality facts

|category|rows/casino-country|logical key|grain facts|
|---|---:|---|---|
|`casinos`|1|`casino+country`|master/roll-up row; 22 fields|
|`communication_managers`|0..n|`email`|one contact/manager per row; historical key=email; blank/shared email collapses identity|
|`deposits`|0..n|`casino_name+country+payment_method`|one payment method per row|
|`withdrawals`|0..n|`casino_name+country+payment_method`|one payment method per row; method values + casino-global rules coexist in same row shape|
|`betting`|0..1|`casino_name+country`|sportsbook summary row|
|`casino_bonuses`|0..1|`casino_name+country`|casino-bonus summary row|
|`vip_casino_programs`|0..1|`casino_name+country`|single program summary in historical key model; `program_name` not key|
|`vip_betting_programs`|0..1|`casino_name+country`|single program summary in historical key model; `program_name` not key|
|`loyalty_programs`|0..1|`casino_name+country`|loyalty summary row|
|`free_spins`|0..n|`casino_name+country+free_spins_type`|one offer/type row; key permits max one row/type|
|`cashback_offers`|0..n|`casino_name+country+cashback_type`|one offer/type row; key permits max one row/type|
|`casino_games`|0..n|`casino_name+country+game`|one title row; game-detail pages excluded by project scope; count fields are collection-level fields inside title-row schema|

- Historical project contracts uniformly wrap every category in `rows[]`, including singleton categories. [IP][ADR44]
- Historical logical keys are external to R5; R5 itself declares none. [IP]
- `free_spins`/`cashback_offers` keys contain type, not offer ID/start/end/name; ≥2 simultaneous offers of same type are not distinguishable by declared historical key.
- VIP singleton keys omit `program_name`; ≥2 programs in same casino-country are not distinguishable by declared historical key.
- `communication_managers` key=`email`; records with absent/shared email lack distinct stable identity.

## 3. Runtime record envelopes found in project files

### Legacy envelope [ADR44]

```json
{"site":"https://…","geo":"norway","casinos":{"status":"collected","rows":[{…}]},"deposits":{"status":"collected","rows":[{…}]},"casino_bonuses":{"status":"failed","failure_reason":"…"}}
```

### Newer envelope [IP]

```json
{"casino":"…","geo":"…","run_id":"…","started_at":"ISO8601","categories":{"<category>":{"rows":[{…}],"terminal_status":{"<field-or-row:field>":"value|not_applicable|not_found_after_budget|operator_required|blocked_auth|blocked_access|conflict|failed"},"evidence_refs":{"<field-or-row:field>":["evidence_id"]},"conflicts":[]}}}
```

- Envelope conflict: legacy top-level categories + category-level status vs newer `categories` container + field/row-field terminal status.
- Both envelopes: category data=`rows[]`; singleton=0/1-element array; collections=0..n.
- Newer patch record [IP]: `{"op":"upsert_row","match":{K…},"values":{non-key…},"source_refs":[…]}`; extractor output=`{category,ops[],cross_category_ops?,notes?}`.
- Evidence line [IP]: `{id,url,timestamp,method:dom|xhr|download|aria|screenshot,locator?,excerpt?,content_hash}` JSONL.

## 4. Type-system facts

### `text`/string: 57 declarations

- Identity/labels: `casino`,`casino_name`,`game`,`program_name`,`manager_name`.
- Operator input/credentials: `login`,`password`,`priority`,`promo_code_url`. No sensitivity/redaction metadata.
- URL semantics encoded only by names: `promo_code_url`,`official_site_url`,`casino_license_link`,`ios_app_link`,`android_app_link`; no URI format/protocol constraint.
- Contact semantics encoded only by names: `email`,`phone`; no email/E.164 format constraint.
- Currency semantics: 6 currency columns (`min/max` bet/deposit/withdrawal + duplicated sides); free string; no ISO-4217/crypto enum/case rule.
- Quantitative values typed text: `cashback_rate_max`,`rollover`,`reward_wagering_multiplier`,`deposit_turnover_multiplier`; strings may combine `%`,`x`,ranges,qualifiers.
- Narrative composites: conditions/descriptions/notes/bonus/package/refund fields; no grammar, unit, locale, length, clause order, or normalization metadata in R5.

### `number`: 17 declarations

- Amount-capable: min/max bet/deposit/withdrawal; JSON number permits integer/fraction/exponent; no precision/scale/nonnegative bound.
- Conceptual integers but declared generic number: `year_of_foundation`,`number_of_games`,`free_spins_max`,`free_spins_amount`,`tier_count`,`points_expiry_months`,`max_pending_withdrawals`; no integer/min/max constraints.
- No currency embedded in numeric amount; separate currency string columns.
- No unit metadata; number meaning depends on field name.

### `enum`: 32 declarations

- Every enum member is a JSON string. Boolean-like enums use strings `"TRUE"|"FALSE"`, not JSON booleans `true|false`.
- `country` repeated 12×; exact set=`Austria|Brazil|Chile|Norway`.
- `payment_method` repeated in deposits/withdrawals; both exact same ordered 159-string list; 159 unique raw strings/file.
- Small enums:
  - `casino_license_name`=Anjouan|Curaçao|Kahnawake|MGA
  - `live_casino_bonus_type`=cashback|excluded_from_wagering|none|other|tournament|welcome_bonus_applies
  - `status`=active|suspended|on_hold
  - `cashback_type`=casino_general|crypto|live_casino|other|sports|vip_loyalty
  - `free_spins_type`=app_install|birthday|no_deposit|other|push_notification|referral|reload_deposit|telegram|tournament_lottery|vip_loyalty|welcome_first_deposit|wheel_of_fortune
  - `vip_entry_type`=account_status_based|activity_based|automatic|automatic_first_deposit|invite_only|unspecified
  - `max_withdrawal_period`=monthly|weekly|daily|per_transaction|unspecified
- Enum exactness is raw JSON-string equality; case, spaces, punctuation, accents differ unless an external normalizer changes them. [JS]
- R5 has no enum fallback (`other` exists only in selected taxonomies), no unknown/unmapped value, no deprecation/alias/canonical-ID metadata.

## 5. Null/blank/required-state facts

- R5 does not declare any column required.
- R5 does not include `null` in its type vocabulary or enum values.
- Historical workbook/research spec: blank=`not verified/not applicable`; unknown boolean remains blank; `FALSE` requires explicit absence/prohibition. [SPEC]
- Newer runtime contract stores completion separately via terminal status; row values may remain absent/null while status is terminal. [IP]
- Three distinct states exist in project semantics but not R5: value; verified non-applicability/absence; unresolved/blocked/not-found.
- JSON omission, explicit `null`, empty string, `0`, and `FALSE` string are structurally distinct; R5 defines no equivalence.

## 6. Cross-field dependency facts; not encoded in R5

|trigger/value|dependent field(s)|
|---|---|
|min/max_*_amount|matching `*_currency`|
|`bet_builder=TRUE`|`bet_builder_description`|
|`has_withdrawal_commission=TRUE`|`withdrawal_commission_details`|
|`app_availability=TRUE`|`ios_app_link` and/or `android_app_link`|
|`number_of_games` populated|`number_of_games_is_approximate`|
|`rollover` populated|`rollover_description`|
|`loyalty_program_exists=TRUE`|`tier_count`,`reward_wagering_multiplier`,`points_expiry_months`,`notes`|
|payment method row|method-specific limits/conditions vs global conditions|
|`country`|geo-specific values in every category|

- No conditional schemas, mutual exclusion, implication, co-presence, cross-row, cross-category, or referential constraints in R5.

## 7. Cross-category duplication/roll-up facts

- `casinos.game`,`casinos.number_of_games`,`casinos.number_of_games_is_approximate` duplicate `casino_games.*`.
- `casinos.loyalty_program_exists` duplicates `loyalty_programs.loyalty_program_exists`.
- `casinos.free_spins_max` duplicates `free_spins.free_spins_max`.
- Historical project analysis classifies these master fields as roll-ups/derived from child categories; R5 does not mark derivation/source-of-truth. [ARCH]
- `country` duplicated in all rows; `casino_name` duplicated in 11 child categories; master uses field name `casino`, not `casino_name`.
- `payment_method` vocabulary duplicated verbatim in 2 files; `vip_casino_programs` and `vip_betting_programs` shapes are identical except category.
- `notes` occurs in 5 categories; no shared note schema.

## 8. Naming/semantic precision facts

- `cashback_rate_max:t`: name implies scalar max rate; type permits arbitrary text.
- `rollover:t`,`reward_wagering_multiplier:t`,`deposit_turnover_multiplier:t`: same multiplier concept split across 3 names/contexts; all text.
- `welcome_package`,`welcome_bonus_casino`,`first_deposit_welcome_bonus_casino`,`second_deposit_welcome_bonus_casino`,`reload_bonus`: offer summaries encoded as independent text columns; no structured percentage/cap/currency/free-spin/wagering fields.
- `welcome_bonus_betting`,`welcome_pack_betting`: overlapping labels; no formal distinction.
- `free_spins_amount` vs `free_spins_max`: current amount vs maximum implied by names only.
- `refund:t` has no taxonomy/rate/period fields.
- `casino_license_name:e4` excludes license values outside Anjouan/Curaçao/Kahnawake/MGA; no `other|unknown|multiple`; one row cannot represent multiple licenses.
- `live_casino_bonus_type:e6` supports one type only; simultaneous types require loss, prioritization, or non-schema text elsewhere.
- `app_availability:e{TRUE|FALSE}` is aggregate; platform-specific availability cannot be independently false/true except link presence.
- `max_withdrawal_period` enum labels period unit, while amount is `max_withdrawal_amount`; model cannot encode different daily+weekly+monthly limits for same method in one row.
- `min/max` fields encode one bound/currency pair; method-specific tiered/ranged/account-level limits require text conditions or multiple conflicting same-key rows.

## 9. Payment enum lexical facts

- 159 raw values; deposits list == withdrawals list byte-for-byte/order.
- Strict case/diacritic/punctuation normalization collisions:
  - `Banco Estado` / `BancoEstado`
  - `Banco Santander Santiago` / `Banco Santander-Santiago`
  - `Tenpo Prepago S.A.` / `Tenpo Prepago SA`
- Explicit synonym/representation families present as separate enum members:
  - `BTC`/`Bitcoin`; `ETH`/`Ethereum`; `LTC`/`Litecoin`; `TON`/`Toncoin`; `ADA`/`Cardano`
  - `BBVA`/`BBVA Chile`; `Banco Bci`/`Bci`; `Banco Consorcio`/`Consorcio`; `Banco Coopeuch`/`Coopeuch`; `Banco Itau`/`Banco Itaú Chile`/`Itaú`; `Scotiabank`/`Scotiabank Chile`
  - `WebPay Plus`/`Webpay`; `Binance`/`BinancePay`; `P46`/`Pago 46`; `BCI (Mach)`/`Mach`
  - generic/aggregate members coexist with specific rails: `Card`,`Crypto`,`Bank Transfer`,`Open banking`,`Voucher`,`Giftcard`.
- Some values combine multiple methods/entities in one enum member: `Banco Santander Santiago/Banco Santander/Banefe`; `Banco de Crédito e Inversiones/Tbank`; `Bank Transfer: Banco Chile/Banco A. Edwards/Credichile/Citibank`; `ltc bch`.
- Country-specific banks and global crypto/wallet/card methods share one flat enum; no provider ID, country applicability, rail class, asset/network decomposition.
- Crypto network variants are separate strings for selected assets (`USDT BEP20|ERC20|Solana|TRC20`,`USDC|USDC Solana`) but not modeled as `{asset,network}`.

## 10. Uniqueness/referential facts

- No row ID/UUID.
- No declared PK/FK. Historical FK relation: child `casino_name+country` → master `casino+country`. [IP]
- Casino name is mutable display text; no canonical operator/brand/domain ID.
- `official_site_url` is not part of historical master key.
- Collection keys use mutable labels/enums (`payment_method`,`game`,`free_spins_type`,`cashback_type`,`email`).
- No source/effective date in row schema; changing offers overwrite/conflict with same logical key unless run/evidence layer preserves history.
- No locale/language/source URL/capture timestamp per row in R5.

## 11. Playwright MCP/Claude Skills format facts

- Current Playwright MCP: page interaction uses structured accessibility snapshots; `browser_snapshot` can return snapshot or save it to a Markdown file; optional target/depth/boxes. Official README does not label the page snapshot format YAML. [PWMCP]
- `browser_find` searches current accessibility snapshot and returns matching nodes + nearby context/path; official docs describe it as cheaper than capturing whole snapshot. [PWMCP]
- MCP `browser_evaluate`, network-list/detail, console, snapshot support file output; returned page evidence and rubric schema are separate data structures. [PWMCP]
- Claude Skill: required `SKILL.md`; YAML frontmatter + Markdown instructions. Playwright snapshot content and Skill YAML frontmatter are different inputs/formats. [CCSKILL]
- Skill body remains in context after load; every body line is recurring context cost. [CCSKILL]
- Skill frontmatter can declare `name`,`description`,`when_to_use`,`allowed-tools`,`paths`, invocation controls; none changes R5 row schema. [CCSKILL]

## 12. Contract drift/ambiguity facts

- Current R5=12 categories; historical project hook/doc references include 13-category expectations. [HIST]
- R5 category list has no `legal`; legal is documented as evidence surface feeding existing categories, not output category. [ARCH]
- Historical sample output uses stale/illustrative names (`license_name`,`min_deposit`) differing from R5 (`casino_license_name`,`min_deposit_amount`). [ADR44]
- R5 operator metadata only appears in `casinos`; operator-provided `country` is repeated in every child rubric without child-level `operator_fields`.
- Historical spec says site values must land in exact rubric/dropdown values; earlier ADR says agent writes raw observed enum values and writer highlights mismatches; later plan rejects out-of-enum patch values. These are incompatible validation points. [SPEC][ADR44][IP]
- R5 defines schema-only data columns; historical/newer runtime files add statuses/evidence/conflicts/logical keys externally; therefore rubric validity != complete run validity.

## 13. Compact machine contract extracted from R5

```text
Rubric := {category:str,columns:Column[],operator_fields?:str[]}
Column := {name:str,type:"text"} | {name:str,type:"number"} | {name:str,type:"enum",values:str[]}
Row(category) := object whose recognized keys=category.columns[].name; value domain by column.type; nullability/requiredness unspecified
CategoryData := rows:Row[]  # external project contract, not R5
Singleton categories := casinos,betting,casino_bonuses,vip_casino_programs,vip_betting_programs,loyalty_programs
Collection categories := communication_managers,deposits,withdrawals,free_spins,cashback_offers,casino_games
```

## Sources

- `[R5]` `/mnt/data/rubrics(5).zip` extracted `rubrics/*.json`
- `[IP]` prior project file `implementation-plan.md` (runtime schema, logical keys, envelope, statuses, evidence/patch contracts)
- `[ADR44]` prior project file `0044-research-capture-scope-and-output.md` (legacy envelope/uniform rows)
- `[SPEC]` prior project file `casino-website-data-research-spec(1).md` (cell/blank/boolean/game-scope semantics)
- `[ARCH]` prior project file `research_capture_guide_map_architecture_proposal.md` (cardinality/roll-up/legal-surface facts)
- `[HIST]` prior project file `research_capture_conversation_facts.md` (13-category hook expectation)
- `[RFC8259]` https://datatracker.ietf.org/doc/html/rfc8259
- `[JS]` https://json-schema.org/draft/2020-12/json-schema-validation ; https://json-schema.org/understanding-json-schema/reference/object ; https://json-schema.org/understanding-json-schema/reference/enum
- `[PWMCP]` https://github.com/microsoft/playwright-mcp/blob/main/README.md
- `[CCSKILL]` https://code.claude.com/docs/en/skills

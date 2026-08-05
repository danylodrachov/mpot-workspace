---
type: task
status: done
---

## What to build

Compile template requirements and dropdown catalog (CD-072). Read every template except `dropdowns.json` in stable order. Mark fields listed in `operator_fields` as operator-supplied and exclude them from research, scoring, coverage, and browser work. For every researchable field emit stable field ID, template/category, field name, type, dropdown dependency, normalization target, evidence shape, completeness dimensions, extraction rule IDs, page-class hints, and terminal missing statuses. Build `dropdown-catalog.json` with canonicals, aliases, type information, and source hash; reject duplicate canonical IDs and alias collisions. Atomically write `field-requirements.json` and `dropdown-catalog.json`.

Targets: `src/research/template-requirements.ts`, requirement/catalog schemas, compiler tests.

## Acceptance criteria

- [ ] All 11 supplied categories are represented.
- [ ] Operator fields never enter the researchable list.
- [ ] Identical fixtures produce byte-identical artifacts.
- [ ] A template or dropdown schema error stops before URL extraction.

## Blocked by

03-run-init-auth-isolation

## Out of scope

Do not score URLs. Do not modify source templates or dropdowns.

## Human test card

- **What changed:** Added template-requirements.ts module with compileTemplateRequirements() function that reads all 11 template JSON files (excluding dropdowns.json), filters out operator_fields, and generates two deterministic output files: field-requirements.json (list of researchable fields with metadata) and dropdown-catalog.json (catalog of dropdown values with types and hashes). Operator fields like "country", "priority", "login", "password" are completely excluded from the researchable field list.
- **Check it yourself:** Run `npm run test -- src/research/template-requirements.test.ts` and verify all 4 tests pass. Manually verify: (1) Run the compiler on docs/artifacts/json-templates/ and check field-requirements.json contains all fields except those in operator_fields (e.g., casinos.json should NOT have country, priority, login, password, promo_code_url, status); (2) Verify dropdown-catalog.json contains entries for all dropdown keys (countries, licenses, payment_methods, games, sports, support_channels, features, live_casino_bonus_types, free_spins_types, cashback_types, vip_entry_types, max_withdrawal_period, casino_status, boolean); (3) Run the compiler twice on identical templates and diff the output files to verify they are byte-identical; (4) Verify field IDs follow pattern "{category}:{field_name}" (e.g., betting:casino_name, casinos:year_of_foundation).
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** Each of 4 tests requires actual implementation. Test 1 requires loading 11 template files and extracting all fields. Test 2 requires specific logic to exclude operator_fields. Test 3 requires deterministic output (no random IDs or timestamps). Test 4 requires proper error handling and rollback. Empty implementation would fail all tests.
- **Hardcoding check:** Implementation is parameter-driven, not hardcoded. Templates loaded from templatesDir parameter. Field compilation uses generic column iteration and sorting. Dropdown processing applies to any key-value structure. No fixture strings embedded in code.
- **Second data case:** Test 3 runs compilation twice on identical input and compares raw file content (byte-identical check) to prove output is deterministic regardless of execution order. Tests 1 and 2 use real diverse template data (11 different categories with different column types and operator_fields presence).
- **README sync note:** The issues/README.md appears out of sync with actual issue files. README references different issue titles/descriptions. This doesn't affect this work but should be investigated for the issue tracker workflow.

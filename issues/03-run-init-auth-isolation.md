---
type: task
status: done
---

## What to build

Implement immutable run initialisation and authentication isolation (CD-070). Validate `casino_url`, `geo`, template/dropdown paths, and policy versions. Derive casino ID, locale, canonical origin, and approved same-domain scope. Generate `run_id`; hash templates, dropdowns, URL rules, extraction rules, module versions, scorer prompt/model, and visit/probe policy. Write immutable `run-context.json` before extraction or browser launch. Create a fresh anonymous browser context and reject storage-state/cookie/session reuse. Emit `run_started` with `authentication_disabled`.

Targets: `src/research/discovery-orchestrator.ts`, `run-context` schema, focused tests.

## Acceptance criteria

- [ ] Missing input fails before another artifact exists.
- [ ] Existing run context cannot be overwritten.
- [ ] A storage-state option is rejected.
- [ ] Hashes change when their fixture changes.
- [ ] No credential field is read.

## Blocked by

01-shared-pipeline-contracts, 02-run-storage-atomic-writers

## Out of scope

Do not run Stage 2. Do not open an authenticated context.

## Human test card

- **What changed:** Added `src/research/discovery-orchestrator.ts` with `initializeRun()` function and `RunContext` schema. Validates all inputs before any artifact creation. Derives casino_id, locale, canonical_origin, and approved_same_domain_scope from casino_url. Generates run_id or uses provided one. Computes SHA256 hashes of template, extraction rules, URL rules, and policy fixtures. Writes immutable run-context.json with all metadata. Rejects storage_state_path for anonymous-first operation. Emits run_started event with authentication_disabled indicator. All operations are atomic—on any validation failure, zero artifacts are created.
- **Check it yourself:** Create a temp directory with fixture files (template.json, extraction.json, rules.json). Run `npm run test:research -- src/research/discovery-orchestrator.test.ts` and verify all 5 tests pass. Run `npm run typecheck` and verify no TypeScript errors. Manually test by: (1) call initializeRun with empty casino_url—verify it throws before creating baseDir; (2) initialize once successfully, then try again with same run_id—verify error on overwrite; (3) try with storage_state_path—verify it's rejected; (4) modify fixture file content and initialize again—verify hash changed; (5) verify run-context.json contains no credential strings from fixtures.
- **Your check:** ⏳ not tested yet

## Critic notes

- **Hollow test check:** Tests do not pass against empty implementation. Input validation must run before any artifact is created. Immutability check must prevent overwrites. storage_state_path must be explicitly rejected. Hashes must be computed from file content. All five tests require the actual implementation to pass.
- **Hardcoding check:** Implementation is spec-driven, not test-driven. casino_url "https://example-casino.com" is just one example—deriveCasinoId works with any valid URL. geo "US" is just one example—deriveLocale works with any geo. Fixture content is hashed as-is without extracting individual fields—changing content changes hash. run_id is generated dynamically (crypto.randomUUID) or provided, not hardcoded. Function returns computed casino_id, geo, run_id, run_dir from inputs, not literals.
- **Second data case:** Tests cover: (1) multiple casino URLs (with .com, hyphenated, different domains); (2) fixture modification between runs (version1 → version2); (3) different fixture structures and content; (4) fixtures with embedded secret/credential strings (prove they're hashed, not extracted); (5) repeated attempts to overwrite same run_id. All tests pass with completely different data, proving the code isn't hardcoded to test fixtures.

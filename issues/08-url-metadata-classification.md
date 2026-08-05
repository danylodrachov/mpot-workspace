---
type: task
status: needs-criteria
---

> NEEDS CRITERIA: Acceptance criteria are not observable without specification of:
> - Input format: what does cleaned URL metadata look like (sample JSON)?
> - Output format: what should clean-url-inventory.json structure contain (schema)?
> - Examples of "mandatory fixtures" and expected flagging behavior
> - Specific output fields and their derivation rules (route tokens, page class, etc.)
> - Input source: which file/artifact provides cleaned URL metadata?
> - How to distinguish "unclassified" URLs from "classified" ones
>
> Non-dev cannot watch behavior without these definitions.

## What to build

Replace template classifications with URL metadata classification (CD-075). From cleaned URL metadata only, derive route tokens, slug label, likely page class, mandatory flag, product-category-landing flag, source confidence, origin status, and redirect status. Mandatory classes are cashier, deposit, withdrawal, bonuses, and terms and conditions. Leave unknown URLs in the inventory without forcing a class. Remove the new pipeline's dependency on the old 11-category `classifications[]`.

Targets: `src/research/url-metadata-classifier.ts`, clean-inventory schema, classifier tests.

## Acceptance criteria

- [ ] No browser/network dependency exists.
- [ ] Mandatory fixtures are flagged.
- [ ] Unknown fixtures remain present and unclassified.
- [ ] Output is deterministic and updates only `clean-url-inventory.json`.

## Blocked by

05-template-requirements-compiler, 07-url-cleaning-decision-log

## Out of scope

Do not score URL relevance. Do not read page content. Do not remove legacy code yet.

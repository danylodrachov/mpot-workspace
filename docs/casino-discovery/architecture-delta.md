# Architecture delta

## Removed from runtime control

- LLM URL × field scoring.
- Relevance matrix validation.
- Ranked/mandatory visit planning.
- LLM or deterministic decisions to stop visiting because fields appear satisfied.
- Active behavior probing.
- Deterministic field extraction/normalization before review.
- Gap diagnosis and ranked re-probes.

## New control flow

```text
manual authenticated Chrome
  -> deterministic URL discovery
  -> deterministic URL Rules
      -> rejected: report only
      -> tbd: report only, do not visit
      -> accepted: enqueue
  -> visit every accepted URL
  -> save rendered HTML
  -> save passive interaction trace
  -> repeat discovery/filter until accepted queue is empty
  -> write review-input.json
  -> LLM reviewer builds JSON-template-section review
```

## Review semantics

The old review's category structure remains useful, but `role`, `confidence`, relevance probability and suggested visit priority are no longer browser-control data.

A review row now answers:

- Which URL was actually visited?
- Which JSON-template fields can reasonably be researched from the saved page?
- Which saved HTML/trace file supports that mapping?
- What passive interactive candidates were observed on that page?

A page may be listed under several template categories. `not_found` means the saved visited evidence did not support a mapping; it does not prove feature absence.

---
type: task
status: ready
---

## What to build

Implement deterministic page-interactivity profiling (CD-078). Profile each selected page before collection, mandatory pages first. Execute the detector order:
1. ARIA/accessibility snapshot;
2. DOM semantic/visibility scan;
3. actionability and trial action;
4. before/after state delta;
5. MutationObserver;
6. request/response-metadata delta;
7. frame scan;
8. controlled scroll/lazy-load scan.

Record modal/full-page flow, tabs, accordions, dropdowns, custom controls, JS-loaded sections, pagination, load-more, infinite scroll, frames, dialogs, gates, blocked states, and unresolved targets. Write structured `page-behavior.json`.

Targets: `src/research/page-interactivity-profiler.ts`, `page-behavior` schema, Playwright fixture tests.

## Acceptance criteria

- [ ] Product/field collection cannot run before a page profile exists.
- [ ] Each detector record has stable detector ID and bounded pre/post evidence.
- [ ] No screenshot or trace is required for routine success.
- [ ] No raw body field exists in the schema.
- [ ] A login gate is recorded as blocked; no login is attempted.

## Blocked by

10-relevance-validation-visit-plan

## Out of scope

Do not collect final field values. Do not use broad CDP capture.

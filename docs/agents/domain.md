# Domain Docs

Single-context repo. How skills consume (and write) this repo's domain documentation.

## Layout — matches the skills' default

| Skills' default | Here                                              |
| --------------- | ------------------------------------------------- |
| `CONTEXT.md`    | `CONTEXT.md` (repo root) — glossary ONLY          |
| `docs/adr/`     | `docs/adr/` — numbered `00NN-<slug>.md`           |

Never create `design_docs/` or `design_docs/adr/` — a stray copy there is exactly
the split-brain this file exists to prevent.

## Reading order

1. `docs/adr/adr-digest.md` — compressed entry point for ALL ADRs. Read it
   first; open a full ADR only when its section is insufficient.
2. `docs/adr/README-codebase.md` — the single code map. One read replaces
   exploratory sweeps of `src/`.
3. `CONTEXT.md` — domain glossary. Use its terms in every output (issue titles, PRDs,
   hypotheses); never use words listed under `_Avoid_`.

## Writing rules

- Any ADR write or edit MUST update its `adr-digest.md` section **in the same commit**.
- New decisions that contradict an existing ADR: fold the still-live parts into the
  surviving ADR and delete the stale ADR file. ADRs are current-only — supersession
  markers are blocked by `.claude/hooks/adr-guard.sh` (ADR 0018). Never leave both
  versions alive.
- Only `/grill-with-docs` writes ADRs and CONTEXT.md. Other skills flag conflicts
  explicitly ("Contradicts ADR-0037 because…") instead of silently overriding.

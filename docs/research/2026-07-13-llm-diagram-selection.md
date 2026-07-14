# LLM Diagram Selection Instructions

## Verified facts

- Diagram-as-code stores diagrams as text; suitable for Git diffs, model generation, automated updates, Markdown linking.
- VS Code 1.121+ renders Mermaid blocks directly in Markdown preview and notebooks.
- Mermaid supports flowcharts, block/architecture, sequence, state, entity-relationship, class, journey, timeline, Gantt and other diagram types.
- D2 is text-based, supports nested containers, labelled connections and automatic layout; official VS Code extension exists.
- PlantUML supports sequence, use-case, class, object, activity, component, deployment, state and other UML diagrams.
- Structurizr DSL defines a text-based C4 architecture model; one model can produce system-context, container, component, dynamic and deployment views.
- C4 static views: system context, container, component, code. System-context + container views are sufficient for most high-level reviews.
- Draw.io VS Code integration edits `.drawio`, `.drawio.svg`, `.drawio.png`; `.drawio.svg` remains editable and renderable as SVG.
- Excalidraw VS Code integrations edit `.excalidraw`, `.excalidraw.svg`, `.excalidraw.png`; format is suited to informal/manual sketches.
- Graphviz DOT is text-based and suited to automatically laid-out dependency/relationship graphs.

## Objective

Generate the minimum diagram set required for a non-engineer to verify:

- system purpose/scope
- users/external systems
- major parts/responsibilities
- information/control flow
- persistence/source of truth
- lifecycle/failure/retry behavior
- infrastructure/external dependencies
- unresolved architecture decisions

Do not force one fixed diagram pack. Select diagram types from project context, ADR scope, decision risk and reviewer questions.

## Diagram-type selection

### System context

Select when reviewer needs big picture, scope, users, external systems, integrations, ownership boundary.

Show:

- system as one box
- human roles
- external systems
- labelled relationships
- explicit in-scope/out-of-scope boundary

Preferred format:

1. Mermaid flowchart/block diagram for Markdown-native output
2. D2 for cleaner grouped standalone overview
3. Structurizr DSL when maintaining a persistent C4 model

### Container/system overview

Select when reviewer needs major applications/services/workers/data stores, responsibilities, selected technologies, communication paths.

Show:

- deployable/runnable units, not classes/files
- responsibility per unit
- technology only where decision-relevant
- protocols/events/data on arrows
- data stores and external dependencies

Preferred format:

1. D2 for clear boxes/groups/arrows
2. Mermaid architecture/block/flowchart for Markdown-native output
3. Structurizr DSL for multi-view architecture consistency
4. PlantUML component diagram when formal UML notation is required

### Sequence diagram

Select when order/time matters: request handling, agent delegation, browser session, authentication, payment, retry, handoff, event processing.

Show:

- actors/participants
- ordered calls/events
- returned data
- branches/loops only when material
- failure/timeout/retry points

Preferred format:

1. Mermaid sequence diagram for normal complexity
2. PlantUML sequence diagram for dense interactions, grouping, detailed alternatives
3. Structurizr dynamic view when interactions must use the same C4 model

Split by scenario. Never combine unrelated workflows.

### Process flowchart

Select when reviewer needs steps, decisions, branches, approval gates or operational workflow; timing between technical participants is not the primary question.

Preferred format:

1. Mermaid flowchart
2. D2 when grouping by team/system/stage materially improves readability

Use swimlanes/subgraphs when responsibility ownership matters.

### State diagram

Select when an entity/job/session/document has statuses, transitions, retries, pauses, cancellation, completion or recovery.

Show:

- valid states
- transition triggers
- terminal states
- retry/recovery routes
- invalid/impossible transitions when decision-relevant

Preferred format:

1. Mermaid state diagram
2. PlantUML state diagram for complex nested/concurrent states

### Data lifecycle/data-flow diagram

Select when the system collects, transforms, validates, stores, syncs, exports or deletes data.

Show:

- sources
- temporary representations
- transformations
- validators
- persistent stores
- source of truth
- outputs
- retention/deletion where relevant
- trust/privacy boundaries where relevant

Preferred format:

1. Mermaid flowchart/block diagram
2. D2 for grouped pipelines and storage boundaries
3. PlantUML component/deployment diagram when data flow depends on runtime topology

Do not use ERD as a substitute for data flow.

### Entity-relationship diagram

Select when reviewer needs stored business objects, ownership/cardinality and core database relationships.

Show only decision-relevant entities/fields. Omit implementation-only columns unless the ADR concerns schema design.

Preferred format:

1. Mermaid ER diagram
2. PlantUML class/entity notation for more detailed models
3. Graphviz DOT for generated relationship graphs too large for manual layout

### Deployment diagram

Select when reviewer needs runtime location, local/cloud split, network/service boundaries, processes, databases, queues, credentials, persistence, scaling, operational cost or security exposure.

Preferred format:

1. PlantUML deployment diagram
2. Structurizr deployment view
3. D2 for a simplified non-UML runtime map

### Decision map

Select when an ADR compares alternatives or technology choice depends on conditions.

Show:

- decision question
- material constraints
- branches
- selected path
- rejected paths
- unresolved assumptions

Preferred format: Mermaid flowchart.

Do not replace ADR evidence/consequences with a decision map; use it as the visual index.

### Component diagram

Select only when one container/service remains too complex at container level and internal modules/interfaces materially affect the decision.

Preferred format:

1. PlantUML component diagram
2. Mermaid block/flowchart
3. Structurizr component view

Do not generate by default for non-engineer review.

### Class/object diagram

Select only when the ADR concerns domain modelling, inheritance, object ownership, public interfaces or schema-to-code mapping.

Preferred format: PlantUML or Mermaid class diagram.

Do not generate for general architecture review.

### Dependency graph

Select when reviewer needs package/module/service dependencies, cycles, blast radius or ownership coupling.

Preferred format:

1. Graphviz DOT for large/generated graphs
2. Mermaid flowchart for small manually curated graphs
3. D2 when grouping/boundaries are important

### Manual-editable visual

Select `.drawio.svg` when the human must drag, annotate or rearrange boxes in VS Code.

Use only after structure stabilizes. Do not use Draw.io XML as primary model-maintained architecture source unless explicitly required.

### Informal concept sketch

Select Excalidraw when ambiguity/brainstorming is intentional and visual discussion matters more than canonical architecture accuracy.

Do not treat Excalidraw JSON as authoritative architecture documentation unless explicitly required.

## Format selection rules

1. Default to Mermaid embedded in `.md` when the diagram is small, documentation-adjacent and supported by Mermaid.
2. Select D2 for the primary standalone box-and-arrow architecture map when grouping/layout/readability exceed Mermaid quality.
3. Select PlantUML for formal UML, detailed sequence/state/component/deployment/class diagrams.
4. Select Structurizr DSL when one maintained architecture model must generate multiple consistent C4/dynamic/deployment views.
5. Select Graphviz DOT for large automatically generated dependency/relationship graphs.
6. Select `.drawio.svg` only when manual visual editing is a requirement.
7. Select Excalidraw only for sketches/brainstorming.
8. Prefer one authoritative source format per diagram; exported SVG/PNG files are derived artifacts.
9. Do not duplicate the same diagram in multiple source formats unless conversion is explicitly requested.
10. State required VS Code extension/tooling beside every non-Mermaid source file.

## Mandatory context analysis before generation

Determine:

- reviewer question
- current vs proposed system
- ADR decision scope
- important actors
- system boundary
- major runtime units
- data sources/stores/outputs
- synchronous vs asynchronous interactions
- entity/job lifecycle
- infrastructure/security/cost implications
- unknowns/assumptions

Generate only diagrams whose selection condition is met.

## Minimum visual review gate

For a new system concept, normally require:

1. System context
2. Container/system overview
3. Sequence diagram for each critical end-to-end scenario

Conditionally add:

- data lifecycle when data is collected/transformed/stored
- state diagram when jobs/sessions/entities have lifecycle/retry behavior
- deployment diagram when runtime/security/cost/local-vs-cloud decisions matter
- ERD when persistent entity relationships are architecture-relevant
- decision map when alternatives/constraints are difficult to understand from prose
- component diagram only when container internals materially affect the ADR

Do not begin implementation planning while required diagrams contain contradictions, unlabeled critical paths or unresolved boundaries.

## Diagram construction rules

- One primary reviewer question per diagram.
- One abstraction level per diagram.
- Maximum 10 primary boxes; split larger diagrams.
- Maximum 20 visible relationships unless graph completeness is the explicit objective.
- Use short names plus responsibility descriptions.
- Label every non-obvious arrow with action, event, protocol or data.
- Use consistent direction: left-to-right for structure/data flow; top-to-bottom for decisions/lifecycle unless context requires otherwise.
- Mark human actors distinctly.
- Mark external systems distinctly.
- Mark persistent stores distinctly.
- Mark system/trust/network/ownership boundaries.
- Show source of truth.
- Show asynchronous boundaries, queues and events.
- Show approval/manual intervention points.
- Show material failure, retry, timeout and fallback paths.
- Distinguish `CURRENT`, `PROPOSED`, `DEPRECATED`, `UNKNOWN`.
- Never present proposed components as implemented.
- Include legend only when notation is not self-evident.
- Avoid decorative icons, colours and styling that encode no meaning.
- Avoid crossing arrows; change layout or split diagram.
- Avoid implementation-level classes/functions/files unless diagram selection explicitly requires them.
- Keep technology labels secondary to responsibility.
- Keep prose outside diagram minimal: purpose, scope, assumptions, unresolved decisions.

## ADR integration rules

For each ADR:

1. Identify reviewer questions introduced by the decision.
2. Select fitting diagram type(s) using rules above.
3. Create/update affected diagrams before implementation instructions.
4. Link ADR to diagram source files.
5. Mark selected/rejected/proposed/current elements accurately.
6. Record unresolved assumptions adjacent to the diagram.
7. Update diagrams when ADR status/decision changes.
8. Fail review when ADR prose and diagrams conflict.
9. Do not generate diagrams unrelated to the ADR decision.
10. Do not require reviewer to read implementation documents to understand system-level consequences.

## Output structure

Use only selected files:

```text
docs/architecture/
  00-system-context.md
  01-system-overview.d2
  02-sequence-<scenario>.md
  03-data-lifecycle.md
  04-state-<entity>.md
  05-deployment.puml
  06-data-model.md
  07-decision-map.md
  model.dsl
```

Rules:

- Mermaid: embed fenced `mermaid` blocks in `.md`.
- D2: save standalone `.d2`; add adjacent `<same-name>.md` only when assumptions/unknowns require prose.
- PlantUML: save standalone `.puml`.
- Structurizr: save `.dsl`; avoid duplicating generated views as separately maintained sources.
- Draw.io: prefer `.drawio.svg`.
- Excalidraw: prefer `.excalidraw.svg` when renderable/editable artifact is required.
- Graphviz: save `.dot` or `.gv`.

## Per-diagram metadata

Place directly above/below each diagram:

```text
Purpose: <question answered>
Scope: CURRENT | PROPOSED | BOTH
Source: <ADRs/specs/code/data used>
Assumptions: <only material assumptions>
Unknowns: <unresolved items>
Last architecture change: YYYY-MM-DD
```

## Final validation

Before completion, verify:

- selected type matches reviewer question
- diagram renders in declared VS Code workflow
- no unsupported syntax
- no orphan boxes
- no unexplained arrows
- no mixed abstraction levels
- no hidden source-of-truth ambiguity
- no current/proposed ambiguity
- all critical scenarios represented
- all material failure/retry paths represented
- diagrams and ADRs agree
- diagram count is minimal

## Official references

- VS Code Mermaid preview: https://code.visualstudio.com/updates/v1_121
- Mermaid syntax: https://mermaid.js.org/intro/syntax-reference.html
- D2 VS Code extension: https://d2lang.com/tour/vscode/
- PlantUML supported diagrams: https://plantuml.com/
- Structurizr DSL: https://docs.structurizr.com/dsl
- C4 diagrams: https://c4model.com/diagrams
- Draw.io VS Code integration: https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio
- Excalidraw VS Code integration: https://marketplace.visualstudio.com/items?itemName=pomdtr.excalidraw-editor

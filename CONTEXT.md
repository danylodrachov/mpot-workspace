# MPOT Workspace

The domain language for the casino-affiliate marketing operation of the AFK agent that
automates the marketing assistant's recurring work, and the operational capabilities it runs.

The agent operates at two ends of a content pipeline whose middle (article authoring) is
owned by others: it produces **research** upstream and **QA-checks** published articles
downstream. It does not write articles.

## Language

**AFK Agent**:
The agent that automates the marketing assistant's operational SOPs, using tools to do the work
and running them AFK.
_Avoid_: bot, automation, the assistant

**SOP**:
A standardized operating procedure — a documented, repeatable sequence of steps the AFK
Agent executes the same way each time. The unit of work the agent automates.
_Avoid_: workflow, routine, process

**Fetch Assignee**:
The single ClickUp assignee the [[AFK Agent]] fetches and acts *for* — **Danylo Drachov**. The
gate on what enters the day's work: only this assignee's tasks are pulled. Distinct from the
per-lane status→owner set (Alina / creator / Oleksandr Dziuba / Danylo Drachov), which is
*move-reasoning* — who a card reassigns TO when it leaves a lane, not who the agent fetches for.
_Avoid_: owner, assignee list, the team, status owner

**Orchestrator** (abbrev. **ORC**):
The deterministic script that drives a single day's cycle end-to-end (the runtime spine of ADR
0034): it sequences the stages — build folder, fetch, clean, split, seed verdicts, the freshness /
pre-dispatch / boolean gates, the join-map write — and **chains** the reasoning subagents, spawning
them in order. It owns the workflow and its effects and does **no reasoning** itself; reasoning is
delegated to named subagents (classify-haiku, the [[Truthful Signal]] subagent, write). Not a Claude
brain and not a reasoning seat.
_Avoid_: brain, controller, coordinator, runner, main agent, reasoning seat

**Truthful Signal**:
The [[Reconciler]]'s reconciled read of what a task truly needs *now*, produced **per card** — by
joining the card's formed context with the matching inbound thread context(s) about the same
[[Media]], where a fresher inbound outweighs a stale board status. The [[Context-former]]s supply
those contexts; haiku only classifies; the [[Orchestrator]] only chains. Its paired output is the
**truthful next step** that feeds the [[Daily Plan]].
_Avoid_: true signal, real status, merged signal, the join

**Context-former**:
A sonnet subagent that reduces one source's clean blob to a compact truthful context for a single
item, written to that item's `.verdict.json`. One per source shape — **messaging** (a thread) and
**clickup** (a task) — each knowing only its own source. Both always run; feeds the [[Reconciler]].
_Avoid_: reader, parser, summarizer, the read pass

**Reconciler**:
The **per-card** sonnet subagent that joins the formed contexts — a card's verdict plus its
matching thread verdicts — into the [[Truthful Signal]] and the truthful next step, written to
`<task_id>.reconcile-verdict.json`. Works only on [[Context-former]] output, never on raw blobs.
_Avoid_: joiner, merger, the join, aggregator, truthful-signal subagent


**Daily Plan**:
The agent's working picture of a single day's work — the recurring tasks in play that day (those
touched recently; board cards carry no due date) with
triaged inbound replies folded in, so the day's landscape is complete. It lives one day and is
rebuilt fresh the next.
_Avoid_: to-do list, backlog, queue

**Handback**:
A [[Daily Plan]] task the [[Orchestrator]] tried to handle but couldn't confidently place, so it hands
the task back to the user instead of doing it, and flags it in the [[Execution Report]].
Distinct from a [[Bypass List]] task, which the agent never attempts and never reports.
_Avoid_: skipped task, failed task, unhandled

**Bypass Task List**:
A user-kept list of tasks that are explicitly not the agent's job — human-owned work only
(e.g. daily sync, agency communication). The agent silently skips anything on it. Distinct from
a [[Handback]], which the agent does attempt and does report.
_Avoid_: ignore list, blocklist, exclusion list, skip list

**Agent Solo Work**:
The curated set of tasks the [[AFK Agent]] runs end-to-end by itself — no human attending and
no counterparty waiting on the other end. The work qualifies because it is **comms-independent**
(needs no counterparty reply) and **unblocked**, on top of being AFK-eligible (ends at the user's
review). The user designates the set; the agent proposes within it, preferring work it has seen
run clean. Comms-dependent work (QA triggers, inbound triage, the [[OKB]]) stays reactive
instead.
_Avoid_: batch list, overnight list, night queue, solo work

**Affiliate Article**:
A piece of published casino-affiliate content. Writing is outside the agent's and the user's
scope; the agent only QA-checks it after publication.
_Avoid_: post, blog, content, page

**Media**:
The external publisher that hosts a placed article and is responsible for fixing issues
the agent reports.
_Avoid_: publisher, site, partner, vendor

**Article Type**:
The classification — **Guest Post (GP)** or **Affiliate** — that sets a published article's
link and indexing rules.
_Avoid_: post type, category

**QA Rules**:
The standing pass/fail ruleset for verifying a published article against what was approved.
Defines *how* to check; applies to every article.
_Avoid_: checklist, criteria, standards

**Reference Brief**:
The single approved version of an article — the complete copy: meta, headings, body, and
every link with its exact anchor. The published page must match it. The *what-to-expect* input
to a QA check, paired with the [[QA Rules]].
_Avoid_: brief, article brief, source document, the version we sent, approved copy

**Article QA Report**:
The agent's full internal record of a per-article QA check — the complete output.
_Avoid_: QA file, results, findings

**Fix File**:
The trimmed, outlet-facing version of a [[QA Report]] — only the items the [[Media Outlet]] must fix.
_Avoid_: fix list, correction doc

**Research Surface**:
A semantic UI target the [[AFK Agent]] must find, activate, verify, and capture evidence from
during a research capture run. Not a page or URL (a surface can be a modal, tab, widget, or
account state), not a category (category is the downstream output schema), and not an
extraction task. Each canonical surface has orthogonal properties: access requirement
(public / authenticated), allowed presentations (route / modal / tab / widget), and
cardinality (singleton / collection). A repeated item — e.g. one deposit method — is a
runtime instance of a collection surface, not a separate catalog entry.
_Avoid_: page, URL, capture target, category

**Surface Evidence**:
The bounded capture output for a single [[Research Surface]] — a scoped accessibility
snapshot, screenshot, or structured slice of what was visible when the surface was activated
and verified. One surface produces one evidence artifact; multiple surface evidences feed
into an [[Evidence Cluster]] for extraction.
_Avoid_: raw capture, HTML dump, full-page snapshot

**Evidence Cluster**:
A group of related [[Research Surface]]s that together cover one or more output categories.
Defines coverage, dependency, reconciliation, and completion boundaries — not extraction
scheduling. Extraction happens eagerly per surface; the cluster's role is to determine when
all relevant surfaces have a terminal status so category finalization can run. Cluster
finalization operates on already-structured results, never re-ingests raw [[Surface Evidence]].
_Avoid_: extraction batch, page group, ingestion unit

**Captured Evidence**:
The complete capture output for a single casino in a single market — all [[Surface Evidence]]
artifacts plus the extracted `research-data.json` with structured data per category (uniform
`rows[]`) and one screenshot per category as visual evidence. Produced by the capture skill
into `data/research/<partner>-<geo>/`. Values written raw as observed; validation against
canonical enums happens in the xlsx writer, not at capture time.
_Avoid_: raw data, the scrape, evidence dump, HTML dumps

**Research Data**:
The Research SOP's deliverable — structured findings about a single casino that SEO writers
draw on while writing articles. Extracted into `research-data.json`, not reasoned separately
over raw files.
_Avoid_: report, the scrape, findings dump, CSV

**OKB** (Outreach Kanban Board):
The ClickUp kanban board that tracks acquiring and paying a [[Media Outlet]] — the
deal-making and onboarding relationship only. An outlet's deal closes here before that
outlet's articles appear on the [[CKB]].
_Avoid_: Outreach kanban board, negotiation board, outreach board, Communications board, Comms board

**CKB** (Content Kanban Board):
The ClickUp kanban board that tracks a single article's placement and QA with an
already-onboarded [[Media Outlet]]. An article appears here only after its outlet's deal has
closed on the [[OKB]]. Lane names, per-lane agent actions, and transition logic are defined in
ADR 0038, not here.
_Avoid_: Content kanban board, article board, QA board, Content board

**SEO Qualifying Questions**:
The decision-critical questions an SEO specialist defined to judge whether a [[Media Outlet]]
is a go / no-go for guest posting. The gating subset of the fuller T&C record — a gap in any
of them blocks the go/no-go call; the rest are captured-if-stated and block nothing.
_Avoid_: the 7 questions, the inquiry list, completeness spec, required fields

**Defined Questions**:
The decision-critical **subset** of the [[SEO Qualifying Questions]] that a single inbound
reply is checked against to set the OKB status. A reply that leaves any Defined Question
uncovered keeps the deal in the [[OKB]]'s Negotiation lane (ADR 0037). Narrower than the full Qualifying-Question
record: it is the gating subset the reply.io-entry flow reasons over per reply.
_Avoid_: qualifying questions, the 7 questions, required answers

**Localization**:
The practice of sending outlet-facing messages in the outlet's own language while the user
reviews in English. The agent is trusted to translate; the outlet only ever sees its own
language.
_Avoid_: translation step, i18n, the spanish version

**Comm Templates**:
The user's reusable email templates and email style guides the agent draws on when drafting
outlet-facing messages. They cover only the repeatable, same-every-time cases — the warm,
engaged outbound sent after an outlet replies (e.g. the invoice request, the decline, holding
notes). Work that must be reasoned per-reply — such as chasing the [[Qualifying Questions]] —
is a [[Reasoned Draft]], not a template.
_Avoid_: email templates, boilerplate, snippets

**Outlet Message**:
The warm, polite version of the same message that actually goes to the [[Media Outlet]],
fitted to the outlet's market — its language and culturally-appropriate register. Carries the
same purpose as the [[Review Draft]] but with the courtesy and cultural wrapping the user
doesn't review.
_Avoid_: House Style, Geo Etiquette, the spanish version, the sent email

**Approval Gate**:
A checkpoint where the agent pauses an outward-facing or hard-to-reverse action and waits for
the user before anything goes out.
_Avoid_: review step, sign-off, manual check

**Status**:
The lane a card occupies on a ClickUp kanban board — its position in that board's pipeline. The
general sense lives here; the [[OKB]]'s lane names and the logic for moving a card between them
are defined in ADR 0037, not in CONTEXT.
_Avoid_: lane, stage, state, column

**Status Verdict**:
The status a task *should* be in — the [[Reconciler]]'s call, derived as part of the
[[Truthful Signal]], not the task's actual lane, which the [[Orchestrator]] moves separately by a
deterministic compare.
_Avoid_: status label, the move, proposed status, implied status

**Message Label**:
The routing tag on an inbound reply.io thread — `outreach` / `content` / `other` — naming which
kanban board the message concerns. Routing only, never a status. The read pass (`write_draft:false`)
picks SOP and writes the verdict; the write pass (`write_draft:true`) picks SOP and appends the
draft — classification and drafting are separate passes.
_Avoid_: board status, type, lane

**Execution Report**:
The summary the [[AFK Agent]] pushes to the user after an unattended run, reporting what it
actually did.
_Avoid_: Batch Report, morning digest, daily summary, overnight report

**Focus Group**:
A work-type bucket that batches the user's review into one type of work per sitting — the three
are Publications, Comms, and Research, ordered each day by ROI. Within a group, items sort by
output-state (needs-approval → done-FYI → handed-back → failed).
_Avoid_: work queue, category, swimlane, batch

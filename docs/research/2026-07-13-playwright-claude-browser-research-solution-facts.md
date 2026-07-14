# Playwright MCP + Claude Skills: token/coverage solution facts

## Failure surface

- Claude Code context = system instructions + conversation + CLAUDE.md/memory + read files + command/tool outputs + loaded skill bodies; growing context raises per-turn token processing; stale content may distract execution [S6,S8]
- Playwright MCP interaction tools return updated accessibility snapshots; repeated actions therefore append repeated page-state text [S2]
- MCP snapshot refs: unique only inside one snapshot; invalid after navigation/DOM change; new snapshot required for new refs [S2]
- Official Playwright estimate: accessibility snapshot ~200–400 tokens; screenshot ~3,000–5,000 vision tokens; real-page AxTree/HTML observations in research frequently reach thousands/tens of thousands tokens [S2,S20,S22]
- Claude Code warns at MCP output >10,000 tokens; default maximum 25,000 tokens; oversized unannotated text results are persisted to disk and replaced by file reference [S10]
- Auto-compaction summarizes history near context limits; early conversational instructions can be lost; persistent rules loaded from CLAUDE.md/system survive/reload differently from conversational state [S6,S8]
- Invoked skill content remains context-resident across turns; every skill-body line becomes recurring context cost; after compaction skill bodies are reinjected with 5,000-token/skill, 25,000-token-total caps; oldest excess skills dropped [S5,S6]
- Page omission = long-horizon progress/state failure: target-page set, visited set, pending set, completion conditions, exceptions/retries absent from deterministic external state; model memory alone remains probabilistic

## Browser transport / observation channels

### Playwright MCP

- Snapshot mode: accessibility tree; deterministic element refs; persistent browser session/cookies [S1,S2]
- `browser_find(text|regex)`: matching AxTree nodes + path + local context; explicitly documented as cheaper than full snapshot [S3]
- `browser_snapshot(target=...)`: subtree/element observation only [S3]
- `browser_snapshot(depth=N)`: tree-depth cap [S3]
- `browser_snapshot(filename=...)`: writes snapshot file instead of inline tool result [S3]
- `browser_evaluate(function, target?, filename?)`: page/element JS extraction; result inline or file [S4]
- `browser_network_requests(static=false, filter=regex, filename?)`: filtered request inventory; static assets excluded by default [S4]
- `browser_network_request(index, part?, filename?)`: single request; optional headers/body part; inline/file [S4]
- `browser_run_code_unsafe(code|filename)`: compound Playwright execution inside one tool call; arbitrary server-process JS/RCE-equivalent [S4]
- `browser_tabs`: explicit tab list/create/close/select [S4]
- screenshots: visual/layout evidence; not valid as ref source; materially higher token cost [S2,S3]
- optional capability groups (`network`,`storage`,`devtools`,`vision`,`pdf`,`testing`,`config`) add tools only when enabled [S4]

### Playwright CLI + Skills

- Microsoft states CLI+Skills is more token-efficient than MCP for coding agents: no large MCP tool schemas/verbose accessibility trees forced into model context; concise commands; page data file-backed [S11]
- CLI command result links to timestamped `.yml` snapshot file; snapshot body not automatically embedded [S11]
- CLI supports `snapshot --depth=N`, `snapshot <ref|selector>`, `find`, `eval`, `run-code`, network request inspection, named sessions, persistent profiles [S11]
- CLI browser state persists across commands in-session; named sessions isolate concurrent/site jobs [S11]
- MCP remains designed for persistent state, rich introspection, iterative page-structure reasoning, exploratory/long-running loops [S3,S11]

### Direct extraction / hybrid channels

- DOM/JS extraction can return schema-specific fields instead of full page representation
- Network-response extraction can bypass rendered-page repetition when required data already exists in JSON/XHR/GraphQL responses
- Deterministic Playwright code can batch multiple navigation/extraction actions into one model-visible call; model receives final compact result rather than every intermediate AxTree
- Sitemap protocol supplies explicit site URL lists; sitemap indexes enumerate sitemap files; sitemap presence does not guarantee completeness/crawlability [S28]
- DOM link inventory supplies discovered internal URLs; sitemap + internal-link graph + configured mandatory routes form separate coverage sources
- Screenshot/vision remains necessary for canvas, image-only text, spatial relationships, charts, inaccessible custom controls; text channels omit such information [S2]

## Claude context controls

### MCP schema/output load

- Claude Code MCP tool search is enabled by default on supported first-party/model paths; startup loads tool names/server instructions; full schemas load on demand only for used tools [S9]
- `ENABLE_TOOL_SEARCH=auto:N`: upfront schemas only within N% context threshold; `false`: all schemas upfront; `alwaysLoad:true`: server exempt from deferral [S9]
- Server instructions/tool descriptions truncated at 2 KB each [S9]
- CLI tools have no MCP per-tool listing overhead [S7]
- Prompt caching reduces billed repeated-prefix cost; does not remove content from context or solve instruction dilution [S7]

### Skills

- Skill description normally loads at session start; full `SKILL.md` loads only on invocation [S5]
- `disable-model-invocation:true`: description absent from context; manual invocation only [S5]
- supporting files load only when read; scripts can execute without loading source text into model context [S5]
- `context:fork`: skill runs in isolated subagent context; no parent conversation history; only result summary returns [S5]
- preloaded `skills:` in subagent inject full skill bodies at subagent startup [S12]
- concise `SKILL.md` + external references separates persistent procedure from on-demand schemas/examples [S5]

### Subagents / sessions

- Subagents have fresh isolated context; verbose reads/tool output remain outside parent; summary returns [S8,S13]
- custom subagents support restricted tools/MCP servers, model selection, `maxTurns`, hooks, initial prompt, memory [S12,S13]
- `model:haiku|sonnet|opus|inherit` permits cost/capability routing; Explore/Plan/general-purpose have distinct tool/context behavior [S13]
- per-URL/per-section isolated workers prevent prior-page snapshots from entering later-page worker context
- separate `claude -p` invocations create hard context boundaries; JSON/stream-JSON output exposes per-run usage metadata [S16]
- agent teams: independent context per teammate; shared task list; higher token cost than subagents because each teammate is a full Claude instance [S15]

### Structured output

- Claude Code print mode supports validated JSON Schema output via `--output-format json --json-schema`; final response includes `structured_output` + usage/session metadata [S16]
- Agent SDK structured outputs return schema-validated data in `structured_output` [S17]
- JSON schema constrains final serialization; it does not constrain browser observations, hidden reasoning, navigation count, or page coverage

## Deterministic coverage/state mechanisms

### External crawl frontier

- State stored outside model context: canonical URL/id; source; required/optional; status (`pending|in_progress|completed|failed|skipped`); attempts; discovered links; evidence; extraction result; completion/error code
- Scheduler-selected next URL removes model discretion over whether a mandatory page is visited
- Page completion acknowledged only after external validator accepts required fields/evidence
- Queue exhaustion + zero unresolved required items is machine-checkable termination; natural-language “done” is not
- Canonicalization/deduplication separates URL variants/fragments/query permutations from unique logical pages
- Retry budget/dead-letter state prevents infinite loops while preserving explicit incompleteness
- Coverage denominator fixed by sitemap/config/discovery policy; coverage = terminal required pages / required pages

### Claude task state

- Claude Task tools: `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`; statuses `pending|in_progress|completed`; dependencies/blockers supported [S18]
- Agent-team task list persists locally; blocked tasks unlock when dependencies complete; pending/in-progress/completed state visible to all teammates [S15]
- Task state is separate from prose conversation; model can reread current task list after compaction [S15,S18]

### Hooks / gates

- Hooks run at lifecycle boundaries: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `TaskCreated`, `TaskCompleted`, `SubagentStop`, `Stop`, `PreCompact`, `PostCompact`, etc. [S14]
- MCP calls appear as normal hook-matchable tools: `mcp__<server>__<tool>` [S14]
- `Stop`/`SubagentStop` hooks can return `decision:"block"` + reason, continuing execution instead of accepting termination [S14]
- `PostToolUse` can inspect browser calls/results and inject/block based on state [S14]
- Hook command/HTTP handlers are deterministic code; prompt/agent hooks add another model call

## Planning / memory architectures: published facts

### Planner–Actor / staged state

- HMT stores trajectory memory as Intent → Stage → Action; stages have observable preconditions/postconditions; Planner selects stage; Actor grounds semantic action on current page [S27]
- HMT reports stronger Mind2Web/WebArena cross-site/domain results than flat trajectory memory; paper attributes flat-memory failure to site-specific action details mixed with high-level workflow, causing skipped/invalid steps/context pollution [S27]
- Explicit stage pre/postconditions expose incomplete navigation stages independently of free-form memory

### Decomposition + dynamic replanning

- WebDART separates navigation subtasks from data/constraint analysis and replans when new elements invalidate/improve initial plan [S25]
- WebChoreArena: up to +13.7 percentage-point success over baselines; up to 14.7 fewer navigation steps; dynamic replanning corrected misleading search paths/endless traversal [S25]
- Decomposition transforms one long policy into bounded subtasks with explicit outputs; replanning changes remaining plan, not completed-state history

### Selective history / branching

- AgentOccam removes redundant elements/actions, selectively replays prior-page elements, and uses `branch`/`prune` to discard history outside current subplan [S19]
- Selective history reduced repetitive actions/steps; some dense/multi-page tasks lost 3.2 and 6.0 success points [S19]
- Narrower action space reduced wandering/rare-action use; disabled scrolling stopped reversible scroll loops but increased observation tokens [S20]
- AgentOccam WebArena GPT-4-Turbo success: 43.1%; judge variant: 45.7%; observation/step effects varied strongly by site [S19,S20]

### Cross-session episodic memory

- WebCoach: raw-log condenser → external episodic store → similarity/recency retrieval → runtime coaching hook [S26]
- 38B-model WebVoyager success increased 47%→61%; average steps reduced or maintained [S26]
- Persistent memory removes full historical trajectories from live context; retrieved summaries re-enter context
- Claude custom subagent memory injects first 200 lines or 25 KB of `MEMORY.md`; Read/Write/Edit enabled for memory management [S12]

## Observation-reduction research

### AxTree/line retrieval

- FocusAgent uses lightweight LLM retrieval over AxTree lines; >50% average observation reduction, often >80%, with benchmark performance matching full-observation baselines; prompt-injection success also reduced [S21]
- LineRetriever selects lines for future navigation/planning relevance, not semantic similarity alone; reported smaller per-step observations with comparable performance under context limits [S23]
- Retrieval adds separate inference/token cost; omitted critical lines create irreversible grounding/coverage failures unless fallback/full-view exists

### Region/section abstraction

- Region4Web/PageDigest groups page into functional regions, persists compact region state, expands full view on fallback [S24]
- Four backbones: average observation 6,437→3,671 tokens (-43%); average success +2.3 points [S24]
- Median per-step observation 3,077→2,066 (-33%); median cumulative task observation 26,707→19,944 (-25%) [S24]
- Added token composition: actor 73.9%, region selection 19.5%, fallback full-view 6.6%; fallback used in 38.1% tasks [S24]
- Region-level processing outperformed an element-level compact variant in reported ablation [S24]

### Programmatic pruning

- Prune4Web generates executable scoring programs from decomposed subtasks; program filters DOM before model grounding [S22]
- Candidate elements reduced 25×–50×; reported low-level grounding accuracy 46.8%→88.28% [S22]
- Minimal Failure Set research defines indispensable HTML element subset; retention coverage strongly correlated with end-to-end success in tested benchmarks [S29]
- Optimized pruning: WorkArena L1 2.2× faster/step with 84% original success retained; WebLinx 3.1× faster with 89% retained [S29]
- Extractive reduction may trade latency for success; domain-specific optimization/computation often required [S29]

### Diff/history representations

- 2026 evaluation: compact AxTree favored lower-capability models; detailed HTML favored higher-capability models with larger thinking budgets [S30]
- Higher-capability models used HTML layout for grounding; lower-capability models hallucinated more under longer inputs [S30]
- Observation history improved most tested settings; diff-based history provided token-efficient alternative [S30]
- Aggressive truncation has no universal optimum; representation/model/task interaction determines success

## Architecture spectrum

1. **Pure MCP agent**: model sees iterative AxTree; maximal introspection; maximal repeated observation/context accumulation
2. **Selective MCP agent**: `find`/subtree/depth/file/network-part observations; same agent loop; lower inline context
3. **CLI+Skills agent**: command schemas/procedure in skill; snapshots/logs file-backed; model reads selected files
4. **Crawler→LLM pipeline**: deterministic URL traversal/extraction; model receives page-specific compact payload only
5. **Hybrid scheduler + per-page agent**: external frontier chooses page; isolated Claude worker extracts one schema result; parent aggregates
6. **Planner + browser workers**: compact global plan/ledger; page workers hold local browser context; summaries only cross boundary
7. **Network/API-first extractor + browser fallback**: structured endpoint data primary; rendered interaction only for discovery/auth/visual-only content
8. **Retriever/pruner + actor**: separate observation-selection stage; actor sees reduced AxTree/DOM; optional full-view fallback
9. **Region-memory agent**: functional page digest persists; only active/changed regions expanded
10. **Deterministic site adapter**: fixed Playwright code for navigation/extraction; LLM limited to ambiguous classification/normalization
11. **Cross-session memory agent**: condensed prior trajectories/site maps retrieved by task/site/stage
12. **Full HTML/long-context agent**: higher input cost; potentially better grounding for high-capability/high-thinking models; lower-capability degradation observed

## Measurement facts

- Token attribution requires per-call separation of: startup/system; tool schemas; skill descriptions/bodies; prompt; AxTree/HTML/screenshot; prior observations/actions; tool results; model output/thinking; compaction summary; subagent summary
- Claude JSON output exposes usage/cost metadata per invocation [S16]
- MCP `/context` shows context consumers; `/mcp` shows server costs; MCP output warning identifies >10k-token result events [S7,S8,S10]
- Per-site metrics: URLs required/discovered/visited/completed/failed/skipped; actions; snapshots; inline snapshot tokens; file snapshot bytes; model input/output/cache/thinking tokens; compactions; retries; loops; duplicate visits; missing required fields; stop blocks
- Per-page isolated runs permit direct attribution; monolithic runs confound prior-page context with current-page cost
- Prompt caching lowers repeated-prefix price; token volume/context occupancy remains
- Total cost is not proportional only to snapshot size: step count × accumulated live context × model tier/thinking + auxiliary retriever/planner/judge calls

## Sources

- [S1] Playwright MCP Introduction — https://playwright.dev/mcp/introduction
- [S2] Playwright MCP Snapshots — https://playwright.dev/mcp/snapshots
- [S3] Microsoft Playwright MCP README — https://github.com/microsoft/playwright-mcp/blob/main/README.md
- [S4] Playwright MCP tool reference in README — https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools
- [S5] Claude Code Skills — https://code.claude.com/docs/en/skills
- [S6] Claude Code Context Window — https://code.claude.com/docs/en/context-window
- [S7] Claude Code Costs — https://code.claude.com/docs/en/costs
- [S8] How Claude Code Works — https://code.claude.com/docs/en/how-claude-code-works
- [S9] Claude Code MCP / Tool Search — https://code.claude.com/docs/en/mcp
- [S10] Claude Code MCP Output Limits — https://code.claude.com/docs/en/mcp#large-mcp-outputs
- [S11] Microsoft Playwright CLI — https://github.com/microsoft/playwright-cli
- [S12] Claude Code Subagent configuration/memory — https://code.claude.com/docs/en/sub-agents
- [S13] Claude Code Subagents — https://code.claude.com/docs/en/sub-agents
- [S14] Claude Code Hooks — https://code.claude.com/docs/en/hooks
- [S15] Claude Code Agent Teams — https://code.claude.com/docs/en/agent-teams
- [S16] Claude Code Headless/Structured Output — https://code.claude.com/docs/en/headless
- [S17] Agent SDK Structured Outputs — https://code.claude.com/docs/en/agent-sdk/structured-outputs
- [S18] Agent SDK Task/Todo Tracking — https://code.claude.com/docs/en/agent-sdk/todo-tracking
- [S19] AgentOccam — https://arxiv.org/abs/2410.13825
- [S20] AgentOccam HTML — https://arxiv.org/html/2410.13825v2
- [S21] FocusAgent — https://arxiv.org/abs/2510.03204
- [S22] Prune4Web — https://arxiv.org/abs/2511.21398
- [S23] LineRetriever — https://arxiv.org/abs/2507.00210
- [S24] Region4Web/PageDigest — https://arxiv.org/abs/2605.07134
- [S25] WebDART — https://arxiv.org/abs/2510.06587
- [S26] WebCoach — https://arxiv.org/abs/2511.12997
- [S27] Hierarchical Memory Tree — https://arxiv.org/abs/2603.07024
- [S28] Sitemaps Protocol — https://www.sitemaps.org/protocol.html
- [S29] Revisiting Observation Reduction/MFS — https://arxiv.org/abs/2605.29397
- [S30] Read More, Think More — https://arxiv.org/abs/2604.01535

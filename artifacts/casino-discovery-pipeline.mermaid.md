```mermaid
flowchart TB
    REQUEST["/casino-discovery skill invocation<br/>casino_url • geo (required)<br/>locale resolved from geo · casino_id derived from domain"]

    subgraph SKILL["casino-discovery skill (orchestration, no LLM API calls — subscription CLI agent turns only)"]

        subgraph STEP1["Step 1 — recon"]
            RECON["url-map-recon agent<br/>Playwright MCP: navigate/evaluate/wait_for/network_requests/close<br/>URL/route discovery only — never product titles or page text"]
            REPLAY["src/research/url-map-recon/replay.ts<br/>deterministic recipe replay — no agent, no tokens<br/>used instead of RECON on a re-crawl if extraction-recipe.json exists and still matches"]
            URLCLEAN["url-clean.ts<br/>resolve • canonicalize • keep/drop rules<br/>deterministic authority for classification"]
            EXTRACTORS["extractors.ts<br/>registered extractor ids (DOM_URL_ATTRIBUTES_V1, INLINE_SCRIPT_URL_TOKENS_V1,<br/>JSON_ENDPOINT_URL_TOKENS_V1, ROBOTS_SITEMAP_URLS_V1, SPA_ROUTE_URL_TOKENS_V1, ...)"]
            URLMAP["document-url-map.json"]
            COVERAGE["url-source-coverage.json<br/>present/absent/blocked/unsupported/error per source family"]
            RECIPE["extraction-recipe.json<br/>declarative extractorId+params steps, no executable code"]
        end

        subgraph STEP1B["Step 1b — classification (deterministic, no browser)"]
            CLASSIFY["src/research/template-classification/classify.ts<br/>reads canonicalUrl/derivedLabel/originStatus/source only<br/>maps entries to research-template categories + role + confidence + reason"]
        end

        subgraph STEP2["Step 2 — product collection"]
            PRODCOLLECT["src/research/url-map-recon/product-collector.ts<br/>deterministic — consumes distilled title/name lists from a targeted browser_evaluate<br/>filters fixture-shaped names (e.g. Team A vs Team B)"]
            PRODFILES["sports.json · live-casino.json · slots.json<br/>titles only — sport names / category names / slot names"]
        end

        subgraph STEP3["Step 3 — behavior profiling"]
            DISCBROWSER["discovery-browser agent<br/>Playwright MCP: navigate/snapshot/click/screenshot/find/hover/press_key/<br/>wait_for/evaluate/network_requests/tabs/select_option/fill_form/resize/close<br/>+ Read/Write — reads URL map, product files, recipe before browsing"]
            PAGEBEHAVIOR["page-behavior.json<br/>rendering type • gates • interactive elements • loading pattern • nav paths<br/>never writes to URL map or product files"]
        end

        subgraph STEP4["Step 4 — review artifact"]
            REVIEWER["discovery-reviewer agent (haiku, read-only)<br/>reads document-url-map + product files + recipe + page-behavior + coverage"]
            ARTIFACT["Published HTML review artifact<br/>11 research-template categories • product collections •<br/>raw URL map • behavior profile • extraction provenance"]
        end
    end

    HUMAN["human_required<br/>returned by any agent on auth gate / CAPTCHA / geo block /<br/>inaccessible mandatory source — orchestrator stops that branch and asks the human"]

    REQUEST --> RECON
    REQUEST -.->|re-crawl, recipe still valid| REPLAY

    RECON -->|targeted browser_evaluate, distilled results only| EXTRACTORS
    REPLAY -->|executes registered extractors from recipe| EXTRACTORS
    EXTRACTORS --> URLCLEAN
    URLCLEAN --> URLMAP
    RECON --> COVERAGE
    REPLAY --> COVERAGE
    RECON --> RECIPE
    RECON -->|auth gate on mandatory source| HUMAN

    URLMAP --> CLASSIFY
    CLASSIFY -->|classifications[] written back onto entries| URLMAP

    URLMAP -->|approved category landing URLs| PRODCOLLECT
    PRODCOLLECT --> PRODFILES

    URLMAP --> DISCBROWSER
    PRODFILES --> DISCBROWSER
    RECIPE --> DISCBROWSER
    DISCBROWSER --> PAGEBEHAVIOR
    DISCBROWSER -->|login/registration gate detected| HUMAN

    URLMAP --> REVIEWER
    PRODFILES --> REVIEWER
    RECIPE --> REVIEWER
    PAGEBEHAVIOR --> REVIEWER
    COVERAGE --> REVIEWER
    REVIEWER --> ARTIFACT
```

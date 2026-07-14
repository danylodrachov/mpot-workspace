---
paths:
  - "**/credentials*.json"
  - "**/casinos-to-research*.json"
---
Secrets/PII are inputs, not prose. Never quote, summarize, log, evidence, capture, handoff, or copy them to state. Only auth-browser may read credential content. Coordinator/planner/extractor/auditor use credential file path only. Direct login/password copy allowed solely into matching `casinos` operator columns.

---
paths:
  - "research-output/**/*.json"
  - "research-output/**/*.jsonl"
---
12 rubric files: root exactly `{"rows":[...]}`; row keys only actual rubric columns; exact type/enum. Service metadata never enters rubric files.
Value write requires evidence URL. Unknown/not-found/blocked/out-of-enum/conflict: omit unresolved value; set research-state reason; add handoff item.
Conflict: keep every candidate+URL; no priority/winner.
Singleton categories max 1 row. Collection upsert keys from casino-core/references/output-contract.json.
Credentials forbidden except direct input copy to `casinos.login/password` when exact columns exist. Never put profile PII in other files.

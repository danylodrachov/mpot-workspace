#!/usr/bin/env python3
"""Ad-hoc helper for this run only: update one surface's fields and optionally bump a budget counter.
Usage: manifest-set.py <manifest.json> <surface_id> key=value [key=value ...] [--budget key]
"""
import json
import sys

path = sys.argv[1]
surface_id = sys.argv[2]
rest = sys.argv[3:]

budget_key = None
kvs = []
i = 0
while i < len(rest):
    if rest[i] == "--budget":
        budget_key = rest[i + 1]
        i += 2
    else:
        kvs.append(rest[i])
        i += 1

m = json.load(open(path))
for s in m["surfaces"]:
    if s["surface_id"] == surface_id:
        for kv in kvs:
            k, v = kv.split("=", 1)
            if v == "__DELETE__":
                s.pop(k, None)
            else:
                s[k] = v
        break
else:
    raise SystemExit(f"surface {surface_id} not found")

if budget_key:
    m["budget"][budget_key]["used"] += 1

json.dump(m, open(path, "w"), indent=2)

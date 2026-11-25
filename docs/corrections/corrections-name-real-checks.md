# Every rule here names checks that exist, and every enforced rule has one that CI runs

One file per rule, so parallel branches never edit the same lines. Rules written
into a table in AGENTS.md fail; `node scripts/check-corrections.mjs --adopt`
moves them here.

Enforced by:
- `scripts/check-corrections.test.mjs` runs `scripts/check-corrections.mjs` on this folder

# Delete only what you created, by its exact path; temp, scratchpad and worktree folders hold other agents' work

On 2026-11-25 helpers working side by side deleted each other's files while
cleaning a shared temp folder with wildcards.

Enforced by:
- `scripts/flujo-drive.test.mjs`: `flujo-drive stop` touches only the instance and data folder its own checkout started

Prose: everything beyond FLUJO's own tools needs judgment. Never clean a shared folder with a wildcard or name pattern, and never remove another session's worktree, branch or files.

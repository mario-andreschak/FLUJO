# Repository hygiene

Keep generated run records, provider traces, screenshots used only as proof,
agent handovers and media production projects outside this repository. Commit
media only when a published page or maintained product guide uses it. Reuse
existing screenshots rather than committing identical copies.

Perform cleanup and file deletions through the flujo-bash MCP. Keep the primary
development checkout on `main`; remove temporary branches after delivery.

Delete only what you created, by its exact path. Temp, scratchpad and worktree
folders are shared with other agents working at the same time: never clean them
with a wildcard or name pattern, and never remove another session's worktree,
branch or files.

`npm run check:repo-hygiene` enforces the file rules above.

# Issues kept for newcomers

Leave issues labelled `good first issue` to first-time human contributors. Do
not fix them in an agent session unless Mario asks for that exact issue. When
one closes, open a replacement and update `docs/contributing/starter-backlog.md`.

# Corrections become checks

When a mistake comes back, or a reviewer corrects one, fix it where it cannot
return. Take the first of these that works:

1. Code: change the API, types or folder layout so the wrong code cannot be
   written.
2. A check: a lint rule in `tooling/eslint-plugin-flujo`, a type or a test.
   Its message says how to fix the cause, never how to silence it.
3. Verification: run the app and check what the user sees
   (`.claude/skills/verify-flujo/SKILL.md`, `docs/feature-map/`).
4. Prose here or in a skill, only for calls that need judgment.

Before you call a change a user can see done, check it in a throwaway FLUJO with
the `verify-flujo` skill and keep the proof.

Then record the rule as its own small file in `docs/corrections/`, never as a
table here: one file per rule keeps parallel branches from editing the same
lines. `npm run check:corrections` fails when a rule names a lint rule, file,
test or script that does not exist, or a check that CI never runs;
`npm run check:corrections -- --list` prints every rule with its check. The
recipe is `.claude/skills/correct/SKILL.md`.

Changed an API route? Run `npm run check:routes`: unlock gate, multi-user kind,
record ids and `docs/api-reference/routes.md`.

Code that already broke a rule when the rule arrived is listed in
`eslint-suppressions.json`. That list only shrinks: ESLint fails on entries
that are no longer needed (`npm run lint:prune` removes them) and
`npm run lint:ratchet` fails when it grows. Never run eslint with
`--suppress-all`. A real exception goes on its own line with a reason:
`// eslint-disable-next-line <rule> -- <why>`.

Write code that needs no comment, and never use a comment to explain away a
workaround.

# Resilience over refusal

FLUJO is a long-running desktop app. Prefer degrading gracefully to failing
closed:

- Under pressure (busy slots, memory, locks), make callers wait with a bounded
  timeout instead of refusing at once. Retry transient I/O errors.
- A failure must never block a conversation, workspace or slot until restart.
  Every fence, quarantine or counter must be released or healed automatically
  (on the next success, when its owner settles, or when its process is gone).
  When you change how conversation saves wait, fence or release, update
  `docs/formal/ConversationWriteHealing.tla` and run `npm run check:formal`.
- Do not add a fixed limit without saying how it recovers without a restart and
  without the user knowing an environment variable. Scale memory limits with
  the machine.
- Keep work off the event loop, and fix the throughput cause (batching, fewer
  syscalls) rather than adding another admission gate.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

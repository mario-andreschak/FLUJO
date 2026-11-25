# Repository hygiene

Keep generated run records, provider traces, screenshots used only as proof,
agent handovers and media production projects outside this repository. Commit
media only when a published page or maintained product guide uses it. Reuse
existing screenshots rather than committing identical copies.

Perform cleanup and file deletions through the flujo-bash MCP. Keep the primary
development checkout on `main`; remove temporary branches after delivery.

`npm run check:repo-hygiene` enforces the file rules above.

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

Then add a row to the table. The recipe is `.claude/skills/correct/SKILL.md`.

Code that already broke a rule when the rule arrived is listed in
`eslint-suppressions.json`. That list only shrinks: ESLint fails on entries
that are no longer needed (`npm run lint:prune` removes them) and
`npm run lint:ratchet` fails when it grows. Never run eslint with
`--suppress-all`. A real exception goes on its own line with a reason:
`// eslint-disable-next-line <rule> -- <why>`.

Write code that needs no comment, and never use a comment to explain away a
workaround.

| Rule | Enforced by |
|---|---|
| Fix the cause; no comments that justify a workaround | `flujo/no-workaround-comment` |
| Every lint or type exception names its rule and reason | `flujo/disable-needs-reason`, `@typescript-eslint/ban-ts-comment` |
| No `as unknown as` casts | `flujo/no-double-cast` |
| Keep work off the event loop: no synchronous file calls in `src/` | `flujo/no-sync-fs` |
| No raw timers in UI code; use `src/frontend/hooks/timing.ts` | `flujo/no-raw-timers` |
| Effects, refs and state follow React's rules | `react-hooks/*` in `eslint.config.mjs` |
| `backend`, `frontend` and `shared` import only what their layer allows | `__tests__/architecture/importBoundaries.test.ts` |
| Repository hygiene | `scripts/check-repo-hygiene.mjs` |
| Every page has exactly one feature map entry | `scripts/check-feature-map.mjs` |
| A conversation save's fences, quarantined slots, intent files and writer locks heal when their owner settles or its process is gone; no chat stays blocked | `npm run check:formal` (`docs/formal/`), `__tests__/flow/conversationPublication.property.test.ts` |
| Resilience over refusal | Prose: needs judgment |

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

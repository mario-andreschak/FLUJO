# Repository hygiene

Keep generated run records, provider traces, screenshots used only as proof,
agent handovers and media production projects outside this repository. Commit
media only when a published page or maintained product guide uses it. Reuse
existing screenshots rather than committing identical copies.

Perform cleanup and file deletions through the flujo-bash MCP. Keep the primary
development checkout on `main`; remove temporary branches after delivery.

# Resilience over refusal

FLUJO is a long-running desktop app. Prefer degrading gracefully to failing
closed:

- Under pressure (busy slots, memory, locks), make callers wait with a bounded
  timeout instead of refusing at once. Retry transient I/O errors.
- A failure must never block a conversation, workspace or slot until restart.
  Every fence, quarantine or counter must be released or healed automatically
  (on the next success, when its owner settles, or when its process is gone).
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

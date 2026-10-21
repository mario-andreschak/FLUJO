# Local-first multi-tenancy

FLUJO must never rely on online isolation. Multi-user identity, authorization,
tenant isolation, revocation, team sharing, edit locks and history must work on
the local machine without internet access, including with LAN disabled. Cold
start, account enrollment/recovery and restart must also work offline; cached
online sessions are not sufficient. Do not require Fly Machines, another cloud
service, an external identity provider, online DNS or online control-plane leases
for these boundaries. Optional online integrations cannot confer or maintain
local isolation. Qualify the actual local OS/process/filesystem boundaries on
each supported platform before claiming complete multi-tenant support.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

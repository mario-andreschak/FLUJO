# Multi-user and teams plan (#212)

Status: accepted plan for the epic, 2026-11-25. It replaces the topology in
[shared-deployment-v1.md](shared-deployment-v1.md) (one controller plus one
container per user) and the parked draft PR #1233. Child issues: #573 (contracts),
#574 (Tier 0: private ownership), #575 (Tier 1: teams). Tier 2 (fine-grained
roles) is not planned yet.

## The hard rule: multi-user mode is opt-in

- It is off unless an admin turns it on. The switch is the file
  `<data>/accounts/accounts.json` with `"enabled": true`.
- While it is off, FLUJO behaves exactly as today: no login page, no new checks,
  no new files, and existing data loads unchanged. Code paths added by this epic
  must return early when the mode is off, before reading anything new.
- Turning it on moves no data. Turning it off again restores today's behaviour;
  ownership records stay in `accounts.json` for the next time.
- Every child session keeps a test that proves this (see "Test strategy").

## What users get

- **Tier 0 (#574):** people sign in with a name and password. Each person sees
  only the workspaces they own. An admin manages accounts.
- **Tier 1 (#575):** an admin creates teams. A team owns team workspaces. Every
  member can see and use the models, MCP servers, flows, chats and runs in them.
  Two people cannot edit the same object at once, and every change is recorded
  with who made it and can be undone.

## Key decision: the workspace is the unit of ownership

A user or a team owns whole workspaces. We do not add an owner field to every
flow, model or chat.

Why:

- 223 of 235 HTTP routes already pass through one function,
  `withWorkspace` in `src/app/api/_workspace.ts`, and
  `__tests__/workspace/routeCoverage.test.ts` fails if a new route skips it.
  One ownership check there covers almost everything.
- Workspaces are already separated inside the process: own folders, cache keys
  (`workspaceCacheKey`), MCP homes, schedulers, OAuth state and secret keyring.
  The `__tests__/workspace/*Isolation.test.ts` tests guard this today.
- Secrets are encrypted per workspace (`src/utils/encryption`), so personal keys
  stay in personal workspaces without new encryption code.
- Other tools use the same shape. n8n groups workflows and credentials into
  personal and team "projects" and gives roles per project.

Sharing a single object from a personal workspace means copying it into a team
workspace (with secrets removed). Live links between workspaces are out of scope.

## Trust model: who is protected from whom

- Multi-user mode keeps users apart **inside FLUJO**. It does not protect anyone
  from the admin or from a person who can log in to the server machine.
- **Host access** is the power to run programs or read files on the server:
  starting local (stdio) MCP servers outside a container, browsing host folders,
  git, shell helpers, package installs, workspace folder roots, local model
  downloads, updates and runtime settings. Anyone with host access can read every
  user's files, so in multi-user mode only admins have it by default. An admin
  may give it to a trusted user, with a plain warning.
- Users without host access use MCP servers in the existing isolated container
  profile (`docker-deny-egress`, see
  [MCP execution profiles](../security/mcp-execution-profiles.md)) or remote MCP
  servers.
- Team workspace secrets can be used by every member in runs but are never shown
  (they stay masked, as today). A personal key never moves to a team workspace by
  itself.
- Supported: one machine or a local network with colleagues who trust each other
  to that degree. Not supported: public hosting for strangers. That would need a
  separate operating-system sandbox per user and is a later decision.

## Review of the parked draft (PR #1233, `codex/oldest-issues-212` at fb1c845a)

The draft forked from main on 2026-10-23. Main has since moved 181 commits
(544 files); 26 files changed on both sides. It is kept as it is: not merged,
rebased, closed or deleted.

| Piece in the draft | Verdict | Reason |
|---|---|---|
| Controller process with one FLUJO container per user (`packages/shared-controller`: local-runtime, provision/rotate-runtime, runtime-pipes, proxy, runtime-supervisor) | Do not reuse | Needs a container engine and a full FLUJO per user; about 20,000 lines beside the app. Per-workspace separation in one process covers the supported setup. |
| Local HTTPS and certificate trust (local-tls, tls-trust, certificate-command) | Do not reuse | Out of scope. On a network, put FLUJO behind a normal HTTPS reverse proxy. |
| Model/MCP relays and owner pipes (model-brokers, model-channel, runtime-model-*, app-sandboxes, app-websocket) | Do not reuse | Only needed because of the per-user containers. |
| `node:sqlite` ledger (ledger.ts) | Do not reuse | Synchronous calls block the event loop, and the module is still experimental in Node 22. Accounts data is small: one JSON file written atomically is enough. |
| Fixed storage caps that refuse writes (128/512 MiB per team, 1,000 revisions) | Must not copy | Breaks "resilience over refusal". Prune the oldest history instead. |
| Synchronous file helpers (private-publish, private-storage, windows-storage) | Must not copy | Breaks `flujo/no-sync-fs`. |
| scrypt password hashing (password.ts) | Reuse the idea, rewrite | Async `crypto.scrypt`, N=2^17, r=8, p=1, minimum 15 characters. Matches OWASP and NIST SP 800-63B-4. |
| Login slow-down after failed attempts | Reuse the idea, keep in memory | Heals on success or restart; never a permanent lockout. |
| Team membership states with a generation counter (teams.ts) | Reuse the idea | invited/member/removed; bumping the generation cuts off old sessions and locks. |
| Edit lease + revision + restore rules (team-resources.ts) | Reuse the idea | Short lease, revision check on save, restore creates a new revision. |
| Allowlists of what may be copied for models, flows and MCP servers (shared-model.ts, shared-flow.ts, shared-mcp.ts) | Reuse the idea; rebuild the field lists from today's types | An allowlist stops new secret fields from leaking. The draft's field lists are out of date. |
| Team pages and team catalogue services (`src/frontend/components/Teams`, `src/app/teams`, `*/teamCatalogue.ts`, changes in flow/model services) | Do not reuse | Built for the controller APIs. Team workspaces reuse the normal pages. |
| `shared-runtime-inventory.json` | Do not reuse | Out-of-date text scan. `routeCoverage.test.ts` is the living inventory. |
| Controller tests (`packages/shared-controller/test`) | Use as a checklist only | Good cases: guessed IDs, membership removed during an edit, stale edit lease, restore after revoke. |

## Data layout

```text
<data>/
  workspaces/<name>/...       unchanged; still the only place for user data
  accounts/                   exists only after multi-user mode was turned on
    accounts.json             mode switch, users, teams, workspace owners, API token digests
    sessions.json             signed-in sessions (token digests only)
    audit.jsonl               sign-in, account, team and ownership changes (no secrets)
  workspaces/<name>/db/history/<kind>/<id>.jsonl   Tier 1 change history per object
```

Example of `accounts.json`. The exact schema is `accountsFileSchema` in
`src/shared/types/accounts.ts` (#573); the security rules are in
[multi-user contracts](multi-user-contracts.md).

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "revision": 7,
  "users": [{ "id": "u_…", "name": "anna", "displayName": "Anna",
              "passwordHash": "scrypt-v1$17$8$1$<salt>$<hash>", "role": "admin",
              "hostAccess": true, "disabled": false, "generation": 1,
              "createdAt": 1764000000000 }],
  "teams": [{ "id": "t_…", "name": "Sales", "generation": 1, "createdAt": 1764000000000,
              "members": [{ "userId": "u_…", "role": "owner", "state": "member" }] }],
  "workspaces": { "default-workspace": { "ownerType": "user", "ownerId": "u_…",
                                         "assignedAt": 1764000000000 } },
  "apiTokens": [{ "id": "…", "userId": "u_…", "digest": "<sha-256 hex>",
                  "scopes": ["openai:execute"], "issuedAt": 1764000000000,
                  "expiresAt": 1795536000000, "revokedAt": null }]
}
```

Rules:

- Users, teams, owners and tokens live in one file, so one atomic write changes
  them together. Writes go through one in-process queue (`runInWriteChain`) and
  `writeFileAtomic` from `src/utils/storage/backend.ts`, with a `.bak` copy of
  the last good file. A broken file falls back to the `.bak` and logs it; it
  never falls back to "no login".
- `accounts/` sits outside `workspaces/`, so workspace backups, snapshots and
  exports never include it.
- Edit locks live in memory only. After a restart they are gone, and the
  revision check on save still prevents lost changes.
- One FLUJO process per data folder, as today.

## Who owns which code

| Code | Owns | Built in |
|---|---|---|
| `src/shared/types/accounts.ts` (new) | Types and zod schemas: user, team, workspace owner, signed-in principal, capability | #573 |
| `src/backend/services/accounts/access.ts` (new) | Pure rules: may this principal use this workspace for this action; which capability a route needs | #573 (pure, tested), wired in #574 |
| `src/backend/services/accounts/routeCapabilities.ts` (new) | Each route's needed capability: `workspace`, `host`, `admin`, `account` (own sign-in) or `protocol` (OAuth/webhook/worker, own checks) | #573 with its coverage test; checked on every request from #574 |
| `src/backend/services/accounts/store.ts`, `passwords.ts`, `sessions.ts`, `tokens.ts` (new) | Read/write `accounts/`, hashing, sessions, API tokens, mode switch | #574 |
| `src/app/api/_workspace.ts` | After `resolveWorkspace`: ask `access.ts`, carry the principal next to the workspace in AsyncLocalStorage | #574 |
| `src/proxy.ts` | Mode on: pages need a session cookie (otherwise go to `/owner/login`); APIs answer 401 | #574 |
| `src/app/api/workspaces/route.ts` | Mode on: list only accessible workspaces; a new workspace belongs to its creator (or a team in #575) | #574, #575 |
| Installation-wide routes (`update`, `network-exposure`, `runtime-environment`, …) | Mode on: admin only | #574 |
| Scheduler, triggers, personas, waves (startup sweep in `src/backend/init.ts`) | Mode on: before automatic work, check the workspace owner is still active; else pause and resume by itself when re-enabled | #574 |
| `src/backend/services/editLocks/` (new) | In-memory edit leases with heartbeat and expiry | #575 |
| `src/backend/services/history/` (new) | Append-only change history, view and restore | #575 |
| Sign-in (extend the existing `src/app/owner/login` page; no second login page), user admin and team pages under `src/app/settings` | UI, each with one `docs/feature-map/` entry | #574, #575 |

The existing single-owner policy (`FLUJO_OWNER_AUTH_FILE`,
`src/backend/services/security/owner*.ts`) stays as is for single-user installs.
When multi-user mode is turned on, its API tokens are copied to the first admin,
so scripts and MCP clients keep working. While the mode is on, accounts decide
and the owner policy is ignored with a clear log line.

## How the signed-in person travels through the code

- HTTP: `withWorkspace` resolves the principal once from the session cookie or
  the API token, checks access, then runs the handler with both workspace and
  principal in AsyncLocalStorage. Services keep using the workspace as today.
- A workspace chosen by the browser (query or `x-flujo-workspace` header) only
  selects. Access comes from `accounts.json`. Unknown and forbidden workspaces
  give the same 404, so guessing names reveals nothing.
- Streams (SSE): recheck the session on a timer, like `bindOwnerStream` does
  today, and close the stream when access is gone.
- Background work has no signed-in person. It runs with the authority of the
  workspace owner and records which user started it, for the audit trail.
- Removing a user or team member bumps its generation. The next request,
  stream check or automatic run is refused, and work already running finishes
  its current step and stops.

## Moving existing single-user data

1. Turning on (Settings, from the local machine, or `node bin/flujo.mjs users init`):
   create the first admin; every existing workspace becomes owned by that admin;
   owner-policy tokens are copied to the admin. Nothing in `workspaces/` changes.
2. Turning off: set `"enabled": false` (in Settings or the CLI). FLUJO is a
   single-user install again, with all data where it was.
3. A workspace with no owner record (for example created while the mode was off)
   is visible to admins only and listed as "unassigned" on the admin page.
4. Restoring a workspace backup in multi-user mode: it belongs to the person who
   restores it. No old sessions, tokens or grants come back with it.
5. Forgotten admin password: `node bin/flujo.mjs users reset-password <name>` on
   the server. Access to the server machine is the recovery authority.

## Order of work (one session per step)

Each step ends with targeted tests, lint on touched files, a commit and an issue
comment. No step may change single-user behaviour.

### #573: contracts (no behaviour change)

Built on 2026-11-25: [multi-user contracts](multi-user-contracts.md) and the
tests in `__tests__/accounts/`.

- **573-1 Types and access rules.** `src/shared/types/accounts.ts` and
  `src/backend/services/accounts/access.ts` as pure code. Unit tests for two
  users, admin versus member, a team owner, member and non-member, a disabled
  user, and an unassigned workspace. Fix the exact `accounts.json` schema,
  session lifetime, cookie settings and token scopes in this file's
  "Decisions" table.
- **573-2 Route capability map.** `routeCapabilities.ts` classifies every
  `route.ts` (235 today) as `workspace`, `host`, `admin`, `account` or
  `protocol`. A test like `routeCoverage.test.ts` fails when a route is missing
  or the map names a route that no longer exists. Nothing uses the map yet.

### #574: Tier 0, private ownership

- **574-1 Accounts store.** `store.ts`, `passwords.ts`, `sessions.ts`,
  `tokens.ts` and the `users` CLI commands (init, add, disable, reset-password,
  off). Tests: save/load, `.bak` fallback, parallel writes, password checks,
  slow-down after failed logins, and mode off means no file is read.
- **574-2 Sign in.** Login/logout API and a name/password form on
  `/owner/login`; proxy redirect; the "Users" area in Settings to turn the mode
  on (first admin) and off; Network exposure accepts accounts as the required
  sign-in. Tests: the opt-in guard (below) and login flows. Feature-map entry
  and a short user guide.
- **574-3 Workspace ownership.** Check in `withWorkspace`; principal in
  AsyncLocalStorage; filtered workspace list; owner set on create; installation
  routes admin-only. Two-user route test matrix (below).
- **574-4 Host access.** Routes marked `host` and starting a non-container stdio
  MCP server need host access. Everyone else is told plainly how to use the
  container profile or a remote server. Tests for both kinds of user.
- **574-5 Background work, streams and tokens.** Stream recheck; scheduler,
  trigger and persona admission check the owner; pause and self-resume; API
  tokens per user for `/v1` and `/mcp-proxy`; old owner tokens copied on
  turn-on. Tests include a restart and a disabled owner.
- **574-6 Admin page and proof.** Users page (add, disable, reset password, give
  host access, assign unassigned workspaces) and the audit view. Two-user check
  in a throwaway FLUJO with the `verify-flujo` skill.

### #575: Tier 1, teams

- **575-1 Teams and team workspaces.** Teams in `accounts.json`; admin and team
  owner manage members; create a workspace owned by a team; removing a member
  cuts access at the next request and closes streams.
- **575-2 Edit protection.** Flows, models and MCP servers save with an
  `expectedRevision` and get a 409 with a clear "someone else saved" message
  when it is stale (copy the pattern in
  `src/backend/services/enduringAgents/personaDrafts.ts`). Add an edit lease:
  60 seconds, renewed every 20 seconds while the editor is open, shown as
  "Anna is editing". It expires by itself when a browser closes.
- **575-3 Change history.** Append who, when and what changed per object; show
  it; restore as a new revision (like role versions in `/v1/roles/[roleId]`).
  Keep the newest 200 entries per object and prune older ones; never refuse a
  save because history is full.
- **575-4 Copy into a team.** Copy a flow, model or MCP server from a personal
  workspace into a team workspace with an allowlist of fields (no keys, tokens,
  private paths). List missing dependencies, and never copy a secret silently.
- **575-5 Proof.** Three-role test matrix (team owner, member, non-member)
  including removal and guessed IDs; two-person share, edit, run and remove
  journey with `verify-flujo`.

## Test strategy

- **Opt-in guard (574-2, kept by every later step):** with no `accounts/`
  folder, existing route tests pass unchanged, and a test proves the accounts
  code reads no file and adds no check. A second test copies a single-user data
  folder, turns the mode on, then off, and compares every file under
  `workspaces/`: they must match byte for byte.
- **Pure rules (573-1):** table tests for `access.ts`.
- **Route coverage (573-2, 574-3):** every route has a capability, and every
  workspace route refuses another user's workspace.
- **Two-user matrix (574-3):** for list, read, write, delete, run, approve,
  subscribe and export, user B gets 404 on user A's workspace, including with a
  forged `x-flujo-workspace` header and an API token from B.
- **Background (574-5):** a disabled owner's scheduled run pauses; it resumes
  after re-enabling, also across a restart.
- **Teams (575-5):** owner/member/non-member matrix, and two editors saving the
  same flow get one success and one visible conflict.
- Tests run with `node scripts/run-local-jest.cjs <paths> --maxWorkers=2`.
  Browser checks use the `verify-flujo` skill on a throwaway instance. No
  container builds or installed-release checks are needed for this epic.

## Decisions

| Topic | Decision |
|---|---|
| Libraries | No new auth dependency. better-auth (MIT) needs a SQL database; Auth.js discourages password sign-in; Lucia is no longer maintained as a library. Use `node:crypto` and copy the patterns in `ownerCredentials.ts` and `ownerSession.ts`. Single sign-on (OIDC, for example with `openid-client`) can be added later. |
| Passwords | scrypt N=2^17, r=8, p=1, 16-byte salt; at least 15 characters, no character-type rules, reject a short list of common passwords and the user's own name (NIST SP 800-63B-4). |
| Failed sign-ins | Wait time doubles per failure per account, up to 15 minutes; resets on success or restart. |
| Sessions | Random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS); only its SHA-256 digest is stored. 8 hours, like today's owner sessions. Ended by logout, password change or disabling the user. |
| Cross-site requests | Changes need a same-origin `Origin` header, like `ownerBrowserRequestAllowed` today. |
| Default role of a new user | Member without host access. |
| Accounts files (#573) | Exact formats: `accountsFileSchema`, `sessionsFileSchema` and `auditEventSchema` in `src/shared/types/accounts.ts`. Unknown fields are refused; the mode needs one active admin. |
| Session cookie (#573) | `__Host-flujo-session` over HTTPS, `flujo-session` over HTTP; `flo_a1_` tokens; see [contracts](multi-user-contracts.md#browser-sessions). |
| API tokens (#573) | Same format and scope names as owner tokens, stored as digests, default expiry one year, never more than their person; see [contracts](multi-user-contracts.md#api-tokens). |
| Workspace actions (#573) | `read`, `edit`, `run`, `admin`. Team members get all but `admin`; `admin` covers the workspace password, showing secrets, backup, restore, credential transfer, rename, delete and owner change. |
| Encryption keys (#573) | Unchanged per-workspace keyrings. The sign-in password is never a key. See [contracts](multi-user-contracts.md#encryption-keys-how-each-persons-secrets-are-protected). |
| Edit locks | In-memory lease, 60 s, renewed every 20 s; the revision check on save is the real guard. |
| Out of scope | Public hosting for strangers, per-user OS sandboxes, Tier 2 roles, single sign-on, billing, live links between workspaces. |

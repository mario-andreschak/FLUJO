# Multi-user contracts: sign-in, sessions, API tokens and encryption keys (#573)

Status: accepted, 2026-11-25. Part of the [multi-user plan](multi-user-plan.md)
(epic #212). This page fixes the rules that #574 and #575 build on, so nobody
has to invent them along the way. Since #574 the running app uses them: the
store, sign-in, sessions and tokens live in `src/backend/services/accounts/`,
and `src/proxy.ts` and `withWorkspaceRoute` check every request with
`requestAccess.ts`.

Multi-user mode stays opt-in. While `<data>/accounts/accounts.json` is missing
or says `"enabled": false`, FLUJO reads none of these files and every access
rule answers "allowed" (`multi-user-off`), exactly like today.

## Where the contracts live

| What | File |
|---|---|
| File formats, constants and schemas | `src/shared/types/accounts.ts` |
| Who may do what (pure functions) | `src/backend/services/accounts/access.ts` |
| The kind of every HTTP route | `src/backend/services/accounts/routeCapabilities.ts` |
| Tests that hold them in place | `__tests__/accounts/access.test.ts`, `routeCapabilities.test.ts`, `accountsSchema.test.ts` |
| Store, passwords, sessions, tokens, the request check, host access and background pauses (#574) | `src/backend/services/accounts/*.ts`; tests in `__tests__/accounts/` (`optIn`, `twoUserIsolation`, `store`, `passwords`, `hostAccess`, `hostAccessStartPoints`, `backgroundPause`, `accountsCli`) |
| Server command line | `scripts/accounts-cli.mjs` (`node bin/flujo.mjs users …`, `npm run users -- …`) |

The tests are the source of truth. If this page and a test disagree, the test
wins and this page is fixed.

## Files under `<data>/accounts/`

| File | Holds | Never holds |
|---|---|---|
| `accounts.json` | Mode switch, people, teams, workspace owners, API token digests, `revision` | Passwords, tokens, workspace keys |
| `accounts.json.bak` | The last good copy of `accounts.json` | |
| `sessions.json` | Signed-in browser sessions: id, token digest, person, generation, start and end time | The cookie value |
| `audit.jsonl` | One line per sign-in, account, team or ownership change | Passwords, tokens, secrets |

Rules for the store (#574):

- All writes to one file go through one queue (`runInWriteChain`) and
  `writeFileAtomic` (`src/utils/storage/backend.ts`). Every write raises
  `revision` by one and is refused if it was based on an older revision, so two
  admin pages cannot silently overwrite each other. The page then reloads and
  shows the newer state.
- The folder is private to the FLUJO process user (0700 / files 0600 outside
  Windows), like the owner policy file today.
- `accounts/` sits next to `workspaces/`, never inside it, so workspace
  backups, snapshots and exports never include it.
- A broken `accounts.json` falls back to `accounts.json.bak` and logs it. If
  both are broken, the mode counts as on (the file exists), nobody can sign in,
  and requests answer 503 with a plain message. Every request reads again, so
  restoring the file or running `node bin/flujo.mjs users off` heals it without
  a restart. It never falls back to "no sign-in".
- `audit.jsonl` moves to `audit.1.jsonl` (replacing the older one) when it
  passes 10 MiB. A write never fails because the log is big.
- Mode off means: no file, or a valid file with `"enabled": false`.

## People, teams and generations

- A person has an id (`u_` + random), a sign-in name (lower case, unique), a
  display name, a password hash, a role (`admin` or `member`), `hostAccess`,
  `disabled` and a `generation`. People are never deleted, only disabled, so
  owner records and the audit trail keep pointing at someone.
- `generation` goes up by one when the password changes and when the person is
  disabled. A browser session remembers the generation it was made with; a
  different current generation ends it. Role and host-access changes need no
  bump, because every request reads the current role.
- A team has members with a role (`owner` or `member`) and a state (`invited`,
  `member`, `removed`). Only `member` gives access. The team `generation` goes
  up when a member is removed or changes role; #575's edit leases remember it
  and die when it changes.
- While the mode is on there is always at least one active admin. The schema
  refuses a file without one; the server command line is the way back in.

## Passwords

| Topic | Contract |
|---|---|
| Hash | scrypt, N = 2^17, r = 8, p = 1, 16-byte random salt, 32-byte result (`SCRYPT_PARAMETERS`) |
| Stored as | `scrypt-v1$<logN>$<r>$<p>$<salt>$<hash>`, salt and hash in base64url (`PASSWORD_HASH_PATTERN`) |
| Memory | One hash needs about 128 MiB. Node's default limit (32 MiB) is too small, so pass `maxmem: SCRYPT_MAXMEM_BYTES` (256 MiB). A test proves both. |
| Busy server | Hashing runs off the event loop (async `crypto.scrypt`). When many sign-ins arrive at once, they wait in a short queue whose size follows free memory; after a bounded wait the answer is 503 with `Retry-After`, never a lockout. |
| Rules for a new password | 15 to 256 characters, no "must contain a digit" rules, not on a short list of common passwords, not the person's own name |
| Comparing | `timingSafeEqual` on the hash bytes. A sign-in with an unknown name still computes one hash, so timing does not reveal which names exist. |
| Upgrades | Older settings still verify; the next successful sign-in stores a new hash with today's settings. |
| Failed sign-ins | Wait 1 s after the first failure for that name, doubling up to 15 minutes. In memory only: cleared on success or restart, and entries drop once their wait has passed. Never a permanent lockout. |
| Forgotten admin password | `node bin/flujo.mjs users reset-password <name>` on the server. Access to the server machine is the recovery authority. |

## Browser sessions

| Topic | Contract |
|---|---|
| Token | `flo_a1_` + 32 random bytes in base64url (`SESSION_TOKEN_PATTERN`). A new one at every sign-in. |
| Stored | Only the SHA-256 digest, with session id, person, person's generation, start and end time (`accountSessionSchema`) |
| Cookie over HTTPS | `__Host-flujo-session`; `Secure; HttpOnly; SameSite=Lax; Path=/`; no `Domain` |
| Cookie over HTTP (this computer or a local network) | `flujo-session`; `HttpOnly; SameSite=Lax; Path=/` |
| Lifetime | 8 hours from sign-in, no sliding renewal (`ACCOUNT_SESSION_MAX_AGE_MS`) |
| Ends early | Sign-out (record deleted), password change or disabling (generation), turning the mode off (`sessions.json` is emptied) |
| Changes from a browser | Need an `Origin` header that matches the installation's own browser address, the same rule as `ownerBrowserRequestAllowed` today. Forwarded headers are never trusted. |
| Streams (SSE) | Recheck the session every second while open, like `bindOwnerStream`, and close the stream when it is no longer valid |
| Owner policy | The single-owner policy keeps working for single-user installs. While the mode is on, owner sessions are ignored with one clear log line. |

## API tokens

| Topic | Contract |
|---|---|
| Format | `flo_v1_` + 43 base64url characters (`API_TOKEN_PATTERN`), the same as owner tokens |
| Stored | SHA-256 digest in `accounts.json` → `apiTokens`, with id, person, optional label, scopes, issue, expiry and revoke time (`accountApiTokenSchema`). The token is shown once. |
| Sent as | `Authorization: Bearer <token>` only. Never in a query string or cookie. |
| Scopes | The owner policy names (`ACCOUNT_TOKEN_SCOPES` equals `OWNER_SCOPES`, tested): `openai:read`, `openai:execute`, `mcp:access`, `control:admin`, `secrets:read`, `avatar:voice`. Each route needs the scopes `requiredOwnerScopes` gives today. |
| Never more than the person | A token only narrows. Access is "what the person may do" and "what the scopes allow". A member's `control:admin` token still cannot open admin routes. |
| One workspace | A token with `workspaceId` reaches only that workspace's workspace routes; admin, host and account routes refuse it. |
| Expiry | Every token has one. New tokens default to one year; the person may pick a shorter time. |
| Ends | Revoking it (`revokedAt`), its expiry, or disabling the person. A password change does not end tokens: they are separate keys and the token list shows them. |
| Turning the mode on | Owner policy tokens are copied to the first admin with the same id, digest, scopes, times and workspace limit (a test parses a real owner credential as an account token), so scripts and MCP clients keep working. |

## Who is asking, inside the code

- `AccountPrincipal` (in `accounts.ts`) is either a `session` (person, session
  id, generation) or an `api-token` (person, token id, scopes, optional
  workspace). `withWorkspace` builds it once per request from the cookie or the
  `Authorization` header and keeps it next to the workspace in
  AsyncLocalStorage. It is never built from a query, header or body claim; the
  `x-flujo-workspace` header only selects.
- `BackgroundActor` is used for schedules, triggers, personas and waves. They
  act for the workspace owner and store `startedBy` (a person id) when they are
  set up. `decideBackgroundAccess` pauses them when the owner or the person who
  set them up has lost access, and they resume by themselves once access is
  back.
- Protocol routes (OAuth callbacks, webhooks, worker bearer, instance
  challenge) carry no person and keep their own checks.

## Access rules

What each kind of access may do in a workspace (`WORKSPACE_GRANT_ACTIONS`):

| Access | read | edit | run | admin |
|---|---|---|---|---|
| Installation admin (every workspace, also unassigned ones) | yes | yes | yes | yes |
| Personal owner | yes | yes | yes | yes |
| Team owner | yes | yes | yes | yes |
| Team member | yes | yes | yes | no |
| Invited, removed, anyone else, disabled person | no | no | no | no |

The workspace `admin` action covers: setting or changing the workspace
password, showing stored secrets in plain text, credential transfer and
migration, whole-workspace backup and restore, renaming or deleting the
workspace, and giving it a new owner.

Kinds of route (`ROUTE_CAPABILITIES`, 235 routes on 2026-11-25):

| Kind | Count | Who may call it |
|---|---|---|
| `workspace` | 203 | Anyone with access to the selected workspace, for the action of the method (GET/HEAD/OPTIONS read, others edit) |
| `host` | 11 | People with host access (admins, or members an admin trusted), and only in a workspace they may use |
| `admin` | 5 | Admins |
| `account` | 3 | Any signed-in person; the sign-in routes also while signed out |
| `protocol` | 13 | Anyone; the route checks the caller's own proof |

- A path that matches no listed route counts as `admin`.
- `WORKSPACE_ADMIN_ROUTES` (backup, restore, credential transfer and
  migration) need the workspace `admin` action for every change.
- `WORKSPACE_ADMIN_STEPS` lists the admin steps a route only sees in its body
  or query (setting the workspace password, `includeSecrets=true`, renaming or
  deleting a workspace). Those handlers ask for `admin` themselves.
- Unknown and forbidden workspaces both answer 404. The workspace is checked
  before host access, so a guess never learns more than "not found".
- Denials map to HTTP status in `ACCESS_DENIAL_STATUS`: 401 to sign in again,
  404 for workspaces, 403 for everything else.

Starting a program on the server is also checked where it starts, because a
workspace route can lead there: a local (stdio) MCP server outside a container
(`src/backend/services/mcp/connection.ts`), the command-line model adapters
(`claudeOwnedProcess.ts`, `codexAppServerProcess.ts`,
`antigravityCliProcess.ts`), installing an MCP server from GitHub
(`githubInstall.ts`), the system screenshot tool (`systemScreenshot.ts`) and the
owner's native tools (`originalOwner/nativeToolEffects.ts`). In multi-user mode
each needs host access for the person behind the request, or for the workspace
owner when background work starts it (#574, step 574-4).

## Encryption keys: how each person's secrets are protected

1. **No new encryption.** Each workspace keeps its own keyring in
   `db/encryption_key.json` (AES-256-GCM, see
   [workspace secret encryption](../../src/utils/encryption/README.md)).
   Turning the mode on or off rewrites no secret and no key; #574 proves it by
   comparing every file under `workspaces/` byte for byte.
2. **Personal secrets stay in personal workspaces.** A person's provider keys
   are stored in their own workspace. Other people cannot reach them because
   every route that can use or show a secret is a `workspace`, `host` or `admin`
   route, and the access rules answer 404 for someone else's workspace.
3. **The accounts folder holds nothing that turns back into a secret.**
   Passwords are scrypt hashes; session and API tokens are SHA-256 digests. It
   holds no workspace keys.
4. **The sign-in password is not the workspace key.** Nothing is derived from
   it. Reasons: an admin can reset a forgotten sign-in password without losing
   anyone's stored secrets, and scheduled runs keep working while the person is
   signed out. Encryption code and data stay exactly as today.
5. **Workspace password (optional, today's "user" mode).** It protects stored
   secrets from someone who copies the data folder. Setting or changing it needs
   the workspace `admin` action. Unlocking needs access to the workspace and the
   password. Unlock state is per workspace already, so unlocking a team
   workspace unlocks it for its members, which is intended.
6. **The 2-hour unlock token is not an identity.** It only works inside the
   workspace that issued it (true today), and the access check runs before it is
   looked at.
7. **Team workspaces.** Members use the team's secrets in runs but always see
   `********`. Only the workspace `admin` action shows plain text
   (`REVEAL_SECRETS_ACTION`). A personal key never moves into a team workspace by
   itself.
8. **Copying into a team (#575).** Copies never carry ciphertext or keys from
   one workspace to another (the team keyring could not read them anyway). An
   allowlist removes secret fields, and the copy lists each missing value so the
   person enters it in the team workspace.
9. **Honest limits.** Without a workspace password the key is protected by a
   published password: that hides secrets from casual reading, nothing more.
   Anyone with host access, an admin, or anyone who can log in to the server
   machine can read every workspace. Multi-user mode keeps people apart inside
   FLUJO; it does not protect anyone from the server's operator. Public hosting
   for strangers is not supported.
10. **Backups and workers.** Workspace backups contain that workspace's keyring
    and secrets (as today) and never `accounts/`. A restored workspace belongs to
    the person who restored it; no sessions, tokens or grants come back with it.
    Worker snapshots still carry the unlocked keyring and stay behind the worker
    bearer (`protocol` routes).
11. **Logs.** Logs and `audit.jsonl` never contain passwords, tokens or
    secrets. Audit details are short facts (`auditEventSchema`).

## Sources

- OWASP Password Storage Cheat Sheet: scrypt with N ≥ 2^17, r = 8, p = 1.
- NIST SP 800-63B-4: at least 15 characters for a single-factor password, no
  composition rules, a blocklist, allow at least 64 characters.
- OWASP Session Management Cheat Sheet: at least 64 bits of randomness (we use
  256), `HttpOnly`, `Secure`, `SameSite`, the `__Host-` prefix, a new id at
  sign-in, an absolute timeout.
- n8n personal and team "projects": the same "workspace is the unit of
  ownership" shape.
- No new library: see the "Libraries" row in the plan's Decisions table.

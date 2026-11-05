# Named access: security contract

Builds on [owner access](owner-access-v1.md) and
[owner browser sessions](owner-browser-session-v1.md). The user guide is
[named access](../features/named-access.md). This reaches **Tier 0 and part of Tier 1 of
#212**; [what stays open](#what-stays-open) is listed at the end.

## Off unless switched on

`FLUJO_OWNER_AUTH_FILE` unset: nothing here runs and an ordinary install behaves as
before. A schema 1 policy also behaves as before: exact legacy scopes, whole-file
revisions, no owner recorded, no record written. Named access is on only when the
policy has `schemaVersion: 2`. An older FLUJO refuses schema 2 and fails closed, so it
can never read a narrow credential as a broad one.

## Scopes and roles

Scopes stay exact: no wildcard, no implied scope. Schema 2 adds narrow ones to the
existing six. The existing scopes could only say "everything" or "the OpenAI routes",
so they could not express a role on their own.

| Scope | Allows |
| --- | --- |
| `session:login` | Exchange the secret for a browser session |
| `health:read` | `GET /api/operations/status`, `GET /api/update` |
| `update:manage` | `POST /api/update` |
| `flows:read` / `flows:write` | Read / change flow definitions |
| `models:read` | `GET /api/model` (keys masked) |
| `runs:read` | Read own conversations, resources and running work |
| `runs:all` | With `runs:read`: every person's, instead of only own |
| `runs:manage` | Rename, cancel or delete own conversations |
| `approvals:respond` | Answer approvals on own runs |
| `access:manage` | Manage people |
| `audit:read` | Read the record |

`control:admin` with `secrets:read` still opens every route and sees every row.

Presets are in `src/shared/types/access.ts`. A record naming a preset must hold exactly
that preset's scopes, or the whole policy is refused.

## Every route is closed unless listed

`src/backend/services/security/accessRoutes.ts` is the only list of what a narrow
credential can reach. Anything else, including any route added later, keeps the
conservative administration requirement. A near miss (other method, trailing path,
other case, encoded separator) falls back to administration.

An explicit scope list passed to `resolveOwnerRequest` stays exact, so special handlers
cannot be widened by the table.

`__tests__/security/namedAccessRoutes.test.ts` walks every route file and proves:
every route lies under a prefix the proxy guards, every table entry names a real route
and method, every role is admitted exactly where the table says and refused everywhere
else, and every route naming a conversation goes through the workspace wrapper.

### What a narrow credential cannot reach

On purpose, these stay with administrators: MCP setup and tools (`/mcp-proxy`,
`/mcp-flows`, `/api/mcp/**` except server names), `/api/git`, backup and restore, file
browsing, environment and encryption, packages, planned executions and their runs,
meetings, Personas and roles, statistics, the global event stream
(`/v1/chat/events`), conversation chains, bulk conversation delete, and the debug,
edit-state, inject, revert, model-turn and wire-preview sub-routes of a conversation.

### Flow editing is not all of `/api/flow`

Builders reach read, create, update and delete. The helper routes (generate, assist,
improve, repair, model-agent, prompt-renderer, compile, quick-chat) stay with
administrators, because they call models or can render bound values.

## Separation between people

At creation a conversation records `accessOwner: { credentialId, endUser? }`. It is
written once, on a new conversation only, and passed as an explicit value. It is never
read from the request body and never from ambient context inside the engine, so
background work that first wakes up during a request cannot inherit an owner.

The workspace wrapper checks the row before a handler runs on every route that names
a conversation or approval, so reading, deleting, streaming, resources and answering
share one check. Someone else's id and an id that does not exist get the same 404, so
ids cannot be probed. Refused attempts are recorded.

List routes filter their own results:

- `GET /v1/chat/conversations` narrows the one file list all its branches use, so
  paged, full, presence and content search cannot disagree.
- `GET /api/runs/active` and `GET /api/approvals` skip other people's rows entirely,
  including pending questions.

Other rules for narrow credentials:

- `/v1/chat/completions` refuses another person's `conversation_id`, whichever field
  carries it.
- `POST /v1/chat/conversations` refuses an id that already exists, because that route
  overwrites.
- `PATCH` on a conversation accepts only `title`, because `flowId` or `requireApproval`
  would step around a limit.
- `processNodeId` and debug mode need `flows:write`, because they skip what a flow
  decides.
- Persona targets are refused.
- Persona-owned conversations are invisible to everyone except administrators.

Runs nobody started through a named credential (automations, webhooks) have no owner,
so only `runs:all` and administrators see them, and only they can answer their
approvals. **Conversations from before the switch have no owner either** and are hidden
from narrow credentials the same way.

Child runs inherit the owner of their parent.

## Flow limits

`flowIds` guards the entry points: starting a flow, continuing a conversation, and
creating one. It requires a workspace, because flow ids are unique only within one.

**Decision on subflows: a subflow reached from an allowed flow runs.** The builder of
the allowed flow chose it, and refusing it mid-run would break the flow. It cannot be
started directly by that credential. A flow limit is therefore not a sandbox: it says
which flows a person may start, not what those flows may do.

Combining `flowIds` with a scope that reaches past one flow is refused rather than half
kept. Allowed: `openai:read`, `openai:execute`, `runs:read`, `runs:manage`,
`approvals:respond`, `session:login`. Everything else, including `flows:read` and
`runs:all`, is refused.

## Workspace limits

`workspaceId` binds a narrow credential to one workspace. The wrapper refuses any other
selection, and `/api/workspaces` lists only that one. Administration, secrets, MCP
access and updates reach the whole installation, so binding them is refused.

## Managing people

`/api/owner/people` (GET, POST), `/api/owner/people/[id]` (PATCH, DELETE),
`/api/owner/me`, `/api/owner/access` (GET, POST to switch on), `/api/owner/audit`.

- The plain secret is in the POST response only, with `Cache-Control: no-store`. The
  policy holds a SHA-256 digest of 32 random bytes. Secrets never go in logs, URLs or
  the record.
- Every change is one atomic file replacement under a lock shared with the local tool.
  A lock left by a crash is taken over after 30 seconds. A busy lock answers 503 after
  3 seconds and the caller retries.
- The last good policy stays beside the current one as `<policy>.previous`.
- The last active administrator cannot be revoked, expired or demoted.
- Without administration, nobody can grant a scope they do not hold, touch a person
  holding more than they do, change their own access, or reach outside their workspace.
- The list holds at most 128 people and 64 KiB. Entries ended over 30 days ago make
  room first, then the oldest ended entry. If all are active the answer is
  `POLICY_FULL`, and revoking someone clears it without a restart.

## Browser login

The existing contract allows it with one change: besides an administrator, a credential
with `session:login` in a schema 2 policy may exchange its secret for a session.
Everything else in that contract holds. The session's scopes are read from the record
on every request, so it never holds more than the credential behind it. An
execution-only credential still cannot mint a session, and `health` has no browser
login.

A narrow role gets the same application shell and is refused on the routes it lacks.
Which screens stop working is [listed below](#what-stays-open).

## What invalidates what, in schema 2

Requests, streams and browser sessions are pinned to that person's own record, without
its display name. Adding, renaming or revoking someone else disturbs nobody. Owner-level
approvals (bundled MCP consent, original-owner administration) are pinned to the set of
administrators, so adding an operator does not cancel them, but adding or changing an
administrator does.

Turning named access on migrates browser sessions once. It also changes the revision
owner-level approvals are pinned to, so those need approving again.

## The record

JSON lines beside the policy (`<policy>.audit.jsonl`, rolled to `.1`), so outside any
workspace. Holds time, action, outcome, credential id and name, end-user reference,
target id and workspace. Never a secret, URL, query, message, prompt or tool argument.
A failed write is logged and shown on the page but never blocks the action, because the
instance must keep working.

Actions: `login`, `logout`, `access.enable`, `person.create|update|revoke`,
`flow.create|update|delete`, `approval.decide`, `access.denied`, `access.recover`.

**It is a record, not tamper-proof evidence.** Anyone with this computer's files can
edit it. Flow changes made outside the flow routes (MCP tools, Persona composition,
restoring a backup) are not attributed.

## Recovery

`scripts/owner-access.mjs` works on local files and has no HTTP surface: `enable`,
`recover`, `restore`, `export-v1`. Control of the files is the authority, as in
[first-owner pairing](first-owner-pairing-v1.md). New secrets go into a private file
named in the output, never to stdout, so they stay out of terminal history and
provisioning logs.

A corrupt policy fails closed with 503 and refuses startup. `recover` moves it aside
rather than deleting it.

## Limits to be honest about

- **Not isolation.** All flows run in one process with the same operating system
  account. A role limits what a person can ask FLUJO to do through its routes. It does
  not limit what the flows they run may do. Workspaces remain logical namespaces, not
  security boundaries: a flow in one site's workspace using a shell tool can read
  another site's files. For sites that must be separated against each other, use
  separate instances.
- **A builder is powerful.** A builder can build a flow that uses any installed MCP
  tool, including a shell tool if one is installed, and can run it. Treat `flows:write`
  as close to administration on a machine with such tools. A prompt can also use a
  bound `${global:...}` value, so a builder may be able to get a flow to reveal it.
- **Approval is partly the caller's setting.** `metadata.requireApproval` is up to the
  caller of `/v1`, as before. Rules built into a flow hold regardless.
- **An operator may call models directly** if the workspace allows direct model calls.
  Use a flow limit or the workspace switch to prevent it.
- **The end-user reference is a label.** FLUJO trusts the calling credential to state it.
- **`health` sees ids.** `GET /api/operations/status` holds conversation and flow ids,
  but no content.
- **`GET /api/update` fetches from the remote repository** on a git install.
- **Windows ACLs are not set for you.** As with the existing policy, restrict the policy
  folder to the owning account yourself. The Windows checks do not establish an OS
  keystore.
- **Rate limits are per address, not per person.**

## What stays open

Of #212 this delivers Tier 0 (roles, secrets, people, record) and the parts of Tier 1
that a credential can carry (per-person conversations, runs and approvals, flow and
workspace limits).

Still open:

- Teams and shared editing with locks.
- Per-person containers or any real isolation between people. Draft #1233 explores this
  with owner containers and local HTTPS. It is left untouched, and nothing here depends
  on it.
- Passwords, single sign-on and multi-factor sign-in. A person signs in with their secret.
- Secrets per person. Models and MCP keys remain shared.
- Sharing a single conversation with a specific person.
- A complete screen set for narrow roles. The builder, chat history and other screens
  call routes a narrow role may not reach, so parts of the application show errors for
  them. Normal staff are expected to work in your own product through the API.
- Flow changes made outside the flow routes are not in the record.
- More than 128 credentials on one instance.

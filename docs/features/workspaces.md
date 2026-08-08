# Workspaces

Workspaces (issue #406) give one FLUJO installation several independent sets of
data. Each workspace has its own flows, models, conversations, MCP servers,
planned executions and settings; no workspace-owned application data is shared
between them. Process-level controls such as update checks, network exposure,
telemetry and workspace discovery remain installation-wide because they do not
contain workspace user data.

A workspace is a **logical namespace inside the existing data root**, not a
second installation. There is still one FLUJO process, one application install
and one `FLUJO_DATA_DIR`.

## On-disk layout

```text
<FLUJO_DATA_DIR or app root>/        # the data root — unchanged meaning
  workspaces/
    .workspace-layout.json           # migration marker (see below)
    default-workspace/
      db/
      mcp-servers/
      userdata/
      snapshots/
      screenshots/
      recordings/
      browser-profile/
      bash-utils/
      artifacts/
    <other-workspace>/
      db/
      mcp-servers/
      userdata/
      snapshots/
      screenshots/
      recordings/
      browser-profile/
      bash-utils/
      artifacts/
```

All writable application state lives below the selected workspace: models,
flows, conversations, automations, global environment variables and settings in
`db/`; installed MCP servers in `mcp-servers/`; user files and generated runtime
data in the remaining roots. Shipped MCP package code remains with the read-only
application installation, but every shipped server receives the selected
workspace as its `FLUJO_DATA_DIR`.

There is no application-owned top-level `outputs/` directory. Run outputs are
stored by the run-resource services inside the workspace database; the legacy
top-level `artifacts/` root is nevertheless migrated so older installations do
not strand generated files.

`FLUJO_DATA_DIR` keeps its previous meaning: it is the **parent** root that
contains `workspaces/`. Docker volumes, `npx flujo` and packaged installs need no
configuration change.

## Migration from a pre-workspace install

On the first start after upgrading, `migrateWorkspaceLayout()` starts immediately
and remains an awaited storage barrier before providers, storage verification,
the sandbox, MCP startup and the scheduler. The static application shell is
allowed to render while that barrier runs, so the browser shows migration status
instead of hanging on an accepted TCP connection. Workspace-sensitive requests
share the readiness promise; workspace discovery returns a retryable `503` with
`WORKSPACE_LAYOUT_PREPARING` and the shell polls it until completion, so no data
request can race the old layout.

Migration progress is always visible in the server console in runtime builds.
An attached terminal gets a colored FLUJO riverside title card, an animated
current step with a small running companion, durable phase milestones and
aggregate file, directory, link and byte counts. Narrow terminals use a compact
version. Redirected output, CI, services and containers without a TTY retain the
line-oriented transcript so log collectors never receive cursor-control noise.
Set `FLUJO_MIGRATION_UI=plain` to disable the terminal interface or
`FLUJO_MIGRATION_UI=tty` to force it; `FLUJO_MIGRATION_ASCII=1` replaces Unicode
status symbols, and the standard `NO_COLOR` setting disables color. The output
identifies recovery and transaction checkpoints and ends with an explicit
success or fail-closed line. It intentionally does not print individual
filenames, which keeps secrets out of logs while making a long first upgrade
observable.

Layout v2 inventories every legacy root and destination before renaming any user
data. It recursively overlays disjoint paths, which safely recovers installs
left half-copied by an older build. An overlapping file, directory or symlink is
accepted only when its type, SHA-256 content (for files) or relative target (for
links), and permission mode are identical. Any differing overlap aborts before
mutation. Stable hardlinks are opened without following links, verified against
their filesystem identity and materialized as independent files, so migration
never mutates data through an outside alias.

The database overlay includes all historical locations: `db/`,
`.next/storage/` and `storage/`. The migration also covers `mcp-servers/`,
`userdata/`, `snapshots/`, `screenshots/`, `recordings/`, `browser-profile/`,
`bash-utils/` and `artifacts/`. In source checkouts, shipped MCP code is preserved
while runtime-installed MCP directories move. Runtime screenshots/profile data
written by older browser-server builds beneath
`mcp-servers/browser/userdata/` is mapped into the corresponding workspace root.

The complete transaction is staged under a random transaction directory,
content-verified, fsynced and atomically published. A cross-process lock has an
owner token and heartbeat; a live same-host process is never evicted, while an
expired/dead owner is recoverable. Workspace roots, metadata and managed source
roots may not be symlinks or junctions. Internal links are treated as opaque and
accepted only when unbroken and canonically contained by the managed root.
Absolute in-tree Windows junctions (including npm workspace links) are rebased
onto the published workspace; broken or external links fail closed. Descendant
mount points—including same-device Linux bind mounts discovered through
`/proc/self/mountinfo`—also fail during preflight, before anything is renamed.

The durable journal makes every checkpoint retryable from filesystem truth. Old
sources and an existing destination are retained as transaction-specific backups
until the new destination is verified and `workspaces/.workspace-layout.json` is
durably published. Cleanup then verifies the destination again and deletes only
the exact tokenized backups. If a legacy Docker/bind-mount root cannot be renamed
(`EXDEV`/`EBUSY`), it stays intact through marker commit and cleanup removes only
its inventoried children, leaving the empty mountpoint in place. File access and
modification timestamps are journaled and restored after copying, so legacy flow
ordering based on `mtime` survives migration and crash recovery.

A crash at any checkpoint resumes the same transaction. A current marker does
not blindly hide legacy data left by an older binary: startup reconciles any
non-empty legacy roots in a new transaction. Corrupt, unreadable, unsupported
future markers and tampered journals fail closed without overwriting either copy.

**Operator recovery from a conflict:** back up every named location, resolve the
specific differing path or unsafe filesystem object, and retry. Do not delete the
journal or transaction backups: they are the recovery record.

## Selecting a workspace

### API

Every workspace-sensitive endpoint accepts an **optional** `workspace` query
parameter (or an `x-flujo-workspace` header):

```http
GET /v1/chat/conversations                      # default-workspace
GET /v1/chat/conversations?workspace=research    # the "research" workspace
```

| Situation | Response |
| --- | --- |
| parameter omitted | uses `default-workspace` — identical to pre-#406 behaviour |
| syntactically invalid name | `400` |
| valid name, no such workspace | `404` (workspaces are never created implicitly) |

Workspace names are **identifiers, not paths**. They must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, which excludes `.`, `..`, separators, drive
letters, UNC prefixes, whitespace, control characters and percent-encoding. The
resolved directory is additionally containment-checked against `workspaces/`.
Windows device names (`CON`, `NUL`, `COM1`, and so on), case-only aliases and
symlink/junction workspace roots are rejected on every platform.

`GET /api/workspaces` lists the workspaces that exist on disk, with a
deterministic color per workspace:

```json
{
  "workspaces": [
    { "name": "default-workspace", "color": "#6656E8", "isDefault": true },
    { "name": "research", "color": "#2E9E5B", "isDefault": false }
  ],
  "defaultWorkspace": "default-workspace"
}
```

### UI

When more than one workspace exists, colored workspace tabs appear in the navbar
(and as a chip row in the mobile drawer). The selection is persisted per browser
under `flujo-ui:workspace` and is attached automatically to every same-origin
`/api/...` and `/v1/...` request. Switching reloads the page so no cached record
from the previous workspace can survive the switch. If a persisted workspace no
longer exists, the UI falls back visibly to `default-workspace`.

## Creating and removing workspaces

Issue #406 covers the namespace, the migration and the tabs. Creating, renaming
and deleting workspaces through the UI/API is **not** part of it. A workspace is
created by making the directory:

```bash
mkdir -p "<data root>/workspaces/research"
```

FLUJO creates the complete runtime directory set shown above when it initializes
the workspace. At process start it initializes every discovered workspace
sequentially, so schedules and webhooks are armed even when no browser tab opens
that workspace. Restart FLUJO after creating a workspace directory so its
background MCP and automation services join that startup sweep. One workspace's
service failure is isolated from the others.

## Backup and restore

Backup and restore operate on **one** workspace: the selected one. A backup
archive can never contain another workspace's files, and restore refuses archive
entries that would escape the target workspace.

New archives record `workspace` and `workspaceLayoutVersion` in
`backup-info.json`. Legacy archives that lack those fields restore into the
selected workspace, which for an untouched client means `default-workspace` —
exactly where their data used to live.

Aggregate multi-workspace export/import is deliberately out of scope.

## Notes for contributors

- Use `getWorkspaceDataDir()` (from `src/utils/workspace.ts`) for anything that
  belongs to a workspace — including databases, MCP runtime installs, userdata,
  profiles and generated media. Use `getDataDir()` only for installation-wide
  layout metadata and migration sources.
- Never capture a workspace path in a module-level constant. The workspace is
  per-request ambient context (`AsyncLocalStorage`); a constant pins the whole
  process to whichever workspace loaded the module first.
- Any process-wide cache, write chain or registry keyed by an id that is only
  unique *within* a workspace (conversation id, MCP server name, KV scope) must
  include `workspaceCacheKey(...)`, or one workspace will serve another's data.
- Callbacks that outlive the request (timers, watchers, event listeners) must
  re-establish their workspace with `runWithWorkspace()` or
  `bindToCurrentWorkspace()`.
- New workspace-sensitive routes should be wrapped with `withWorkspaceRoute`
  from `src/app/api/_workspace.ts` rather than parsing the parameter themselves.

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

Each workspace can also own a list of backend filesystem folders. Use **Edit
workspace** in the workspace menu to add or remove them. The list is stored in
`.workspace.json` inside the managed workspace directory and is inherited by
every MCP server at runtime through `roots/list`; individual server and flow-node
roots remain additive. Editing the list does not rewrite server configuration or
restart processes: connected servers receive `notifications/roots/list_changed`
and the next roots request resolves the current workspace list.

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
data in the remaining roots. The application retains the canonical shipped MCP
packages for development, packaging and updates. New workspaces receive separate
copies of those packages and run their copies; every shipped server receives the
selected workspace as its `FLUJO_DATA_DIR`.

### Built-in MCP packages

The canonical packages stay in `<application>/mcp-servers/`. Creating a workspace
copies the distributed package files into its own `mcp-servers/` directory.
A Git development checkout includes source and build inputs; an npm installation
can copy only the compiled assets and other files included in its distribution.
The app's bundled MCP build must succeed before creating runnable copies.

Package code and artifacts are independent copies. Installed dependencies remain
shared through managed links resolved from the installation's actual Node package
search paths: one `node_modules` directory link for a common dependency root, or
individual package links for mixed hoisting.
This resolves ESM imports even when `FLUJO_DATA_DIR` is outside the repository,
without a background npm install or browser download. It does not create a
process or dependency security boundary.

Startup preserves existing workspace package files, including edits and older
versions. Updating the application changes the templates for future copies;
it does not silently overwrite workspace edits. Shipped launch records use
workspace-relative paths so renaming a workspace does not leave its servers
pointing at the old directory. User-owned configurations keep their own paths.

For managed workspace copies, snapshot worker preparation reconstructs ordinary
built-ins from the target installation and verifies the required package assets
against provenance and runtime hashes. This does not prove identical dependency
trees; legacy app-root transfer plans retain their existing behavior. Edited or
unverifiable workspace package code must be packaged explicitly before transfer;
the snapshot path must not silently substitute different code. Dependencies are
prepared on the destination, not transferred as links to the source computer.

Managed MCP children also receive an internal `FLUJO_PARENT_DATA_DIR` marker
containing the installation data root. MCP packages continue to use their
workspace-scoped `FLUJO_DATA_DIR`; the marker matters only if a child command
launches FLUJO again. Command-spawning packages pass that marker together with
`FLUJO_WORKSPACE`; in that case FLUJO prefers the marker, preventing the
workspace path from being misread as a new parent and expanded into recursive
`workspaces/<workspace>/workspaces/<workspace>` trees. Operators should
continue setting only `FLUJO_DATA_DIR`.

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
A color-capable interactive terminal at least 56 columns by 18 rows opens the
full-screen, slow-scrolling FLUJO riverside landscape by default; its HUD uses
real migration telemetry. Pressing `Q` or `Esc` restores the terminal and lets
the same migration continue with a durable, line-oriented transcript. Pipes,
CI, services, dumb terminals and containers without a TTY select that transcript
automatically so log collectors never receive cursor-control output.

The transcript reports every inventory, recovery and transaction checkpoint,
including aggregate file/directory/link/byte counts and measured processing
time, without printing individual filenames. `FLUJO_MIGRATION_UI=plain`
selects it explicitly. `FLUJO_MIGRATION_UI=compact` (or `tty`) selects the
compact animation, `FLUJO_MIGRATION_UI=landscape` forces the landscape when the
terminal supports it, `FLUJO_MIGRATION_ASCII=1` selects compact ASCII, and the
standard `NO_COLOR` setting disables color and the full-screen scene.

The current layout mover prefers directory renames and merges populated
destinations when necessary. For legacy data collisions, source files replace
destination files; this is not a conflict-preserving transactional overlay.
Keep a backup of legacy data when operating on an installation that has both
populated layouts.

The database overlay includes all historical locations: `db/`,
`.next/storage/` and `storage/`. The migration also covers `mcp-servers/`,
`userdata/`, `snapshots/`, `screenshots/`, `recordings/`, `browser-profile/`,
`bash-utils/` and `artifacts/`. In source checkouts, shipped MCP code is preserved
while runtime-installed MCP directories move. Runtime screenshots/profile data
written by older browser-server builds beneath
`mcp-servers/browser/userdata/` is mapped into the corresponding workspace root.

Application and data roots are compared after filesystem resolution, so an
application-root junction or symlink alias does not make bundled source packages
look like legacy user data. The base `bash`, `browser`, `filesystem`, `flujo` and
`shared` packages, README and build helper remain in the application directory.
Managed workspace directories themselves must still be real directories.

The mover records outcomes and errors in `workspaces/.workspace-layout.json`.
A completed marker skips further folder moves on later starts. The previous
transaction journals, heartbeat locks and Python rename helpers are no longer
part of this mover; their obsolete artifacts are cleaned up. Do not infer
transactional rollback or mid-move crash recovery from the marker. Inspect the
recorded paths and errors before manually repairing an interrupted migration.

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

Use the **Workspaces** menu to create, edit or delete a workspace. The API supports
`POST /api/workspaces` with `{"name":"research"}`, `PATCH` with
`{"name":"research","newName":"research-next"}`, and `DELETE` with
`{"name":"research"}`. Creation prepares workspace directories and independent
copies of the shipped MCP packages. Editing can also update the workspace's
shared folder roots. The default workspace cannot be renamed or deleted;
deleting another workspace permanently removes its files. Creating or switching
workspaces reloads the UI, and deleting the selected workspace returns it to the
default workspace.

Administrators can also create a directory manually:

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

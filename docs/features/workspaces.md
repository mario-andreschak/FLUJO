# Workspaces

Workspaces (issue #406) give one FLUJO installation several independent sets of
data. Each workspace has its own flows, models, conversations, MCP servers,
planned executions and settings; nothing is shared between them.

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
    <other-workspace>/
      db/
      mcp-servers/
      userdata/
```

Everything that used to live at `<data root>/db`, `<data root>/mcp-servers` and
`<data root>/userdata` now lives one level deeper, inside a workspace.

`FLUJO_DATA_DIR` keeps its previous meaning: it is the **parent** root that
contains `workspaces/`. Docker volumes, `npx flujo` and packaged installs need no
configuration change.

## Migration from a pre-workspace install

On the first start after upgrading, `migrateWorkspaceLayout()` runs before
storage verification, MCP startup and the scheduler — so nothing ever opens a
legacy path once the move has begun. Each of `db`, `mcp-servers` and `userdata`
is migrated independently:

| Legacy directory | Workspace directory | Result |
| --- | --- | --- |
| missing | — | created empty (fresh install) |
| has data | missing/empty | moved (rename, or verified copy across volumes) |
| empty | exists | leftover removed (already migrated) |
| missing | exists | nothing to do (already migrated) |
| has data | has data | **startup fails with a conflict error** |

FLUJO never merges and never overwrites. When both the legacy and the workspace
location contain data — for example after a partially manual move — startup
stops with a message naming both paths.

**Operator recovery from a conflict:** decide which copy is authoritative, back
up the other, then remove (or empty) the losing directory and start FLUJO again.
The migration is safe to retry: it is idempotent, and a failure leaves the source
data in place.

Completion is recorded in `workspaces/.workspace-layout.json`. While that marker
records the current layout version, startup skips the migration entirely.

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

FLUJO creates `db/`, `mcp-servers/` and `userdata/` inside it the first time the
workspace is used, connects its MCP servers and arms its triggers — no restart
required.

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
  belongs to a workspace — `db/`, `mcp-servers/`, `userdata/`, snapshots,
  screenshots. Use `getDataDir()` only for installation-wide concerns.
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

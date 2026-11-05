# Disk space and logs on a small PC

## Logs

An instance set up with `flujo service` writes to `<root>/logs/flujo.log`. At
`FLUJO_LOG_MAX_BYTES` (default 20 MiB) that file moves to `flujo.log.1`, older ones
move up, and anything past `FLUJO_LOG_MAX_FILES` (default 3) is removed. So the limit
with default settings is 80 MiB.

Without `flujo service`, output goes wherever the program that started FLUJO sends
it, and that program has to limit it.

## Warnings

`GET /api/operations/status` has a `disk` block and raises these in `alerts`. They
only warn. **Nothing is ever deleted because of them.**

| Alert | Meaning | Setting |
| --- | --- | --- |
| `disk-space-low` | Free space on the data disk is below the limit | `FLUJO_DISK_LOW_BYTES` (2 GiB), `FLUJO_DISK_LOW_PERCENT` (5). The lower of the two applies |
| `data-growing-fast` | The data directory grew faster than this per day | `FLUJO_DATA_GROWTH_WARN_BYTES_PER_DAY` (1 GiB, `0` for off) |
| `disk-space-unknown` | Free space could not be read. Information only | |

`daysUntilFull` is a rough estimate from recent growth. Growth is only reported once
there are measurements at least 6 hours apart, so one big import does not look like a
trend. The data directory is measured at most once an hour, in the background, and
that stops after 500,000 entries or 5 minutes, in which case that measurement is not
used for growth. A status request never waits for it.

## What grows

Checked in the source on 2026-11-05. "Limited" means something removes old entries
without anyone doing anything.

| What | Where | Limit |
| --- | --- | --- |
| Conversations and their archives | Workspace data | **None yet.** Being built separately (retention periods) |
| Log output | `<root>/logs` with `flujo service`; otherwise your supervisor | Limited with `flujo service` |
| Versions and data copies from `flujo update` | `<root>/versions`, `<root>/backups` | Limited: last two of each. Each copy is the size of the data |
| Statistics | Workspace data | Limited: 90 days |
| Run history per schedule | Workspace data | Limited: newest 100 |
| Run resources, detached subflow tasks, remote MCP tasks | Workspace data | Limited: hourly sweep |
| Snapshots | Workspace data | Limited: hourly cleanup by its retention policy |
| Persona runtime events and leases | Workspace data | Limited: retention sweeps. Lease history pruning is off by default |
| Meeting event logs | Workspace data | **None found** |
| Installed MCP servers and their `node_modules` | Workspace `mcp-servers` | **None.** Grows with what is installed, not over time |
| npm cache, from npx-based MCP servers | The user's npm cache | **None.** npm does not trim it by itself |
| Node versions from `--update-node` | `~/.flujo/node-runtimes` | **None.** Grows only when Node is updated |
| Instance records left after a hard stop | `~/.flujo/instances` | Limited with `flujo service`: its own stale records are removed. Very small either way |
| Browser profiles of the browser MCP server | The server's own home | **Not checked** |

The biggest risk on a small PC is the data copy. Every `flujo update` needs free space
for a full copy of the data, keeps two, and refuses to start without room for one.

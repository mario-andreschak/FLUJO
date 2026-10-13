# Production operations: private installation and worker diagnostics

`GET /api/operations/status?workspace=<name>` gives an authenticated, bounded
metadata sample for one workspace. The CLI below records it without executing a
flow, reconciling a scheduler, accepting an approval, starting an MCP server,
clearing recovery uncertainty or repairing storage.

This is a source implementation for #570. Qualification of an exact released
artifact, upgrade/rollback drills, a non-author operator and the independent #564
scorecard review remain required. Shared deployment design #573 is proposed;
#574/#575 and #212 do not become supported through this diagnostic endpoint.

## Choose and record the installation

Record the release version, full source revision, artifact URL, independent
artifact digest/integrity, OS/architecture, Node version, deployment profile,
workspace and protected data-root location. Retain the prior artifact and a
verified pre-upgrade backup. A mutable `latest` tag or a runtime's revision field
does not identify the exact bytes that were installed.

| Profile | Launch and persistent storage | Qualification still needed |
| --- | --- | --- |
| npm, Windows or Linux | Use an explicitly pinned `flujo-ai` version with a Node runtime admitted by that package's `engines` (`^22.17.0` or `^24.2.0` in this source). The installed `flujo` command accepts `--no-open --port 4200`; set `FLUJO_DATA_DIR` to a dedicated protected directory. Retain npm's SRI and the source/release mapping. | Exact package startup, owner authentication, diagnosis, upgrade and restored-data checks on both OS profiles. |
| Windows stable installer | Use the exact versioned release asset and verify its digest. Retain its installation manifest and revision/channel. Keep application checkout and `FLUJO_DATA_DIR` separate; run as the installation's dedicated user. | Networked bootstrapper plus runtime upgrade/rollback on a non-author machine. A script fetched from `main` is a development-channel install. |
| Linux source installation | Check out the pinned commit in a dedicated application directory, use its lockfile with `npm ci --include=dev`, build once, and supervise `npm start -- --hostname 127.0.0.1 --port 4200` under the installation account. Keep the complete data root outside the source checkout. | Exact source/build mapping, service stop/restart, descendants, browser/MCP dependencies and distribution-specific service integration. |
| Container, Windows/Linux Docker host | Pull an independently recorded immutable image digest. Run its non-root application user and mount the complete `/app/data` root. Bind both application and MCP Apps listeners to host loopback unless the authenticated ingress profile has been qualified. | Exact image, platform, mounts, OS enforcement, resource limits, MCP grant/removal, reboot and recovery. Image labels and self-reported revision alone are insufficient. |
| Persistent worker | Use the existing encrypted snapshot bootstrap and dedicated worker bearer, selected workspace and persistent complete data root. Add recovery ID/epoch only for the supported worker-local cron profile. | Actual bootstrap, opted-in recurring effect, kill/restart, copied-sibling suppression, stale authority, retained approval and original-effect observation. |

For a new container installation, the persistent mount is one named volume at
`/app/data`, not just `/app/data/workspaces`. Installation-local state such as
`.worker-local-recovery`, local-instance registration and independently protected
key material can live outside the workspace subtree. Never share that volume or
its authority with another independently active worker. Existing nested legacy
Compose volumes need an explicit inventory and stopped, verified migration;
adding an empty parent mount does not combine their data automatically. Docker
documents [volume persistence and backup](https://docs.docker.com/engine/storage/volumes/).

Run a container without privileged mode, host filesystem roots or the host Docker
socket. Select mounts, egress, capabilities, memory/CPU/PID limits and log
rotation for the actual MCP/browser workload, then test those exact settings.
Failure of an isolated MCP profile must remain a failure, without a trusted-host
downgrade. These are deployment requirements, not evidence that a sample Compose
file passes them. See [Docker's daemon and capability security guidance](https://docs.docker.com/engine/security/)
and the [MCP isolation contract](../security/mcp-isolation-v1-evidence.md).

On Linux, protect the installation's private root and files with its account and
0700/0600 permissions. On Windows, verify owner-only DACLs and ownership;
`chmod(0600)` does not establish those Windows permissions. The local launcher
has a Windows ACL preparation/check path; an unavailable check must be diagnosed
without bypassing it. Microsoft describes the inspection and modification
semantics of [icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls).
Protect bearer provisioning and encryption unlock independently; follow the
[owner access contract](../security/owner-access-v1.md) and the selected credential
protection profile. A public default password or a key next to its ciphertext is
not an independent private protection boundary.

Keep the main listener private. Any approved HTTPS reverse proxy must preserve
the authentication/workspace boundaries and the distinct MCP Apps sandbox
origin; see [MCP Apps deployment](../features/mcp/apps.md). A single owner bearer
does not implement user sessions, resource sharing or multi-user isolation.

## Capture an operator sample

Use `scripts/operations-inspect.mjs` from the exact package or pinned source.
Set `FLUJO_OPERATIONS_TOKEN` in the diagnostic process through the operator's
protected secret configuration; do not pass it on the command line or place it
in a URL. In worker mode this is the existing `FLUJO_SNAPSHOT_CONTROL_TOKEN`.
In the owner profile it is an owner-policy credential with both `control:admin`
and `secrets:read` scopes, because these are the existing conservative control
capabilities. A separate narrowly scoped operator credential is not implemented.
Anonymous loopback access is refused by this endpoint as well.

After provisioning the environment bearer, Windows PowerShell:

```powershell
node scripts/operations-inspect.mjs `
  --base-url http://127.0.0.1:4200 `
  --workspace default-workspace `
  --expected-revision <full-lowercase-source-revision> `
  --report C:\OperatorEvidence\new-observation.json
```

Linux:

```bash
node scripts/operations-inspect.mjs \
  --base-url http://127.0.0.1:4200 \
  --workspace default-workspace \
  --expected-revision <full-lowercase-source-revision> \
  --report /srv/operator-evidence/new-observation.json
```

Replace the revision placeholder with all 40 lowercase hex characters, and use a
new absolute report path whose parent already exists. The CLI refuses to
overwrite it. Omitting `--report` prints the projected metadata to standard
output. In an npm installation, invoke the script at the installed package path;
do not assume a current directory contains the source repository.

The CLI performs one authenticated GET. It allows HTTP only for `localhost`,
`127.0.0.1` or `::1`; other hosts require HTTPS. Base URLs must have no embedded
credentials, query, fragment or path prefix. Redirects are refused without
forwarding the bearer. The default deadline is 10 seconds and the response
budget is 2 MiB. Unknown fields and raw response/error bodies do not enter the
report. The server has 200 rows per resource category, 2 MiB per diagnostic JSON
file and an 8 MiB shared workspace-file read budget. Its recovery control files
are separately bounded to 8192 bytes, including growth after opening.

Schema version 2 requires `observationProcessId`, an opaque UUID stable for the
observing Node process, plus explicit memory and MCP scope. It changes after
process replacement and is shared across that process's workspace samples.
For a subsequent sample, `--expected-process-id <UUID>` refuses a different
self-reported process. This is correlation metadata, not an OS birth identity,
authenticated artifact mapping or authority to signal a process. A balanced
proxy may return another process and the CLI must report that mismatch. Neither
a matching revision nor this UUID establishes actual runtime acceptance; the
report always records `runtimeAcceptance: false` and an unverified artifact digest.

| CLI exit | Interpretation |
| --- | --- |
| `0` | Complete bounded sample, matching self-reported revision, no reported warning. Does not mean healthy deployment or accepted grade. |
| `2` | Partial/truncated source, unavailable probe, revision missing/mismatched, or warning requiring investigation. |
| `1` | Authentication/HTTP refusal, redirect, invalid metadata/workspace/process correlation, deadline, byte limit, transport or report-write failure. Raw error bodies are withheld. |

401/403 require inspection of the correct current bearer, scopes, workspace and
revocation/expiry. Do not weaken authentication to get a sample. A worker's 503
can mean it is not ready; inspect its owned supervisor/bootstrap status privately
and the actual persistent mount before attempting another launch. A missing
revision requires external artifact verification, not setting an environment
variable to manufacture a match.

The endpoint authenticates before workspace selection and rechecks authority,
unlock and readiness after awaited observations. It applies the standard workspace layout/unlock and
worker-ready gates. That wrapper can ensure missing namespace directories;
observation does not invoke workflow mutation, terminal reconciliation or
corrupt-file backup/repair. The sample is non-atomic: other authorized work can
change while it is collected. It is not an execution admission barrier, an audit
ledger, a provider authentication probe or proof of remote/descendant cleanup.

## Diagnose the sample without replaying uncertain work

| Observation | Operator action |
| --- | --- |
| `enabled-plan-unarmed` | Inspect global pause, bootstrap and local provenance/opt-in/generation/definition. Readiness and an enabled row do not enroll a copied schedule. |
| `unresolved-worker-admission` | Retain the original plan generation and pending run ID. Census its actual conversation, approval, owned runtime and original external outcome. Keep replacement execution fenced; an indexed completed row or cancellation ACK is insufficient. |
| `run-error-hint:timeout` or `:rate-limit` | Inspect the original run/provider outcome and current budget/OFF/retry policy before any retry. The hint classifies text; it does not prove the provider was contacted or that an effect failed. |
| `run-error-hint:bad-request` or `:authentication` | Diagnose the original request or credential through the protected provider profile. Do not publish raw headers, prompts, requests or provider errors. Do not automatically rotate/replay. |
| `approval-index-needs-census` | The durable index is discoverability metadata. Verify that the exact stored conversation and pending call still exist before an explicit approval decision. Diagnostics neither prune the index nor accept/reject the call. |
| `queue-pressure` | Inspect a queue reaching its per-queue cap and active/exclusive ownership. Many independent overlap queues can have a large sum without any one reaching its cap. Avoid adding parallel writers. |
| `shutdown-exit-unobserved` | Match runtime UUID and generation against actual owned process/OS observations. Cold/error state, missing cache and close/stop acknowledgement do not prove exit. A CLI exit also does not prove isolated container removal. |
| `rss-budget-reached` | Inspect the sampled process RSS against the configured operator threshold. `FLUJO_OPERATIONS_RSS_BUDGET_BYTES` is an alert threshold, not enforcement or an agreed scorecard memory limit. Observe children/container resources separately. |
| `diagnostic-source-unavailable` or `diagnostic-row-budget-reached` | Treat the observation as partial. Inspect protected storage, permissions, size/corruption and the relevant complete source through an authorized bounded procedure. No silent empty/healthy fallback or automatic repair. |

Scheduler, active-run and MCP records apply to this process and workspace; foreign
MCP records are filtered and a scheduler workspace mismatch refuses the sample.
RSS and heap values cover the observing process across all its workspaces, without
children or other application processes. They cannot establish a workspace's
memory consumption or a total deployment budget. Approval and
history rows are explicitly unverified durable indices. Shutdown facts are
reported only for a matching process-local runtime UUID, workspace, server and
generation. No receipt from a previous runtime is adopted after a restart.
Absent/corrupt stored pause is represented by `null`, not a successful unpause.

The [worker-local recovery contract](../features/worker-local-schedule-recovery.md)
supports ordinary cron, skip overlap and unrestricted/singleton start policies.
It keeps one bounded missed-occurrence catch-up and private write-ahead admission.
Signed local terminal observation may reconcile on the normal recovery path;
this status endpoint deliberately leaves it untouched. Persona/other trigger,
parallel/queue, emergency/exclusive/barrier recovery remain outside this profile.
There is no exactly-once guarantee for an external effect.

## Back up, upgrade, restore and roll back

Record the current artifacts and observation before an upgrade. Census active
work, approvals and owned processes; apply current pause/OFF/budget authority
before entering a maintenance window. Obtain actual terminal/exit observations
where required and preserve unresolved records. Quiesce the installation's
writers before a full offline backup; copying a changing directory is not a
coherent capture.

Use the format appropriate to the operation:

| Backup/restore | Meaning and limit |
| --- | --- |
| Selective `/api/backup` → `/api/restore` | Legacy `backup-info.json` version `1.0`, selected storage/MCP files for one workspace. It is not a complete installation or scheduler/approval recovery backup. Sensitive selections include keys/env/model/MCP credentials; protect them and do not share the archive as evidence. |
| Snapshot format 2 | The [coherent snapshot protocol](../features/hot-clone-workspace.md) has a capture barrier, manifest/member digests, layout/protocol/version checks and explicit sensitive transfer. Download and verify before finalize. Restore is a controlled workspace fork, not live bidirectional replication. Copied schedules stay suppressed; installation-local provenance is excluded. |
| Offline complete data-root + external private configuration | Installation disaster recovery includes all namespace and installation-private state plus separately backed-up protected key/policy/authority material. Keep a single active restored installation. A complete duplicate with identical authority is not fenced by local HMAC provenance alone. |

Preflight the selected candidate's schema/layout and protected-credential
migration. Restore an encrypted, verified backup into a separate owned staging
root; keep its original account/domain/IDs and uncertainty bindings. Verify
record recovery and policy state before publishing the root. Test interrupted
migration, invalid archive, disk full/permission denial and failure between each
staging/commit step. Never solve a failed migration by deleting its journal,
pending admission or old encrypted data. Credential migration acceptance is owned
by its Security contract; a successful selective flow restore does not qualify it.

Upgrade code/image only after the staging drill passes. Start with the exact
candidate and intended protected mount/configuration, inspect readiness and a
fresh operator sample, then explicitly admit the intended local work. Preserve
copied/stale work suppression. A rollback consists of the retained artifact and
its compatible verified data/configuration snapshot; switching code while keeping
an incompatible migrated data root is not verified rollback.

Log retention must be bounded by the actual supervisor/container configuration
and protect any private runtime logs. These reports contain metadata identifiers
and counts, with no prompt/output/tool arguments, command/env, bearer or raw
provider/filesystem error. Retain report digests and reviewer access to originals.
Do not describe them as a signed or tamper-proof audit trail.

## Acceptance record for #570

A technically independent non-author operator must install the pinned candidate
on its intended profile, diagnose a seeded failed schedule, authenticate, back
up, upgrade, restore and roll back while retaining actual artifacts and
observations. This can be an independent automated operator with reviewable
technical evidence; it does not require a human-only workflow. Disposable
fixtures must remain labeled as fixtures. The Community installed-baseline harness is baseline-only until it
observes both the agreed older release and the integrated candidate.

For each run retain source/CLI pins, artifact digest/SRI, OS/runtime, mount and
authority profile, fixture vs original-work labels, exit codes, report/log hashes
and all limits. Include kill/restart, stale owner/worker epoch, timeout/429/400,
disk full, interrupted migration, invalid snapshot, expired authentication and
pending approval. Keep process-exit and isolated-runtime removal facts distinct.
Qualification must show only explicitly opted-in local recurring work recovers,
copied schedules remain inert, and uncertain old work cannot be replaced.

Issue closure and the A- grade remain with the accepted #564 rubric and independent
reviewer. This runbook and source tests provide no live model/account/spend authority.

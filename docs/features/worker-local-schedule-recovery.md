# Worker-local schedule recovery

Worker bootstrap keeps copied schedules, Persona dispatch and remote task resume
suppressed. This opt-in profile lets a persistent worker recover an ordinary cron
plan that was created through its own scheduler after successful bootstrap.
Worker readiness, an enabled row and a successful PATCH are not enrollment.

This is the source contract for #553. It does not establish installed-release,
Linux, live-provider, descendant-process or independent production acceptance.

## Configure one persistent worker

Use the [existing snapshot bootstrap](hot-clone-workspace.md#worker-bootstrap)
with Node 22 or later, a private worker endpoint and a persistent data volume.
Keep the existing snapshot hash and dedicated control token, and add:

```text
FLUJO_WORKER_RECOVERY_ID=worker-a
FLUJO_WORKER_RECOVERY_EPOCH=1
```

The ID accepts 1–128 ASCII letters, digits, dots, underscores, colons and hyphens,
beginning with a letter or digit. The epoch is a positive safe integer. The worker
also requires `FLUJO_WORKER_MODE=1`, `FLUJO_WORKER_SNAPSHOT_SHA256` and
`FLUJO_SNAPSHOT_CONTROL_TOKEN`. Missing or invalid configuration leaves plans
suppressed. Bootstrap must finish snapshot validation, secret preparation and all
required MCP connections before local creation or recovery is accepted.

Keep that authority and the whole data volume on the same installation across
process restarts. Each independent worker needs its own ID, epoch and control
token. Do not copy the installation's private control state into a second worker
or reuse its authority there. HMAC provenance fences changed authority; it cannot
distinguish two full volume clones that deliberately share all authority material.
This profile does not provide OS isolation or per-user credentials.

Changing the ID, epoch, snapshot hash or control token fences existing enrollment.
There is no automatic authority migration or force-clear endpoint in this slice.

## Create and enroll one plan

Create an ordinary plan through `POST /api/planned-executions?workspace=<name>` on
the ready worker, using the worker bearer. Select its actual worker-local flow ID.
For example, use this body after substituting the flow ID:

```json
{
  "name": "Local watchdog",
  "enabled": true,
  "flowId": "worker-local-flow-id",
  "prompt": "Run the approved local watchdog checks.",
  "startRestriction": "singleton",
  "overlapStrategy": "skip",
  "trigger": { "type": "schedule", "cron": "* * * * *", "catchUp": true }
}
```

Creation generates a new lifecycle identity and a private, initially opted-out
record. Caller-provided generations, imported flags, folder names and timestamps
do not enroll a plan. Legacy or snapshot plans lack this local creation proof;
create a new local generation after inspecting existing owned work instead of
adopting a copied row. Recreating the same ID cannot erase an unresolved admission.

Read `GET /api/planned-executions?workspace=<name>` and inspect that exact plan's
`execution.generationId`, `status.workerRecovery.definitionSha256`, retained run
history and existing owned tasks/conversations. Keep global pause and applicable
owner/OFF/budget/scope controls authoritative. Enrollment never grants external
execution authority or changes those controls.

Enroll the selected plan using its freshly read generation and digest:

```http
POST /api/planned-executions/<id>/worker-recovery?workspace=<name>
Authorization: Bearer <existing worker control token>
Content-Type: application/json

{
  "enabled": true,
  "expectedGenerationId": "<execution.generationId>",
  "expectedDefinitionSha256": "<status.workerRecovery.definitionSha256>"
}
```

The route accepts only these three fields. It authenticates the dedicated worker
bearer before resolving the workspace, then applies bootstrap/workspace/encryption
guards. Missing or invalid bearer returns 503/401; malformed input returns 400;
changed or invalid provenance/configuration returns 409. Its response contains
the recovery status and uses `Cache-Control: no-store`. Preserve tokens in secret
environment/configuration storage, never in evidence logs or committed examples.

The first profile supports ordinary cron plans with default/skip overlap and
unrestricted/singleton start restriction. Persona, other trigger types,
queue/parallel overlap, emergency, exclusive and super-exclusive plans remain
suppressed. This limitation leaves the broader production gates open.

## Read status and retain uncertainty

| Recovery state | Meaning |
| --- | --- |
| `suppressed` | Deliberately inactive: no local provenance/opt-in, unsupported profile, not ready, paused, disabled or retired. |
| `pending-local-recovery` | Local eligibility passed, but the reported trigger is not currently armed. |
| `armed` | The trigger is registered for this eligible configuration. No successful-effect claim. |
| `rejected` | A signature, authority, generation, definition or unresolved-admission fence refused recovery. |

`reason` identifies the specific fence; `pending` gives the exact local run ID and
occurrence time when available. The functional digest includes enabled state and
the plan definition; folder and update timestamp edits do not change it. A
functional edit needs another explicit enrollment against the new digest.

Before entering the execution engine, a serialized private write-ahead admission
records the exact run and occurrence. Repeated ticks, bootstraps and competing
processes cannot claim that occurrence twice. The existing catch-up policy remains
bounded to one most recent missed occurrence; pre-creation occurrences are ignored.

The trusted live scheduler writes a signed local terminal observation before
publishing terminal history. A restart can reconcile that observation without
relaunching the result. An imported history row, a cancellation ACK, a missing row,
a running child or `needs_approval` cannot clear the admission. If an observation
could not be persisted, uncertainty remains even when readable history says
completed. A crash after signed observation but before history/clear can therefore
recover safely; a crash before observation stays fenced. Private observations
contain bounded run/generation/status/time facts, without conversation content,
flow config, model credentials or process commands.

Disable recovery with the same endpoint and current generation/digest, setting
`enabled` to `false`. This disposes future triggers and fences entry after awaited
IO. It retains any pending admission. It does not cancel an entered flow, certify
descendant cleanup or prove OS process exit. Global pause, disabled/retired state
and changed authority/configuration also fence entry.

For unresolved work, retain the admission and original outcome/ownership evidence;
inspect only the relevant owned family under its existing recovery policy. Do not
delete control files, reset epochs, copy results or enable sibling plans to bypass
the fence. No automatic retry of interrupted external effects or exactly-once
external-effect guarantee is provided.

## Storage and validation

Private provenance lives under
`<data-root>/.worker-local-recovery/<workspace>/<hashed-plan-key>.json`, outside
exported/restored workspace subtrees. Records use the dedicated control token for
HMAC-SHA256, private atomic writes and existing cross-process runtime locks. Reads
reject unexpected fields, corrupt signatures, links/hardlinks and files over
8 KiB. Restored workspace history is never private terminal authority.

The scoped source fixtures cover local-vs-copied plans, generation/authority/config
changes, pause/revocation after awaited IO, signed terminal recovery, imported
history rejection, disk-write failure, recurrence and bounded catch-up. Their
execution engine is mocked and their timer/catch-up clocks are controlled. They
prove those boundaries, not elapsed-time or real-provider success.

`__tests__/scheduler/workerRecoveryProcessBoundary.test.ts` runs the private module
and actual runtime lock/filesystem in disposable Node processes. It kills only its
own admitted child, waits for that process to exit, starts another reader and
checks retained uncertainty and epoch fencing. It uses a source TypeScript loader;
it is not a packed/installed FLUJO artifact or a live model/worker test.

Before closing #553/#570, retain checks for the exact candidate artifact on Windows
and Linux, including real bootstrap failure, successful recurring effects,
restart/corrupt-state/disk-full recovery, owned family reconciliation and operator
acceptance. Record arming, engine outcomes, cancellation acknowledgement and exact
process-exit evidence separately.

# Desired state: set up and update an instance from one file

One JSON file says what a workspace should contain: settings, models, MCP servers,
flows and planned executions. Applying it is safe to repeat, safe to interrupt and
reversible. This works the same whether one instance serves one site with nobody at the
keyboard, or one instance serves several people who also create their own things.

Nothing changes for an installation that does not use it. Without a file and without a
call to the route, none of this runs.

## Two ways in

**At start.** Set `FLUJO_DESIRED_STATE_FILE` to the absolute path of the file. It is
applied once the workspace is unlocked and before servers connect and schedules arm, so
they start from the wanted configuration. A broken file never stops FLUJO from starting.
It is reported instead.

**On request.** `POST /api/operations/desired-state`, with the same access rules as
`GET /api/operations/status`:

| Body | What it does |
| --- | --- |
| `{ "action": "dry-run", "state": { ... } }` | Reports exactly what would change, and changes nothing |
| `{ "action": "apply", "state": { ... } }` | Applies it |
| `{ "action": "rollback" }` | Returns the whole workspace to the previous version |
| `{ "action": "rollback", "dryRun": true }` | Reports what that would change |

Leave `state` out to use the file named by the environment. `GET` on the same address
lists the kept versions, the managed objects and the last report. `?workspace=` selects
the workspace, as on every other route.

| Status | Meaning |
| --- | --- |
| 200 | Done, or there was nothing to do. See `outcome` |
| 422 | The file cannot be used. Nothing was changed. `problems` says why |
| 423 | The workspace is locked. Nothing was changed |
| 409 | This is a worker, which runs from a restored copy, so a file does not apply |
| 500 | A write failed. `message` says whether everything was put back |

## The file

```json
{
  "schemaVersion": 1,
  "version": "2026.11.05-1",
  "workspaces": ["default-workspace"],
  "policy": {
    "localEdits": "overwrite",
    "existingLocalObjects": "refuse",
    "removedObjects": "delete",
    "secretScan": "refuse",
    "keepVersions": 5
  },
  "settings": {
    "telemetry": { "enabled": false, "notifyDaily": false },
    "modelAccess": { "quickChat": false, "directModelCalls": false },
    "network": { "exposure": "localhost" },
    "onboarding": { "completed": true },
    "heartbeat": { "url": "https://example.org/report/site-1", "intervalMinutes": 15 }
  },
  "models": [{
    "id": "main",
    "name": "provider-model-name",
    "displayName": "Main model",
    "provider": "openai",
    "apiKey": "${env:MAIN_MODEL_KEY}"
  }],
  "mcpServers": [{
    "name": "tools",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "some-package@1.2.3"],
    "env": { "MODE": "quiet", "TOOLS_TOKEN": "${global:TOOLS_TOKEN}" }
  }],
  "flows": [
    { "id": "triage", "spec": { "name": "triage", "nodes": [], "edges": [] } },
    { "id": "copied", "flow": { "name": "copied", "nodes": [], "edges": [] } }
  ],
  "plannedExecutions": [{
    "id": "nightly",
    "name": "Nightly",
    "flowId": "triage",
    "enabled": true,
    "prompt": "Run it.",
    "trigger": { "type": "schedule", "cron": "0 3 * * *" }
  }]
}
```

Only `schemaVersion` and `version` are required. The empty `nodes` above only keep the
example short: a real flow needs real steps. Everything else is optional, and what is
left out is not touched.

- **`version`** is any text up to 128 characters. One version means one content: the same
  version with different content is refused, so a reported version can be trusted.
- **`workspace` or `workspaces`** say where this applies. The default is
  `default-workspace`. At start, named workspaces that do not exist yet are created, and
  each gets the same content with its own version record. On request, only the workspace
  selected in the address is applied.
- **`flows`** take FlowSpec form (`spec`, compiled with the normal compiler) or saved form
  (`flow`). Every flow must pass the normal validation. The compiler derives step ids from
  the flow id and step key, so applying twice changes nothing, and a step that keeps its
  key keeps its id.
- **`settings`** accepts these sections: `telemetry`, `network`, `modelAccess`,
  `onboarding`, `update`, `speech`, `experimental`, `conversationRetention`, `heartbeat`.
  An unknown name is refused, so a typing mistake cannot pass quietly. A setting the file
  does not mention stays as it is. A new document starts from a new installation's defaults.

### Secrets

The file never holds a secret value, only its name:

- `${env:NAME}` reads the variable from FLUJO's environment when applied. The value goes
  to the secret store, encrypted, under the same name. A missing variable makes the file
  invalid. A changed value updates the store.
- `${global:NAME}` refers to something already in the secret store. A name that does not
  exist makes the file invalid.

Anything else in `apiKey`, in a secret-looking `env` name, or in a secret-looking header
is refused. The whole file is also checked for text that looks like a real key. That check
can only be reduced to a warning, with `policy.secretScan`. The refusal names the place,
and never repeats the text.

Secrets are never deleted by a file, and a rollback does not change them back, because the
old value was never kept. They stay in the store when no longer mentioned.

Not possible from a file yet: webhook triggers (they need a secret token), OAuth client
secrets, models tied to an owner credential, Persona-targeted schedules and flows owned by
a Persona. These are refused with that reason.

## What an apply promises

**Dry-run is exact.** It runs the same planning as an apply and stops before the first
write. It names objects and changed fields, not their contents. Settings also show old and
new values, apart from the heartbeat address.

**Applying twice changes nothing.** The second run writes no file, adds no version and adds
no flow history.

**All or nothing.** Everything is checked and compiled before the first write. A write
that still fails (a full disk, say) is undone from the journal, and the report says so.
Between the first and the last write, others can see a mix of old and new. There is no
moment-exact switch. Each kind of object is written separately, though models, settings and
servers each go in one write.

**Survives a crash.** A journal is written before the first change and removed after the
last. If it is still there at the next start, the update is finished, with or without a file
configured. If finishing is impossible, for example because a needed environment variable is
gone, everything is put back. Either way it is reported as `interruptedApply`. If putting
back fails as well, the journal stays, `needs-attention` is reported and the next start or
apply tries again.

**Nothing secret reaches a log or a response.** Reports and records hold names only, and
stored credentials appear only as references or in encrypted form.

**Locked storage is reported, not bypassed.** While a workspace is locked, the route answers
423 and changes nothing. The file is applied right after the unlock, without a restart.

## Objects made by a file and by a person

Objects from the file are recorded as managed. Objects a person created are left alone by
apply, version change and rollback, and they keep what they use. If a file stops mentioning a
model, server or flow that a person's flow still uses, it stays and stops being managed.

| Situation | Setting | Default | Other choice |
| --- | --- | --- | --- |
| A managed object was edited on the instance | `policy.localEdits` | `overwrite`: the file wins, says so, and an earlier flow stays in that flow's history | `keep`: stays as edited, reported every time, in `localEditsKept` |
| A person's object has the identity the file wants | `policy.existingLocalObjects` | `refuse`: the file is invalid | `adopt`: taken over, and a rollback past that point puts it back |
| A managed object is no longer in the file | `policy.removedObjects` | `delete` | `keep`: stays and stops being managed |

A local flow with the same flow name but another id is always refused, because a flow's name
is how `/v1` finds it.

The mark is a record kept by FLUJO, not a field on the object. The editor does not show it yet,
so a person can edit a managed flow without being warned. `GET /api/operations/desired-state`
lists what is managed.

## Versions and rollback

The last `keepVersions` applied versions (5 unless the file says otherwise, between 2 and 50)
are kept as complete records in `db/desired-state-history`, including compiled flows. One call
returns the whole workspace to the previous version. Calling it again goes one further back.

**Why this does not use the per-flow history.** That history is capped at 25 entries, archiving
is best effort by design, and deleting a flow wipes it. It is fine for undoing one edit and it
still receives every change made here, but a rollback must not depend on it. Tests delete it
entirely before a rollback.

**After a rollback**, the file of the version you left is not applied again at the next start,
which would undo the rollback. A changed file is a new decision and is applied. Applying the
same file on request also lifts the hold.

What a rollback does not bring back: secret values, and the run history of a planned execution
it removes and re-creates. It covers what this file describes, and neither FLUJO's own program
nor conversations.

### How this relates to Persona Behavior revisions

Persona revisions are immutable, one Persona and one Behavior at a time, and activation works
only while idle. They do not cover ordinary flows reached through `/v1` or a schedule, nor models,
servers, settings or schedules, and nothing ties several of them to one version. So they are not
enough on their own to version a whole update. Two things are reused from them instead: their
way of freezing a flow together with the subflows it can reach, and the stable fingerprint of
flow content. A file does not change Persona revisions, and a rollback leaves them as they are.

## Conversations under way

A conversation runs on what it froze when it started. That was already true of a flow's own
steps. Files now also switch this on for subflows (`pinSubflows`, on by default per flow), since
a subflow is otherwise looked up only when it starts.

| While a conversation runs or waits for approval... | It continues with... |
| --- | --- |
| Its flow is changed | The version it started with, subflows included |
| Its subflow is changed or removed | The frozen subflow |
| The workspace rolls back | The version it started with |
| FLUJO restarts while it waits | The same frozen version, from saved state |

New conversations get the new version at once. So after a rollback, a conversation started on a
bad version still finishes on it. To stop one, cancel it.

Limits:

- A model or server the conversation needs may be gone or changed, because these are not frozen.
  A waiting tool approval is checked against the current tool at the moment of approval and is
  refused if it no longer matches, and the model can then propose a new call. A model call that
  finds its model gone ends in a visible error.
- If the subflows cannot be frozen (one is missing, or they call each other in a loop), the
  conversation still starts and looks them up when they start, and a warning is logged.
- Freezing makes saved conversation state larger, by the size of the reachable subflows.
- Editing a frozen subflow by hand reaches new conversations only.
- Pinning applies to a flow started by id or name. A conversation that started before its flow
  was managed keeps what it had.

## Reporting

`GET /api/operations/status` includes `desiredState`, with no content and no secrets:

| Field | Meaning |
| --- | --- |
| `appliedVersion`, `appliedAt` | What this workspace is on and since when |
| `lastAttemptAt`, `lastApplyFailed`, `lastFailureAt`, `lastFailureCode` | How the last attempt went. A failed attempt leaves the applied version as it was |
| `interruptedApply` | `none`, `finished-at-restart`, `restored-at-restart` or `needs-attention` |
| `heldBackVersion` | Rolled back from this version, whose file is not applied again by itself |
| `localEditsKept` | Edited objects the policy left alone |
| `restartRequired` | A setting changed that the launcher reads only at start, such as network exposure |
| `fileConfigured` | Whether `FLUJO_DESIRED_STATE_FILE` is set |
| `heartbeat` | When the last report went out and whether it arrived |

### Network exposure

The launcher reads `network.exposure` before the server starts, from the default workspace. So a
change takes effect at the next restart, which `restartRequired` reports. A file that asks for
`network` or `public` without owner access is refused, because FLUJO would then refuse to start.

### Heartbeat

Off unless a URL is set, through `settings.heartbeat.url` or `FLUJO_HEARTBEAT_URL`. The environment
variable applies to the default workspace only, and `FLUJO_HEARTBEAT_TOKEN` adds a bearer token.
Each workspace with an address sends a POST at its interval (15 minutes unless set, 1 to 1440), with
a little random spread so that many instances do not report at the same moment:

```json
{ "schemaVersion": 1, "flujoVersion": "3.48.5", "desiredStateVersion": "2026.11.05-1",
  "appliedAt": "2026-11-05T10:00:00.000Z", "lastApplyFailed": false, "status": "ok" }
```

`status` is `ok`, `attention` or `locked`. It holds no workspace name and no content, so an address
that names the site is what tells sites apart. Only https is accepted, or http to this computer.
Redirects count as failures, because one could carry the token elsewhere. The address never appears
in a log or report. A failed report changes nothing else, and is tried again next time.

## What this does not do

- It does not install or update FLUJO itself. That is the safe-update work.
- It does not fetch files from anywhere. Something else has to put the file on the machine.
- It does not install MCP server packages. It writes the configuration, and a server started with
  `npx` or similar fetches its package when it starts. Servers connect in the background: one that
  fails to connect does not fail the apply, and is visible in its server status.
- It has not been run on a real fleet. See the pull request for what was checked and how.

# Keeping stored conversations for a limited time

FLUJO keeps conversations, including tool results, until someone deletes them. A workspace can instead remove them a set number of days after their last activity. This is off by default, and an ordinary installation behaves as before.

## Setting it up

In Settings > Conversation retention, turn on **Remove old conversations automatically** and enter the number of days. **Check how many would go** shows the count first and removes nothing, and it works before you turn the setting on.

The same setting in the stored settings file:

```json
{ "conversationRetention": { "enabled": true, "days": 30, "precedence": "shorter" } }
```

A flow can name its own period under **Keep conversations for (days)** in the flow settings, stored as `conversationRetentionDays`. A flow's value only counts once the workspace has retention turned on, so importing a flow never starts removing anything by itself.

## When a workspace and a flow both name a period

The workspace chooses:

| `precedence` | Effect | A flow with `0` |
|---|---|---|
| `shorter` (default) | The shorter of the two applies. Neither can keep text longer than the other allows. | Adds no limit, so the workspace's period applies |
| `flow` | The flow's value replaces the workspace's | Its conversations stay |

With no workspace period, only flows with their own period are affected. A wrong value, such as a negative number or a fraction, counts as not set, so a typo can only keep more. Checking a flow reports such a value as an error.

## What counts as old

Age counts from the conversation's stored last activity: its last update, its last user message, and the last write to its event log. A file's own date is used only when a conversation stores no dates. So restoring an old backup does not start the period again, and the next run removes those conversations if they are past it.

A conversation and its subflow children count as one. They go together, once all of them have been idle for the period of the top conversation's flow.

## What is never removed

However old it is, a conversation stays when it:

- is running, or its lock is held at that moment
- waits for an approval, a person's answer, or a tool result
- is paused in the debugger
- belongs to a Persona, or is a Persona archive
- is protected by a built-in execution extension
- is still needed by a schedule, meaning it is in the approval inbox or its run waits for approval
- belongs to a detached subflow task or a meeting that has not finished
- has a native tool call whose outcome is unknown

Any of these also keeps the rest of its subflow tree. A run whose process has gone, after a crash for example, no longer counts as running, because nothing will ever move it on.

A file that cannot be read stays and shows in the counts as `unreadable`. It is not copied either. Look at these by hand, because FLUJO cannot tell who owns them.

If FLUJO cannot read what is in use, such as the approval inbox, the run removes nothing and reports `protection_unavailable`.

## What deleting removes

All deleting goes through `deleteConversationCompletely` in `src/backend/services/conversations/deletion.ts`: the delete button, bulk delete and the sweep. It removes:

- the state file, plus backups and half-written copies next to it
- the summary and the event log
- the exact model requests and their media, including images
- run resources, including images and spilled tool results
- detached subflow tasks of that conversation
- stored results of finished native tool calls
- the output and error text in the schedule's run history (the row stays, with status and times)
- recorded Harness examples of that conversation

### If it stops halfway

Before removing anything, FLUJO writes a small marker holding no text to `db/conversation-deletions/`. If the process stops, or a file cannot be removed yet (Windows may refuse while another program has it open), the marker stays. The next run finishes the job, even when retention is off, and counts this as `resumedDeletions`. A conversation that was created again under the same id afterwards is left alone.

If the state file itself cannot be removed, the conversation stays usable, and the caller gets an error. The sweep counts it as `failed` and tries again next time.

## What else ages out

Two more stores hold text with no conversation behind them, and they follow the same period while retention is on:

- **Schedule run history.** Scheduled runs keep their final output and error even when they save no conversation. Rows waiting for approval or owned by a Persona stay as they are.
- **Recorded Harness examples.** Examples recorded for a Persona stay. An example a running improvement is about to read waits for the next run.

## What this does not cover

Say so plainly if you rely on this for personal data:

- **Backups and exports you made.** They stay until you remove them. Restoring one brings its conversations back until the next run.
- **Files the CLI model tools write.** The Claude subscription and Codex adapters run command-line tools that keep their own session files in their runtime folder under `db/`. FLUJO does not remove those, because a file there is not reliably linked to one conversation. Do not use these adapters for personal data if you rely on retention.
- **Harness experiments.** An example already used in an experiment is copied into that experiment, which stays until you delete it.
- **Meeting records.** A meeting keeps its own event log, outside any one conversation. Only its participants' conversations age out.
- **Provider copies.** Anything already sent to a model provider is governed by your agreement with that provider.
- **Log files.** These have their own limits, and debug logging can include message text.
- **The disk itself.** Deleting removes files in the usual way and does not overwrite the disk. Use disk encryption if that matters.

## When it runs

A run starts a minute after FLUJO starts, and then at minute 23 of every hour, for each workspace. Overlapping requests share one run. It reads summaries one at a time and removes 25 conversations per batch with a short pause in between, so large folders do not hold up live traffic. Worker instances do not run it. While retention is off, a run reads only the settings and the marker folder.

## Checking on it

`GET /api/operations/status` includes `conversationRetention`:

```json
{
  "enabled": true, "days": 30, "precedence": "shorter", "running": false,
  "lastRun": {
    "dryRun": false, "startedAt": 0, "finishedAt": 0, "scanned": 12000, "deleted": 40,
    "incomplete": 0, "failed": 0, "kept": { "recent": 11900, "waiting": 3, "unreadable": 1 },
    "runRecordsCleared": 12, "harnessExamplesRemoved": 0, "resumedDeletions": 0
  }
}
```

This holds counts only, with no ids and no text. It survives a restart. `error` is a fixed code when a run stopped early.

`GET /api/conversation-retention` returns the same status. To check how many would go:

```bash
curl -X POST http://localhost:4200/api/conversation-retention \
  -H "Content-Type: application/json" \
  -d '{"action":"dry-run","settings":{"days":30}}'
```

`settings` is optional and tries a period without saving it. Without it, the saved settings apply, and if retention is off the answer is `{"enabled": false}`.

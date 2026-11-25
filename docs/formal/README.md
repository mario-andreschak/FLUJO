# Formal checks

Some FLUJO rules are about what happens over time, so a lint rule or a single
test cannot check them. The main one comes from AGENTS.md: a failure must never
block a conversation until restart, and every fence, quarantine or lock must be
released when its owner settles or its process is gone.

This folder holds a small [TLA+](https://lamport.azurewebsites.net/tla/tla.html)
model of how FLUJO saves a conversation. The TLC model checker walks through
every reachable state of the model, in every order of steps, with failures and
crashes injected, and checks the rules below in each one.

## Run it

```
npm run check:formal
```

Pass part of a file name to check only some configurations, for example
`npm run check:formal -- legacy`.

You need Java 11 or newer. Install one (for example
[Eclipse Temurin 21](https://adoptium.net)) and put `java` on `PATH`, or set
`JAVA_HOME`. GitHub's `ubuntu-24.04` runners already have it, and the `lint`
job in CI runs this check.

The script downloads the official TLA+ tools (`tla2tools.jar` v1.7.4 from
[github.com/tlaplus/tlaplus](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4))
once into `~/.cache/flujo/tla2tools/` and refuses any file whose SHA-256 differs
from the one pinned in `scripts/check-formal.mjs`. Set `FLUJO_TLA_TOOLS_DIR` to
use another cache folder. TLC's work files go to a temporary folder and are
removed afterwards; nothing is written into the repository.

The full run takes about four minutes on an 8-core machine.

## What it checks

`ConversationWriteHealing.tla` follows one save of a conversation through the
same steps as the code:

| Step in the model | Code |
|---|---|
| Wait for a writer slot; a quarantined slot counts as taken | `writer()` in `src/backend/execution/flow/conversationPublication.ts` |
| Join the process's shared writer registration, or publish a private one | `withWorkspaceProcessMutation` and `SharedWriterLease` in `src/backend/services/enduringAgents/runtimeLock.ts` |
| Take the conversation's intent file, reclaiming one that was left behind | `withConversationPublicationIntent` and `abandonedIntent` in `src/backend/execution/flow/conversationPublicationIO.ts` |
| Append, roll back a failed append, or fence an unknown outcome | `withConversationLogWriter` in `conversationPublicationIO.ts` |
| Settle: release the slot and any quarantine; clear the fence on success | `publishConversation` in `conversationPublication.ts` |
| A backup or restore waits until no live writer lock is left | `withWorkspaceProcessSnapshot` in `runtimeLock.ts` |
| A crash keeps the files and loses everything in memory; a restart is a new process instance | |

Faults the model injects: a failed append that is rolled back, an outcome that
stays unknown, an unknown descriptor close (which quarantines a slot), a lock
file that fails to unlink, a crash, a foreign writer that keeps the intent file
too long, and a backup that times out. Each kind has a small budget, so the
liveness rules say "once faults stop, everything heals".

Rules that must hold in every state:

- `SlotsBounded`: never more writers than slots.
- `OneWriterPerConversation`, `WriteHoldsIntent`: one appender per conversation, across processes.
- `CaptureExcludesWrites`: a running backup sees no covered write.
- `QuarantineOnlyWhileOwned`: a quarantined slot belongs to a transaction that has not settled.

Rules about the future (nothing stays blocked):

- `SavesFinish`: every wanted save finishes, with success or a reported failure.
- `IntentNeverBlocks`: no writer waits forever on an intent file.
- `FencesHeal`: a fence is cleared by the next complete save.
- `QuarantinesHeal`: a quarantined slot is released when its owner settles.
- `LeasesRetire`, `AbandonedLocksCleared`: writer registrations and failed unlinks clean themselves up.
- `CapturesFinish`: a backup is never starved by writers or by locks of dead processes.

## Configurations

Each `.cfg` file starts with `\* expect: ok` or `\* expect: violation`.

| File | Expect | What it covers |
|---|---|---|
| `ConversationWriteHealing.cross-process.cfg` | ok | Two processes, one conversation: intent files, crashes, restarts, a backup |
| `ConversationWriteHealing.in-process.cfg` | ok | One process, two conversations: slots, the shared registration, quarantine, a backup |
| `ConversationWriteHealing.legacy-intent.cfg` | violation | Before #1329 an intent left by a crash refused every later write |
| `ConversationWriteHealing.legacy-fence.cfg` | violation | Before #1329 a fence refused every new write for the life of the process |
| `ConversationWriteHealing.legacy-quarantine.cfg` | violation | Before #1329 a quarantined slot was never released |

The `legacy` files switch one of those old fail-closed behaviors back on through
the `Legacy` constant. TLC must find the blocked chat in each; if it stops
finding it, the rules have become too weak and the check fails.

## When TLC finds a problem

The script prints TLC's trace: the shortest sequence of steps from the start to
the broken rule, with every variable in each state. For a liveness rule the
trace ends in a loop (or "Stuttering") that repeats forever without the save
finishing. Fix the code, then the model, and keep both in step.

## Keeping the model honest

The model is a description of the code, not generated from it. When you change
how conversation saves wait, fence, reclaim or release, update the matching
action in `ConversationWriteHealing.tla` and run `npm run check:formal`.

Known simplifications:

- Each process keeps one shared writer registration. The code may briefly hold a
  closing one and a new one; the model covers the second as a private lock.
- Reclaiming an intent by age assumes no transaction lasts longer than
  `ABANDONED_INTENT_AGE_MS` (10 minutes), as the code does.
- Lock and timer waits are modeled as waiting with fair progress, without exact
  times.

The property test `__tests__/flow/conversationPublication.property.test.ts`
checks the in-process half of the same rules against the real code with
[fast-check](https://fast-check.dev): random bursts of saves, failures and
orderings, with no lost or duplicated item and every slot, fence and charge
released afterwards.

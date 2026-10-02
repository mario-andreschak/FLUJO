# Scheduled occurrence accounting

An enabled cron schedule is armed before asynchronous cursor initialization.
Reconciliation retains unchanged timers while reading configuration, so a
configuration read or another execution's update does not create a gap at a due
boundary. Changing the execution's runtime configuration replaces its trigger;
folder and timestamp changes do not replace an unchanged trigger.

With `catchUp: true`, startup or explicit reconciliation admits one missed
occurrence through the time of arming/reconciliation. Future occurrences that
arrive during initialization belong to the live timer. Cursor work is serialized
per execution to prevent catch-up and the live callback admitting the same tick.
Flow lifetimes retain the configured overlap policy (`skip`, `queue`, `error` or
`parallel`). With catch-up disabled, missed occurrences while disabled or closed
are not replayed.

The persisted `lastScheduledFireAt` identifies the intended occurrence, including
when the timer callback runs late. Scheduled prompt trigger data includes
`scheduledOccurrence`. A callback failure exposes the exact occurrence and a
bounded failure reason in `lastTriggerError`; a later successful callback clears
that error. A storage failure may prevent writing history, so operators should
inspect trigger status as well as retained run outcomes.

The race regression for issue #539 models disable/re-enable at 12:56 UTC before
the 13:00 UTC occurrence of `*/15 * * * *` in `America/Bogota`, and configuration
or cursor reads that straddle that boundary. This establishes a source-level
race and its fix; it does not establish the cause of the historical live report.

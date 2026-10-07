# Exclusive recovery writes and participant lifetime

This contract describes the current workspace mutation gate and its integrated
credential-migration driver. It replaces the earlier shared-lease prerequisite
without treating its historical tests or local generation counter as release
acceptance. Related work: #563, #567, #747 and #882.

## Admission and lifetime

Ordinary managed mutations obtain local admission and the existing physical
workspace writer admission. Each invocation has its own participant token. A
started nested mutation has a separate token and shares the admission; settling
one callback retires that callback's token immediately. A surviving sibling does
not revive a retired root or ancestor. The outer owner keeps admission until all
already-started participants settle, including after root failure.

`withWorkspaceRecoveryMutation` first closes ordinary admission and drains
previously admitted writers, then obtains the existing physical snapshot owner.
Recovery writes borrow that exclusive admission through live participants. They
do not reopen ordinary admission. A new recovery cannot begin inside a live
ordinary mutation. Read capture does not grant a nested write capability.

An explicit workspace argument to a nested mutation binds that invocation to the
selected workspace and restores the caller's ambient workspace afterward. Public
recovery `assertOwned()` still refuses a call from another ambient workspace.
Contexts created before the participant protocol refuse with a fixed diagnostic;
their former workspace set cannot confer admission.

## Cancellation, ownership and publication

Recovery captures the original cancellation signal and selected workspace before
awaiting admission. Mutating the caller's options cannot remove cancellation or
retarget authority. A participant is checked before and after an awaited physical
ownership check. The public root capability retires when its callback settles,
even while a started child retains its separate live participant.

Cancellation refuses new recovery effects. Already-started children must settle
before exclusive local admission and the physical owner are released. Read-only
capture cancellation releases its local admission; the physical snapshot owner
still protects actual outstanding reads until they settle. A cancelled capture
cannot publish its late result. This distinction preserves snapshot cancellation
without releasing an exclusive writer while its native work is pending.

The credential driver checks ownership after preparation, checkpoints and
readbacks, and before final journal publication and acknowledgment. Its guarded
filesystem publisher rechecks before actual rename. The ordinary queued storage
publisher checks the current participant after temporary-file writes/sync and
before every validated rename attempt, including attempts after Windows retry
delays. Existing path, stable-file, link, mode and physical-owner guards remain.

Recovery context failures use `WorkspaceRecoveryOwnershipError` with fixed
finished, workspace-changed, cancelled or ownership-lost diagnostics. Ordinary
context failures use `WorkspaceMutationContextError`. Raw abort reasons and
physical ownership causes are not included in these diagnostics. These errors do
not replace route sanitization for unrelated business or initial-admission
failures, and the older `RECOVERY_*` error codes are not this protocol's API.

## Recovery and evidence limits

The current credential driver implements preflight, confirmed migration, resume
and rollback using an authenticated pending journal and metadata-last publication.
Preflight remains read-only. A refusal does not undo native IO already issued;
pending recovery data must remain available when completion is unproven. The
final acknowledgment checks physical ownership after participant drain.

`operation.generation` is a local capture counter. It is not a durable credential
generation, effect ledger, anti-replay token or independent authorization for a
stored callback. Managed admission does not confine arbitrary unregistered
writers or turn host-account privileges into an OS sandbox. Native birth/FD and
filesystem ownership guarantees come from the existing physical primitives.

Source tests with modeled process ownership, real filesystem controls, installed
image execution, cross-process tests and crash/restart evidence have different
scopes. Report the exact source head and completed scope separately. This document
does not award an A-minus grade, close #747/#749/#750 by equivalence, or claim
provider, deployment or independent human acceptance. The cancellation-fix layer
must pass the complete affected and adjacent suites before qualification; #882's
earlier three timeout failures remain historical failures.

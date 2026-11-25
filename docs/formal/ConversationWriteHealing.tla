------------------------- MODULE ConversationWriteHealing -------------------------
(***************************************************************************)
(* How FLUJO saves a conversation, and why no failure leaves a chat        *)
(* blocked: every fence, quarantine and lock is released when its owner    *)
(* settles or its process is gone (AGENTS.md, "Resilience over refusal").  *)
(*                                                                         *)
(* One save of conversation c in process p walks through:                  *)
(*                                                                         *)
(*   "slot"    waits for one of the process's writer slots                 *)
(*             (conversationPublication.ts, writer())                      *)
(*   "admit"   holds a slot, waits for a workspace writer registration:    *)
(*             join the process's shared registration or publish its own   *)
(*             (runtimeLock.ts, withWorkspaceProcessMutation)              *)
(*   "intent"  registered, waits for the conversation's publication intent *)
(*             file, reclaiming one that was abandoned                     *)
(*             (conversationPublicationIO.ts, withConversationPublicationIntent) *)
(*   "write"   holds the intent and appends (withConversationLogWriter)    *)
(*   "done"    intent and registration released, slot still held until the *)
(*             transaction settles (publishConversation's settle step)     *)
(*                                                                         *)
(* Faults: an append that fails and is rolled back, an outcome that stays  *)
(* unknown (fence, intent kept), an unknown descriptor close (fence plus a *)
(* quarantined writer slot), a lock file that fails to unlink, a process   *)
(* crash, a foreign intent that keeps a writer waiting too long, and a     *)
(* workspace capture (backup) that times out. Each fault budget is finite: *)
(* the liveness properties say the system heals once faults stop.          *)
(*                                                                         *)
(* Legacy switches back on the fail-closed behaviors that PR #1329         *)
(* removed. The regression configurations set one each and TLC must find  *)
(* the blocked chat, which shows these properties catch that bug class.    *)
(*                                                                         *)
(* Run: npm run check:formal  (see docs/formal/README.md)                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Proc,         \* FLUJO processes sharing one workspace
  Conv,         \* conversations
  Slots,        \* writer slots per process (CONVERSATION_PUBLICATION_LIMITS.writers)
  MaxFaults,    \* injected I/O faults in one behavior
  MaxCrashes,   \* process crashes in one behavior
  MaxCaptures,  \* workspace captures (backup, restore) in one behavior
  Legacy,       \* {} for today's code; see LegacyBehaviors
  NoOwner       \* model value: no file

\* Before #1329: an intent left by a crash or a failed attempt refused every
\* later write; a fence refused new writes for the life of the process; a
\* quarantined writer slot was never released.
LegacyBehaviors == {"intentNeverReclaimed", "fenceRefusesWrites", "quarantineNeverReleased"}

ASSUME Slots \in Nat \ {0} /\ MaxFaults \in Nat /\ MaxCrashes \in Nat /\ MaxCaptures \in Nat
ASSUME Legacy \subseteq LegacyBehaviors

Incarnation == 0..MaxCrashes
Owner == Proc \X Incarnation          \* one process instance (its random token)
Phase == {"idle", "slot", "admit", "intent", "write", "done"}
Holding == {"admit", "intent", "write", "done"}

VARIABLES
  up,          \* up[p]: process p is running
  inc,         \* inc[p]: incarnation of p; a restart is a new instance
  demand,      \* demand[p][c]: a run or user in p wants c saved
  phase,       \* phase[p][c]: the save of c in p (one per conversation: per-key chain)
  cover,       \* cover[p][c]: "none" | "lease" (shared registration) | "own" (private writer lock)
  ok,          \* ok[p][c]: outcome of the current attempt
  uncertain,   \* uncertain[p][c]: the owner was fenced (owner.quarantined); its intent file is kept
  quarantine,  \* quarantine[p][c]: the owner holds a quarantined writer slot (descriptorUncertain)
  fence,       \* fence[p][c]: ledger.fences entry, reported by the next flush
  intent,      \* intent[c]: owner of the publication intent file, or NoOwner
  aged,        \* aged[c]: the intent file is older than ABANDONED_INTENT_AGE_MS
  lease,       \* lease[p]: "none" | "open": the shared writer registration and its lock file
  stale,       \* writer lock files left by a dead instance or a failed unlink (abandoned)
  admission,   \* owner of the workspace capture admission lock file, or NoOwner
  capture,     \* capture[p]: "none" | "waiting" | "draining" | "running"
  faults, crashes, captures   \* remaining budgets

vars == <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent, aged,
          lease, stale, admission, capture, faults, crashes, captures>>

Me(p) == <<p, inc[p]>>
Alive(o) == o # NoOwner /\ up[o[1]] /\ inc[o[1]] = o[2]
Writers(p) == Cardinality({c \in Conv : phase[p][c] \in Holding})
Quarantined(p) == Cardinality({c \in Conv : quarantine[p][c]})
LeaseUsers(p) == Cardinality({c \in Conv : cover[p][c] = "lease"})
\* The intent's writer is inside its transaction (intentProcess.live).
IntentLive(c) == Alive(intent[c]) /\ phase[intent[c][1]][c] = "write"
\* abandonedIntent(): our own instance's leftover, a dead instance's, or an old one.
Reclaimable(p, c) == intent[c] # NoOwner /\ ~IntentLive(c)
                     /\ (intent[c] = Me(p) \/ ~Alive(intent[c]) \/ aged[c])
                     /\ "intentNeverReclaimed" \notin Legacy
\* joinWriterLease(): only while no capture waits, here or in another process.
CanJoin(p) == lease[p] = "open" /\ capture[p] = "none" /\ admission = NoOwner

TypeOK ==
  /\ up \in [Proc -> BOOLEAN]
  /\ inc \in [Proc -> Incarnation]
  /\ demand \in [Proc -> [Conv -> BOOLEAN]]
  /\ phase \in [Proc -> [Conv -> Phase]]
  /\ cover \in [Proc -> [Conv -> {"none", "lease", "own"}]]
  /\ ok \in [Proc -> [Conv -> BOOLEAN]]
  /\ uncertain \in [Proc -> [Conv -> BOOLEAN]]
  /\ quarantine \in [Proc -> [Conv -> BOOLEAN]]
  /\ fence \in [Proc -> [Conv -> BOOLEAN]]
  /\ intent \in [Conv -> Owner \cup {NoOwner}]
  /\ aged \in [Conv -> BOOLEAN]
  /\ lease \in [Proc -> {"none", "open"}]
  /\ stale \subseteq Owner
  /\ admission \in Owner \cup {NoOwner}
  /\ capture \in [Proc -> {"none", "waiting", "draining", "running"}]
  /\ faults \in 0..MaxFaults /\ crashes \in 0..MaxCrashes /\ captures \in 0..MaxCaptures

Init ==
  /\ up = [p \in Proc |-> TRUE]
  /\ inc = [p \in Proc |-> 0]
  /\ demand = [p \in Proc |-> [c \in Conv |-> TRUE]]
  /\ phase = [p \in Proc |-> [c \in Conv |-> "idle"]]
  /\ cover = [p \in Proc |-> [c \in Conv |-> "none"]]
  /\ ok = [p \in Proc |-> [c \in Conv |-> FALSE]]
  /\ uncertain = [p \in Proc |-> [c \in Conv |-> FALSE]]
  /\ quarantine = [p \in Proc |-> [c \in Conv |-> FALSE]]
  /\ fence = [p \in Proc |-> [c \in Conv |-> FALSE]]
  /\ intent = [c \in Conv |-> NoOwner]
  /\ aged = [c \in Conv |-> FALSE]
  /\ lease = [p \in Proc |-> "none"]
  /\ stale = {}
  /\ admission = NoOwner
  /\ capture = [p \in Proc |-> "none"]
  /\ faults = MaxFaults /\ crashes = MaxCrashes /\ captures = MaxCaptures

SetPC(f, p, c, v) == [f EXCEPT ![p][c] = v]

-----------------------------------------------------------------------------
(* A save                                                                  *)

Request(p, c) ==
  /\ up[p] /\ demand[p][c] /\ phase[p][c] = "idle"
  /\ ~fence[p][c] \/ "fenceRefusesWrites" \notin Legacy
  /\ demand' = SetPC(demand, p, c, FALSE)
  /\ phase' = SetPC(phase, p, c, "slot")
  /\ UNCHANGED <<up, inc, cover, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* Legacy only: the save is refused at once because the conversation is fenced.
RefuseFenced(p, c) ==
  /\ "fenceRefusesWrites" \in Legacy
  /\ up[p] /\ demand[p][c] /\ phase[p][c] = "idle" /\ fence[p][c]
  /\ demand' = SetPC(demand, p, c, FALSE)
  /\ UNCHANGED <<up, inc, phase, cover, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* writer(): wait while writers + quarantined slots fill the limit.
TakeSlot(p, c) ==
  /\ up[p] /\ phase[p][c] = "slot"
  /\ Writers(p) + Quarantined(p) < Slots
  /\ phase' = SetPC(phase, p, c, "admit")
  /\ UNCHANGED <<up, inc, demand, cover, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

JoinLease(p, c) ==
  /\ up[p] /\ phase[p][c] = "admit" /\ CanJoin(p)
  /\ cover' = SetPC(cover, p, c, "lease")
  /\ phase' = SetPC(phase, p, c, "intent")
  /\ UNCHANGED <<up, inc, demand, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* registerWorkspaceWriter(): briefly holds capture admission (recovering it
\* from a dead owner), publishes a writer lock, and installs it as the shared
\* registration when none exists and no local capture waits.
Register(p, c) ==
  /\ up[p] /\ phase[p][c] = "admit" /\ ~CanJoin(p)
  /\ admission = NoOwner \/ ~Alive(admission)
  /\ admission' = NoOwner
  /\ IF lease[p] = "none" /\ capture[p] = "none"
       THEN /\ lease' = [lease EXCEPT ![p] = "open"]
            /\ cover' = SetPC(cover, p, c, "lease")
       ELSE /\ cover' = SetPC(cover, p, c, "own")
            /\ UNCHANGED lease
  /\ phase' = SetPC(phase, p, c, "intent")
  /\ UNCHANGED <<up, inc, demand, ok, uncertain, quarantine, fence, intent, aged,
                 stale, capture, faults, crashes, captures>>

AcquireIntent(p, c) ==
  /\ up[p] /\ phase[p][c] = "intent" /\ intent[c] = NoOwner
  /\ intent' = [intent EXCEPT ![c] = Me(p)]
  /\ aged' = [aged EXCEPT ![c] = FALSE]
  /\ phase' = SetPC(phase, p, c, "write")
  /\ UNCHANGED <<up, inc, demand, cover, ok, uncertain, quarantine, fence,
                 lease, stale, admission, capture, faults, crashes, captures>>

ReclaimIntent(p, c) ==
  /\ up[p] /\ phase[p][c] = "intent" /\ Reclaimable(p, c)
  /\ intent' = [intent EXCEPT ![c] = NoOwner]
  /\ aged' = [aged EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* Time passes: an intent nobody is writing under grows old.
Age(c) ==
  /\ intent[c] # NoOwner /\ ~aged[c] /\ ~IntentLive(c)
  /\ aged' = [aged EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* Leave the attempt: release the intent unless the owner was fenced, drop
\* the registration cover, then retry within the transaction or settle.
EndAttempt(p, c, success, keepIntent, next) ==
  /\ intent' = IF keepIntent \/ intent[c] # Me(p) THEN intent ELSE [intent EXCEPT ![c] = NoOwner]
  /\ cover' = SetPC(cover, p, c, "none")
  /\ ok' = SetPC(ok, p, c, success)
  /\ phase' = SetPC(phase, p, c, next)

WriteOk(p, c) ==
  /\ up[p] /\ phase[p][c] = "write"
  /\ EndAttempt(p, c, TRUE, uncertain[p][c], "done")
  /\ UNCHANGED <<up, inc, demand, uncertain, quarantine, fence, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* The append failed and its owned suffix was rolled back.
WriteRolledBack(p, c) ==
  /\ up[p] /\ phase[p][c] = "write" /\ faults > 0
  /\ faults' = faults - 1
  /\ \E next \in {"admit", "done"} : EndAttempt(p, c, FALSE, uncertain[p][c], next)
  /\ UNCHANGED <<up, inc, demand, uncertain, quarantine, fence, aged,
                 lease, stale, admission, capture, crashes, captures>>

\* Rollback failed or the outcome is unknown: fence now, keep the intent.
\* A descriptor whose close is unknown also quarantines a writer slot.
WriteUncertain(p, c) ==
  /\ up[p] /\ phase[p][c] = "write" /\ faults > 0
  /\ faults' = faults - 1
  /\ uncertain' = SetPC(uncertain, p, c, TRUE)
  /\ fence' = SetPC(fence, p, c, TRUE)
  /\ \E descriptor \in BOOLEAN :
       quarantine' = IF descriptor THEN SetPC(quarantine, p, c, TRUE) ELSE quarantine
  /\ \E next \in {"admit", "done"} : EndAttempt(p, c, FALSE, TRUE, next)
  /\ UNCHANGED <<up, inc, demand, aged, lease, stale, admission, capture, crashes, captures>>

\* A live foreign writer kept the intent past FOREIGN_INTENT_WAIT_MS: the
\* attempt fails as busy (transient, so it may be retried).
Busy(p, c) ==
  /\ up[p] /\ phase[p][c] = "intent"
  /\ intent[c] # NoOwner /\ ~Reclaimable(p, c)
  /\ \E next \in {"admit", "done"} : EndAttempt(p, c, FALSE, TRUE, next)
  /\ UNCHANGED <<up, inc, demand, uncertain, quarantine, fence, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

\* The owner settles: its slot and any quarantined slot are released; a
\* complete transaction clears the conversation's fence, a failed one sets it.
Settle(p, c) ==
  /\ up[p] /\ phase[p][c] = "done"
  /\ phase' = SetPC(phase, p, c, "idle")
  /\ fence' = SetPC(fence, p, c, ~ok[p][c])
  /\ quarantine' = IF "quarantineNeverReleased" \in Legacy THEN quarantine
                   ELSE SetPC(quarantine, p, c, FALSE)
  /\ uncertain' = SetPC(uncertain, p, c, FALSE)
  /\ ok' = SetPC(ok, p, c, FALSE)
  /\ UNCHANGED <<up, inc, demand, cover, intent, aged, lease, stale, admission,
                 capture, faults, crashes, captures>>

\* A failed save is reported; the chat or run saves again.
SaveAgain(p, c) ==
  /\ up[p] /\ fence[p][c] /\ phase[p][c] = "idle" /\ ~demand[p][c]
  /\ demand' = SetPC(demand, p, c, TRUE)
  /\ UNCHANGED <<up, inc, phase, cover, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

-----------------------------------------------------------------------------
(* The shared writer registration                                          *)

\* The idle timer fires (or a capture asked for it). Unlinking its lock file
\* may fail; the file is then abandoned and retried in the background.
RetireLease(p) ==
  /\ up[p] /\ lease[p] = "open" /\ LeaseUsers(p) = 0
  /\ lease' = [lease EXCEPT ![p] = "none"]
  /\ \/ UNCHANGED <<stale, faults>>
     \/ /\ faults > 0 /\ faults' = faults - 1
        /\ stale' = stale \cup {Me(p)}
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, admission, capture, crashes, captures>>

\* scheduleOwnedCanonicalRetirement(): retries a failed unlink every second.
RetryUnlink(p) ==
  /\ up[p] /\ Me(p) \in stale
  /\ stale' = stale \ {Me(p)}
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, admission, capture, faults, crashes, captures>>

-----------------------------------------------------------------------------
(* Workspace capture (backup, restore, recovery)                           *)

StartCapture(p) ==
  /\ up[p] /\ capture[p] = "none" /\ captures > 0
  /\ captures' = captures - 1
  /\ capture' = [capture EXCEPT ![p] = "waiting"]
  \* retireIdleWriterLease(): retire this process's idle registration first.
  /\ lease' = IF lease[p] = "open" /\ LeaseUsers(p) = 0 THEN [lease EXCEPT ![p] = "none"] ELSE lease
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, stale, admission, faults, crashes>>

CaptureAdmit(p) ==
  /\ up[p] /\ capture[p] = "waiting"
  /\ admission = NoOwner \/ ~Alive(admission)
  /\ admission' = Me(p)
  /\ capture' = [capture EXCEPT ![p] = "draining"]
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, stale, faults, crashes, captures>>

\* A writer lock of a dead or abandoned owner is retired by the capture.
CaptureRetireStale(p) ==
  /\ up[p] /\ capture[p] = "draining" /\ stale # {}
  /\ \E o \in stale : stale' = stale \ {o}
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, admission, capture, faults, crashes, captures>>

NoLiveWriterLocks ==
  /\ stale = {}
  /\ \A q \in Proc : up[q] => (lease[q] = "none" /\ \A c \in Conv : cover[q][c] # "own")

CaptureRun(p) ==
  /\ up[p] /\ capture[p] = "draining" /\ NoLiveWriterLocks
  /\ capture' = [capture EXCEPT ![p] = "running"]
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, stale, admission, faults, crashes, captures>>

\* The capture finishes, or gives up after its timeout; either way it
\* releases admission.
CaptureEnd(p) ==
  /\ up[p] /\ capture[p] = "running"
  /\ capture' = [capture EXCEPT ![p] = "none"]
  /\ admission' = NoOwner
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, stale, faults, crashes, captures>>

CaptureTimeout(p) ==
  /\ up[p] /\ capture[p] = "draining"
  /\ capture' = [capture EXCEPT ![p] = "none"]
  /\ admission' = NoOwner
  /\ UNCHANGED <<up, inc, demand, phase, cover, ok, uncertain, quarantine, fence, intent,
                 aged, lease, stale, faults, crashes, captures>>

-----------------------------------------------------------------------------
(* Crash and restart                                                       *)

\* Memory is gone; files stay. A save that was in flight is wanted again.
Crash(p) ==
  /\ up[p] /\ crashes > 0
  /\ crashes' = crashes - 1
  /\ up' = [up EXCEPT ![p] = FALSE]
  /\ stale' = IF lease[p] = "open" \/ \E c \in Conv : cover[p][c] = "own"
                THEN stale \cup {Me(p)} ELSE stale
  /\ demand' = [demand EXCEPT ![p] = [c \in Conv |-> demand[p][c] \/ phase[p][c] # "idle"]]
  /\ phase' = [phase EXCEPT ![p] = [c \in Conv |-> "idle"]]
  /\ cover' = [cover EXCEPT ![p] = [c \in Conv |-> "none"]]
  /\ ok' = [ok EXCEPT ![p] = [c \in Conv |-> FALSE]]
  /\ uncertain' = [uncertain EXCEPT ![p] = [c \in Conv |-> FALSE]]
  /\ quarantine' = [quarantine EXCEPT ![p] = [c \in Conv |-> FALSE]]
  /\ fence' = [fence EXCEPT ![p] = [c \in Conv |-> FALSE]]
  /\ lease' = [lease EXCEPT ![p] = "none"]
  /\ capture' = [capture EXCEPT ![p] = "none"]
  /\ UNCHANGED <<inc, intent, aged, admission, faults, captures>>

Restart(p) ==
  /\ ~up[p]
  /\ up' = [up EXCEPT ![p] = TRUE]
  /\ inc' = [inc EXCEPT ![p] = inc[p] + 1]
  /\ UNCHANGED <<demand, phase, cover, ok, uncertain, quarantine, fence, intent, aged,
                 lease, stale, admission, capture, faults, crashes, captures>>

-----------------------------------------------------------------------------

Next ==
  \/ \E p \in Proc, c \in Conv :
       \/ Request(p, c) \/ RefuseFenced(p, c)
       \/ TakeSlot(p, c) \/ JoinLease(p, c) \/ Register(p, c)
       \/ AcquireIntent(p, c) \/ ReclaimIntent(p, c) \/ WriteOk(p, c)
       \/ WriteRolledBack(p, c) \/ WriteUncertain(p, c) \/ Busy(p, c)
       \/ Settle(p, c) \/ SaveAgain(p, c)
  \/ \E c \in Conv : Age(c)
  \/ \E p \in Proc :
       \/ RetireLease(p) \/ RetryUnlink(p)
       \/ StartCapture(p) \/ CaptureAdmit(p) \/ CaptureRetireStale(p) \/ CaptureRun(p)
       \/ CaptureEnd(p) \/ CaptureTimeout(p)
       \/ Crash(p) \/ Restart(p)

\* Progress the code makes on its own: I/O finishes, timers fire, time
\* passes, an exited FLUJO is started again. Faults, crashes, busy give-ups
\* and capture timeouts get no fairness: they may happen, never must.
Fairness ==
  /\ \A p \in Proc, c \in Conv :
       /\ WF_vars(Request(p, c))
       /\ WF_vars(RefuseFenced(p, c))
       /\ WF_vars(TakeSlot(p, c))
       /\ WF_vars(JoinLease(p, c) \/ Register(p, c))
       /\ WF_vars(AcquireIntent(p, c))
       /\ WF_vars(ReclaimIntent(p, c))
       /\ WF_vars(WriteOk(p, c))
       /\ WF_vars(Settle(p, c))
       /\ WF_vars(SaveAgain(p, c))
  /\ \A c \in Conv : WF_vars(Age(c))
  /\ \A p \in Proc :
       /\ WF_vars(RetireLease(p))
       /\ WF_vars(RetryUnlink(p))
       /\ WF_vars(CaptureAdmit(p))
       /\ WF_vars(CaptureRetireStale(p))
       /\ WF_vars(CaptureRun(p))
       /\ WF_vars(CaptureEnd(p))
       /\ WF_vars(Restart(p))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety                                                                  *)

SlotsBounded == \A p \in Proc : Writers(p) <= Slots

OneWriterPerConversation ==
  \A c \in Conv, p, q \in Proc : (phase[p][c] = "write" /\ phase[q][c] = "write") => p = q

WriteHoldsIntent == \A p \in Proc, c \in Conv : phase[p][c] = "write" => intent[c] = Me(p)

\* A running capture sees no write that its writer locks would have announced.
CaptureExcludesWrites ==
  \A p \in Proc : capture[p] = "running" =>
    \A q \in Proc, c \in Conv : cover[q][c] = "none"

\* A quarantined slot belongs to a transaction that has not settled yet.
QuarantineOnlyWhileOwned ==
  \A p \in Proc, c \in Conv : quarantine[p][c] => phase[p][c] \in Holding

-----------------------------------------------------------------------------
(* Liveness: nothing stays blocked                                         *)

\* Every save that is wanted eventually finishes, success or reported failure.
SavesFinish ==
  \A p \in Proc, c \in Conv :
    (demand[p][c] \/ phase[p][c] # "idle") ~> (~demand[p][c] /\ phase[p][c] = "idle")

\* No writer waits forever on an intent file, whoever left it.
IntentNeverBlocks == \A p \in Proc, c \in Conv : phase[p][c] = "intent" ~> phase[p][c] # "intent"

\* A fence is cleared by the next complete save (or goes with its process).
FencesHeal == \A p \in Proc, c \in Conv : fence[p][c] ~> ~fence[p][c]

\* A quarantined writer slot is released when its owner settles.
QuarantinesHeal == \A p \in Proc, c \in Conv : quarantine[p][c] ~> ~quarantine[p][c]

\* The shared registration is retired once its writes are done.
LeasesRetire == \A p \in Proc : lease[p] = "open" ~> lease[p] = "none"

\* A failed unlink is retried until the lock file is gone.
AbandonedLocksCleared == \A p \in Proc : (up[p] /\ Me(p) \in stale) ~> Me(p) \notin stale

\* A capture is never starved by writers or by locks of dead processes.
CapturesFinish == \A p \in Proc : capture[p] # "none" ~> capture[p] = "none"

=============================================================================

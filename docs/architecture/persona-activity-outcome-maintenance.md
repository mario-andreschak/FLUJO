# Persona Activity outcomes and Behavior maintenance

Status: accepted implementation for issue #444 (shadow/manual-review rollout)

## Decision

Runtime status and semantic outcome are separate contracts.

- `PersonaActivity.status` remains authoritative for queue, lease, retry, cancellation, and dispatcher behavior.
- `PersonaActivity.outcome` is an independently versioned, bounded product/learning result: `succeeded | partial | blocked | failed | unknown`.
- Missing or malformed Persona claims fail closed to an engine-authored `unknown` outcome (or `failed` after a runtime error).
- Only semantic `succeeded` may automatically complete an assigned WorkItem. Other terminal outcomes block the WorkItem with a safe next action; explicit terminal WorkItem mutations retain precedence.
- Legacy Activities migrate deterministically: completed/cancelled become `unknown`, error becomes `failed`, and no missing outcome is interpreted as success. New terminal transitions always persist one.

Persona outcome claims use a closed JSON envelope inside
`<persona_activity_outcome>...</persona_activity_outcome>`. The dispatcher validates
the discriminator, bounds all text and evidence, and rejects references outside the
owning Activity. A completed Flow is never assumed to have achieved the user's goal.

## Maintenance lifecycle

Behavior assessment uses the fixed
`persona-behavior-maintenance-runs` collection and an independently versioned
record. IDs derive from workspace, Persona, bounded source-window digest, and
detector version. Evidence windows are limited to the newest 20 eligible terminal
Activities from seven days and persist only digests/trust counts in the run record.

Admission and diagnosis use separate rollout flags. Both default off. Disabled
admission is a no-write path. Admission occurs only after an eligible completed/error
source Activity commits; cancelled and maintenance Activities never trigger learning.
The cross-process Persona lock makes active-run inspection plus save atomic, and
shadow-only admissions are terminal records so they cannot block later windows.

Diagnosis is detached from the source commit. A short-lived durable lease fences the
`queued -> diagnosing -> completed | awaiting_review | failed` lifecycle. Startup
reclaims expired diagnosis leases without replaying source side effects. Completed,
failed, cancelled, and `awaiting_review` runs participate in compaction after 30 days,
and only the newest 100 uncompacted runs in those states retain source Activity
evidence pointers. Compaction leaves review-pending runs in `awaiting_review` and
preserves identifiers, digests, hashes, actions and reasons, trust counts, counters,
review state, and proposal links. Proposal records and their review metadata remain
available through the existing proposal APIs.

Diagnosis has closed actions: `no_change`, `memory_candidate`,
`instruction_behavior_candidate`, `setup_recommendation`, `eval_candidate`,
and `needs_human_diagnosis`. The maintenance service cannot mutate the source
Activity or WorkItem and cannot activate Behavior.

## Behavior proposals and rollout

Proposal provenance is additive and independently versioned. It records origin,
maintenance linkage, detector/evaluation versions, evidence digest/taint, diff risk,
and the policy decision code.

Persona-native proposals remain instruction-only and preserve Flow topology.
The ordinary Persona `suggest_improvement` path now always requires owner review;
it no longer injects an automatic-activation policy. Existing explicit policy APIs
remain available for a later gated rollout, but issue #444 does not enable them.

## Safety boundaries

- Persona-native tools are advertised only when authored into the immutable Process
  snapshot, in canonical order, after deny-rule filtering and collision rejection.
- ModelHandler remains the fenced dispatch boundary.
- Maintenance evidence is data, never instruction.
- No maintenance path retries source side effects.
- Deletion previews, digests, and erasure include maintenance runs.
- Automatic Behavior activation and probation are deferred until explicit product
  and security approval.

## Kill switch and staged rollout

Two independent layers stop Persona self-improvement. Either one alone is
sufficient; neither overrides the other.

1. **Global rollout gates** in `src/config/features.ts`:
   - `ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION` — admits durable
     post-Activity maintenance records. Off means `admitBehaviorMaintenanceRun`
     is a no-write call.
   - `ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS` — permits diagnosis and
     proposal drafting only while outcome metrics and outcome-driven automatic
     rollback are also enabled. If any prerequisite is off, every active run is
     terminalized as `completed` / `shadow_admission_only`, and diagnosis
     persistence refuses outright.
   - `ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS` — records terminal Activity
     outcome samples used by the regression detector.
   - `ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK` — permits the detector to
     use the compare-and-swap rollback lane, subject to Persona autonomy.
2. **Per-Persona autonomy** (`persona.autonomyLevel`): `locked` blocks admission,
   procedural hints, and proposals; `learn_hints` allows hints but refuses every
   Behavior override. These checks live in `behaviorLearning.ts` and are enforced
   regardless of the global gates, so enabling a gate never widens what a
   `locked` or `learn_hints` Persona may do.

**Safe rollout order.** Keep every gate default-off. Enable outcome metrics
first, automatic rollback second, and maintenance diagnosis last. Admission is
independent and may remain enabled throughout to collect shadow evidence.

**Safe rollback order.** Disable diagnosis first. Reconciliation remains
available and terminalizes queued, leased, or otherwise active maintenance runs
instead of stranding them. Admission may remain enabled for shadow evidence.

Diagnosis readiness is evaluated dynamically from the diagnosis, outcome-metric,
and automatic-rollback gates. Automatic rollback remains subject to Persona
autonomy and never overrides `locked` or `learn_hints`.

The `behavior-outcome-v1` detector requires at least 10 samples and a 0.15
absolute success-rate regression across 14-day baseline and observation windows.
Regression evidence is persisted before rollback is attempted. Successful
automatic rollback records actor `behavior-outcome-detector` and audit action
`auto_rolled_back`. Outcome projection remains best-effort: metric failure is
observable but does not fail terminal Activity completion.

**Operational caveat.** The gates have no environment-variable, config-file, or
admin override. They are plain module constants, so changing one is a source
edit plus a rebuild and restart — a deploy, not a runtime operation. This is the
intended shape for a developer-driven shadow rollout; a supported runtime
override is a separate piece of work.

**Mid-flight semantics.** Turning admission or any diagnosis prerequisite off
while runs are active does not strand them. Every completed Activity reconciles that Persona's maintenance runs
unconditionally (`PersonaFlowDispatcher.commitTerminal`), independently of
whether admission produced a run, and `startPersonaFlowDispatcher()` performs an
ungated sweep at process start. Whichever happens first terminalizes the
in-flight runs. There is no periodic sweep beyond these two triggers.

**Retention is compaction, not deletion.** After
`BEHAVIOR_MAINTENANCE_RETENTION_MS` (30 days), or beyond the newest
`BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT` (100) detailed runs, private evidence
pointers are dropped. Audit identity, hashes, decisions, proposal links, and
counters remain durable, so record count still grows over time.

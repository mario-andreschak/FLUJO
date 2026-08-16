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

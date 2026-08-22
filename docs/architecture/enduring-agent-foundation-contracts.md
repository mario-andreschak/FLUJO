# Enduring-agent foundation contracts

Status: **Accepted; Phases 1–4 implemented through durable memory and work management**

Decision owner: issue [#415](https://github.com/mario-andreschak/FLUJO/issues/415)

Implementation note: the first `codex/enduring-agents` foundation slice adds the
versioned records, workspace-scoped stores, built-in Developer Role, deterministic
Persona factory, local inspection/creation APIs, and initial immutable legacy
fixtures. It is not the complete epic or a release-complete Persona runtime.
Phase 2 adds hashed/idempotent mailbox admission, deterministic eligible ordering,
policy-controlled queue/steer/coalesce/interruption routing, immutable Behavior
resolution at Activity start, durable lease acquisition history, exclusive
local-filesystem lease fencing, renewal, graceful yield, completion, expiry
handling, and crash-prefix reconciliation. The durable dispatcher and meeting
reservation coordinator carry the fence through Flow execution, check it
immediately before model/tool side effects, and attach only safe
Persona/Activity/Behavior attribution to persisted run state. Conversation
snapshots, summaries, and append-only transcript events commit while the same
fence remains current, so a late provider response cannot survive lease loss.
Persona-aware chat,
planned executions, triggers, and webhooks enter through the dispatcher;
Persona-less requests retain their existing execution paths. Meetings reserve
Personas through the same mailbox in deterministic order for their full lifetime,
and startup reconciliation resumes queued work after unlock. Redacted monotonic
runtime events and the Persona inspection bundle expose lifecycle, stuck/error,
expiry, and recovery state without leaking lease capabilities. Expired work with
unknown external side effects is failed rather than replayed automatically.
An error-gated Persona remains visibly blocked until the local, confirmation-bound
runtime-recovery operation is invoked; that operation refuses a live lease, closes
uncertain orphan work, preserves proven queued/waiting work, and requeues only
undelivered input.
Phase 4 adds Persona-owned WorkItem CRUD with dependency/readiness enforcement,
priorities, deadlines, next actions, and explicit (never automatic) promotion from
run-scoped todos. The MemoryKernel adds provenance-stamped candidate/active,
correction, conflict/supersession, forgetting, search, and curated core-memory
lifecycles. Its ranking and generic near-duplicate defaults are governed by the
[memory ranking and near-duplicate decision](./memory-ranking-dedup-decision.md). Flow-authored synthetic memory/WorkItem tools execute only under the
live Persona Activity fence; model writes remain `model_inference` candidates and
untrusted external content cannot activate. Core memory is frozen into the same
per-Activity instruction context as identity. After a non-maintenance Activity
completes, a Role-authored restricted `maintain_memory` Behavior may inspect
bounded transcript evidence (including existing compaction summaries) and propose
zero to three candidate memories without recursively scheduling itself.
The completed Phase 1 service surface also provides a workspace-scoped deletion
preview and explicit-confirmation operation. It disables admission, cancels live
Activity state, expires active fencing authority, erases Persona-owned Behaviors,
memory, WorkItems, mailbox/runtime records and home data, retains shared Roles and
MCP configurations, and writes a minimal policy-labelled anti-resurrection
tombstone. Backup expiry remains controlled by the workspace backup subsystem.

The Phase 2A critical section combines workspace-qualified in-process serialization
with an atomic hard-link lock, live-process ownership checks, and published
per-recoverer intent barriers on the shared local workspace filesystem. A lock is
never time-stolen from a live process; dead recovery intents have unique,
never-reused paths, and a successor revalidates ownership after every live recovery
finishes. Process identity includes a canonical boot-qualified v2 birth marker;
the legacy marker remains absent so an older overlapping reader fails closed on
PID liveness instead of stealing a new-format owner. This is suitable for FLUJO's
local multi-process deployment boundary, not
a distributed database transaction or cross-host consensus lock. Independent
Node `worker_threads` isolates are outside this lock's deployment boundary; use
separate OS worker processes so process birth and death remain authoritative.
Public Persona selection and broad user-facing cross-system attribution remain a
Phase 3 concern. Phase 2 accepts explicit Persona targeting only while FLUJO is in
its `localhost` exposure mode, where the launcher binds Next to `127.0.0.1`, and
also requires loopback Host/Origin headers with no proxy forwarding headers.
Network/public or reverse-proxied exposure cannot select,
inspect, mutate, resume, cancel, or administratively recover Persona work, even if
a remote client spoofs `Host: localhost`; external webhooks can reach a Persona
only through a trusted target saved locally on the planned execution. Persisted
execution attribution is safe metadata and never a lease capability. Dependency
manifests (Behavior publication
currently rejects Subflow nodes), the complete compatibility matrix, privacy-aware
configuration export, cross-system archive anonymization beyond the implemented
Persona-conversation backup/restore guards, broader WorkItem automation, and the
remaining UI remain gated follow-up work.

## Context

FLUJO already has durable Flow runs, conversations, meetings, schedules, triggers,
steering, approvals, recovery, and MCP integrations. Those records describe work,
but none is the durable actor that owns identity, commitments, memory, and
continuity across work. Adding that actor without explicit boundaries would risk
turning identity into ambient authority, binding long-lived Personas to prunable
Flow history, or retrospectively changing legacy executions.

This record establishes the contracts implemented incrementally by #415. The
implementation status above is descriptive; the requirements below remain the
normative compatibility and safety boundary. Persisted domain names are
independent of UI labels: the UI may eventually call a
Persona an “Agent” or a Flow a “Behavior” without changing these contracts.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** below are normative.

## Decision

### Domain terms and ownership

All V1 enduring-agent records are owned by exactly one workspace. References
between them MUST resolve in that same workspace; possession of an id from another
workspace is never sufficient authority to read or link it.

| Term | Stable identity and owner | Contract |
|---|---|---|
| **RoleDefinition** | Workspace-owned family | Names a reusable blueprint such as Developer. It has versions but contains no living state. |
| **RoleVersion** | Immutable revision of one RoleDefinition | Declares identity/mission defaults, named Behavior slots, semantic capability requirements, policies, and migration notes. A Persona pins one exact version until explicitly upgraded. |
| **Persona** | Unique, durable, workspace-owned actor | Owns identity settings, one pinned RoleVersion, Behavior bindings, memory, WorkItems, mailbox, lifecycle policy, and at most one active Activity lease. It is not a Flow, conversation, run, or account. |
| **BehaviorBinding** | Persona-owned named slot | Maps a Role slot (for example `review_code`) to the currently active Persona-owned BehaviorRevision. Changing the pointer is an explicit, audited activation, not an edit to a revision. |
| **BehaviorRevision** | Immutable and owned by exactly one Persona | A publishable implementation of a Behavior slot, backed by a durable immutable Flow snapshot. It is never transparently shared by two Personas. Role defaults are copied/materialized into Persona-owned revisions. |
| **Activity** | Persona-owned unit of immediate work | Represents one chat, assignment, meeting attendance, voice session, trigger, or maintenance pass. It owns working state and is the unit protected by the Persona lease. |
| **Worker** | Ephemeral execution, normally Persona-less | May run in parallel, but does not inherit a Persona’s identity, private memory, mailbox, app grants, accounts, or lease merely because that Persona initiated it. |
| **WorkItem** | Persona-owned durable commitment | Persists across Activities. Existing run todos remain scratch planning and become WorkItems only through an explicit promotion/create operation. |
| **MemoryItem** | Persona-owned knowledge record, optionally workspace-scoped for retrieval | Is typed, provenance-bearing, trust-labelled, correctable, supersedable, and forgettable. Raw archive records remain workspace-owned evidence rather than memory by default. |
| **Flow** | Existing workspace execution/authoring artifact | Continues to define executable graph structure and tool authority. Existing bounded Flow edit history remains suitable for editing and undo, not permanent identity bindings. |

A Persona can own several Behavior slots, Activities, WorkItems, and MemoryItems. An
Activity selects one immutable BehaviorRevision for the work it performs. Role
requirements are interfaces/defaults; they do not grant runtime tools.

### Immutable Role and Behavior revisions

RoleVersion and BehaviorRevision are append-only semantic records:

- Updating either creates a new revision id. Existing Personas and Activities
  remain pinned to the old id until an explicit, authorized transition.
- A BehaviorBinding is the only mutable activation pointer. Activation MUST use an
  expected-current revision (compare-and-swap or equivalent), record actor,
  rationale, timestamp, and previous revision, and support rollback by activating
  another existing immutable revision.
- A BehaviorRevision MUST contain or reference a durable, immutable, canonical Flow
  execution snapshot. Its identity MUST NOT depend solely on a mutable Flow id or
  on an entry in the existing bounded/prunable Flow edit history.
- The snapshot MUST pin the executable dependency closure needed for replay,
  including subflow revisions or an equivalent immutable dependency manifest. A
  mutable “latest Flow” reference is provenance only and cannot define revision
  semantics.
- Each snapshot has a schema version and a content digest over a documented
  canonical representation. The digest detects corruption and supports dedupe; the
  opaque BehaviorRevision id remains the foreign-key identity.
- Publishing copies/snapshots the authored Flow. Later canvas edits and history
  pruning do not change the published BehaviorRevision. A new publish creates a
  new revision even when it descends from the same Flow.
- Provenance MAY retain source Flow id/edit revision, parent BehaviorRevision,
  proposal evidence, and validation results. Such references do not replace the
  immutable payload.
- Semantic changes to an immutable revision, including changes caused by schema
  interpretation, require a successor revision. Storage-only migrations may add
  indexes or derived metadata but MUST NOT change the canonical payload or digest.

Role upgrades never fan out silently. An upgrade plan compares slots and policies,
then explicitly repins each Persona and decides whether existing Persona overrides
remain, are replaced, or need review.

### Persona mailbox, lease, and fencing contract

Phase 2 implements the local mailbox/Activity/lease kernel and its trusted routing
and orchestration integrations in this section. Each Persona has a durable mailbox
and **at most one valid Activity lease**. A lease contains, at minimum:

```text
workspaceId, personaId, activityId, leaseId, holderId,
fencingToken, acquiredAt, renewedAt, expiresAt
```

The owner/holder value is an opaque capability returned only to the winning claim.
Busy errors and Persona inspection bundles expose non-secret status metadata and
never serialize the holder or a capability-complete fence.

The following rules prevent two recovered or partitioned workers from concurrently
mutating one Persona life:

1. Acquisition is an atomic storage operation. It succeeds only when no lease
   exists or the previous lease has expired according to authoritative server/store
   time.
2. Every successful acquisition increments a strictly monotonic, per-Persona
   `fencingToken`. Tokens are never reused, including after cancellation or crash.
3. Renewal compares workspace, Persona, Activity, lease id, owner, and token. A
   holder that fails renewal MUST stop Persona work and MUST NOT make new tool calls
   or Persona-state writes.
4. Every write that advances Persona-owned Activity, mailbox, WorkItem, memory,
   binding, or lifecycle state MUST carry the current Activity id and fencing token.
   The authoritative service rejects a stale token even if that worker once held a
   valid lease.
5. Expiry permits recovery by a new owner but does not make old writes safe. The
   higher fencing token is the final write barrier. Lifecycle labels such as
   `busy` or `waiting` are projections, not a substitute for the lease.
6. Mailbox inputs have durable ids and idempotency keys. Duplicate inputs are
   rejected or coalesced deterministically. Independent work queues; steering or
   coalescing into the active Activity is allowed only by explicit routing policy.
7. Meetings reserve the Persona through the same lease. Urgent interruption is a
   policy-controlled lease/activity transition, not a second concurrent Activity.
8. Tool calls with external side effects also need existing approval and
   idempotency controls. Fencing cannot retract an HTTP request already accepted by
   a third party, so the holder checks its lease immediately before dispatch and
   records an idempotency key/result before retrying.

Conversation locks and Flow run recovery remain lower-level mechanisms. They do not
prove that a Persona lease is held and cannot be used to bypass it.

### Memory trust and provenance

Memory is data, not an instruction channel. Every MemoryItem MUST carry `kind`,
`scope`, lifecycle `status`, content, confidence, importance, timestamps, and one
or more source references. It also carries exactly one trust classification:

| Trust value | Meaning | Automatic effect |
|---|---|---|
| `explicit_user` | A user explicitly asked to remember or correct the item | May become active under memory policy; still grants no tool/account authority. |
| `verified_tool` | Data came from an authenticated, identified tool result and retains that source | May become active after scope, freshness, and conflict checks; “verified” identifies the channel, not eternal truth. |
| `model_inference` | A model inferred or summarized it | Starts as a candidate and requires policy/review before core materialization. |
| `external_untrusted` | Webpages, messages, imported documents, or other untrusted observations | Remains quarantined/candidate by default and MUST NOT become instructions, core memory, or a Behavior change automatically. |

A source reference MUST be sufficient to inspect where a claim came from without
copying secrets: source type and durable record id, observed timestamp, workspace,
producer/tool identity where relevant, and a content digest or stable location.
Confidence is independent of trust. Repetition does not promote trust, and model
summaries preserve the trust/provenance of their inputs rather than laundering them
into a higher class.

Conflicting facts are retained and linked through supersession/conflict metadata;
new content does not silently overwrite old evidence. Corrections create an audit
event and superseding item (or equivalent history) while retrieval suppresses
superseded/forgotten content. Time validity and relationship/workspace scope are
enforced during retrieval.

Core memory is a small, inspectable materialized view of deliberately selected,
high-trust items. It is not “everything with a high score.” Consolidation runs as a
bounded, restricted Activity and may propose semantic facts, reflections, or
procedural hints; it cannot activate untrusted content, edit a BehaviorRevision, or
create a WorkItem without the relevant policy/approval. Existing summarizing
compaction is one candidate source and must retain links to its underlying records.

### Flow-only tool authority

The immutable Flow snapshot selected by a Behavior is the sole authority for that
execution’s tools:

- MCP server selection comes from the authored `boundServer`.
- Exposure comes from authored `enabledTools`.
- Roots/resources, Flow permission rules, approvals, prompts, and execution
  structure remain Flow-owned.
- Persona identity, Role capabilities, memory, direct-app grants, installed
  packages, and caller tools MUST NOT be unioned into or injected into a Behavior.
- There is no `BehaviorToolBinding`. Role capability declarations help factories
  resolve/materialize a suitable Flow; they are not runtime grants.
- A missing server/config/tool fails closed. Runtime resolution records the concrete
  named configuration identity/revision for audit without copying credentials.

Persona-specific accounts use existing distinct named MCP configurations such as
`github-jim` and `github-sarah`. A Behavior binds the intended concrete name. A
shared config MUST NOT be mutated per Activity: live client/environment state can
outlive one run. Persona direct-app/device grants, if introduced later, reference a
named config for use outside a Behavior and never widen Behavior tools.

Each invoked subflow remains authoritative for the tools authored in its own pinned
Flow snapshot. Neither parent tools nor Persona ambient state are injected into it.
Persona attribution is an audit/routing fact, not authorization.

### Workspace, attribution, and propagation

New and existing durable records use `workspaceId` as the isolation boundary. New
foreign keys SHOULD be workspace-qualified, and services MUST verify both sides of
every reference. Cache keys, lease keys, named MCP config lookup, filesystem homes,
and memory retrieval MUST include workspace identity.

Persona-aware integration adds these nullable/optional attribution fields to
conversations, runs, meetings/participant records, planned executions, trigger
deliveries, approvals, recovery records, WorkItems/tickets, voice sessions, and
audit/statistics events as applicable:

```text
personaId?          the Persona whose valid lease owns the Activity
activityId?         the unit of Persona life responsible for this work
behaviorRevisionId? the immutable revision actually selected for execution
```

Absence means intentionally Persona-less; it MUST NOT be backfilled by guessing
from a Flow name, account name, participant label, or historical text. Attribution
is stamped by the trusted Persona orchestrator after workspace and lease validation,
never accepted as authoritative from Flow variables, model output, webhook bodies,
or arbitrary client payloads.

Propagation is allow-listed:

| Invocation | Attribution behavior | Identity/private context behavior |
|---|---|---|
| Top-level Persona Behavior | Set all three fields from the resolved Persona, Activity lease, and immutable binding | Load only the identity/memory allowed by that Activity and policy. |
| Structural subflow pinned inside the same Behavior execution | Preserve Persona and Activity attribution for causal audit and fencing. Retain the Behavior revision only when that subflow is covered by its immutable dependency manifest; otherwise record the actual revision or leave it absent. | Does not gain extra memory, grants, accounts, or identity prompts. Its own Flow graph defines tools. |
| Assignment to another Persona | Enqueue in the target Persona mailbox and create a separate Activity/lease when scheduled | Never copy the caller’s lease or private context. Record a causal parent link. |
| Ephemeral worker or independently dispatched Flow | Persona-less by default; use parent run/event links for causality | Does not become the initiating Persona. Explicit same-Activity execution requires trusted orchestration and the current fencing token. |
| Legacy chat, Flow, meeting, schedule, trigger, or utility execution | Fields remain absent | Existing behavior is unchanged. |

Preserving attribution through a structural subflow does not make that Flow a
living Persona; it only says which leased Activity caused the descendant run. A
causal parent link and actor attribution must remain distinguishable in APIs and
analytics.

### Versioned schemas and additive migration

New domain records and immutable payloads carry an integer `schemaVersion`.
Readers dispatch by that version and reject unsupported future semantic versions
with a clear error rather than guessing. Writers emit the newest version they fully
understand.

Evolution follows these rules:

1. Existing record shapes gain only optional/nullable attribution fields. Existing
   values and meanings are not renamed or repurposed.
2. New tables/collections, indexes, and constraints are introduced through
   monotonic, idempotent, restart-safe migrations. Creation precedes backfill;
   validation/unique constraints are enabled only after existing data is proven
   valid.
3. No migration fabricates a Persona, Activity, Role pin, or Behavior revision for
   a historical record. Missing attribution remains the valid Persona-less state.
4. Defaults are applied at the service boundary for new records, not written into
   legacy records merely by reading them. Serializing an unchanged legacy record
   MUST NOT alter its execution semantics.
5. Unknown additive fields in JSON payloads are preserved by read/modify/write
   paths where possible. A writer that does not understand Persona metadata MUST
   NOT rewrite a Persona-aware record and accidentally strip it.
6. Immutable canonical payloads are never rewritten in place to a new semantic
   schema. An adapter may read an old schema; persisting changed semantics creates
   a new RoleVersion or BehaviorRevision with a new digest.
7. Workspace ownership and immutable-revision foreign keys are validated on every
   new write. Any staged migration that temporarily permits nulls must prevent new
   invalid rows at the service layer.
8. Migration state and failures are observable and compatible with existing
   backup/recovery and encryption-lock behavior.

The initial rollout order is additive: create new stores, add optional attribution
columns/fields, deploy tolerant readers, enable explicit Persona-attributed writes,
then add validated indexes/constraints. There is no bulk conversion of existing
Flows or conversations.

### Compatibility harness requirements

Legacy and lightweight Persona-less execution is a permanent supported mode. Before
runtime integration ships, checked-in fixtures captured from pre-Persona data MUST
prove the following:

| Fixture | Required proof |
|---|---|
| Flow definition and bounded history | Load, validate, edit/round-trip, and execute without a Role, Persona, Activity, or BehaviorRevision; graph, prompts, tool filtering, and permission behavior are unchanged. |
| Chat/conversation plus paused or resumable run | Open, append, pause/resume, steer, approve, recover, and summarize with absent attribution. No Persona is synthesized. |
| Meeting and participant records | Load and run existing Flow-based participants without Persona resolution or a Persona lease. |
| Planned execution, schedule, and trigger/webhook | Existing direct-Flow targets continue to dispatch after migration; idempotency and recovery semantics remain unchanged. |
| Subflow and ephemeral worker | Existing invocations remain Persona-less and receive no new identity, memory, or tools. |
| Export/import and backup/restore | Legacy records survive round-trip with equivalent semantics, including when optional new fields are absent. |

Fixtures MUST be immutable golden inputs rather than regenerated by the serializer
under test. Tests cover both absent fields and explicit Persona attribution, mixed
old/new records in one workspace, migration reruns after interruption, rejection of
cross-workspace references, and fail-closed behavior for unknown schema versions.
Persona metadata MUST NOT alter Flow compilation or MCP `boundServer` /
`enabledTools` filtering. Any implementation phase that breaks this harness is not
backward compatible.

### Deletion, retention, and export privacy

Phase 1 implements the native Persona-owned portion of this contract through
`GET /v1/personas/{personaId}/deletion-preview` and an explicitly confirmed
`DELETE /v1/personas/{personaId}`. The preview token binds confirmation to the
inspected workspace state. Deletion is idempotent, workspace-scoped, revokes
runtime authority before erasure, never cascades to Role or MCP configuration,
and retains only the selected minimal tombstone plus backup-policy disclosure.
Phase 2 stamps safe Persona attribution on the execution records described
above, but does not make Persona deletion a destructive cross-system cascade.
Concrete anonymization adapters for retained cross-system archives remain a
Phase 3 concern; the deletion manifest declares that policy explicitly rather
than silently erasing, orphaning, or claiming to anonymize those records.

Deleting or exporting a Persona is a privacy-sensitive workflow, not a generic
cascade or a raw workspace dump.

Deletion MUST first produce a preview grouped by owned live state (mailbox, active
Activity, WorkItems, memory, Behavior bindings/revisions and homes), referenced
archive evidence (runs, conversations, meetings, approvals and audit events), and
external/shared resources (named MCP configs and artifacts). It then requires an
explicit policy choice for records that must be retained or anonymized.

Before deletion, new work is disabled, the mailbox is closed, and an active lease
is revoked/expired through the lease protocol. Persona-owned private material is
erased subject to declared retention policy. Historical evidence that must remain
uses a minimal deleted-actor tombstone or anonymized attribution so references do
not dangle; it MUST NOT retain retrievable memory or account bindings under the
guise of audit. “Immutable revision” means no semantic editing, not exemption from
authorized privacy erasure. Backup retention and eventual purge timing are shown in
the preview/audit trail.

Deleting a Persona removes its grants/bindings but MUST NOT automatically delete a
workspace MCP configuration that may be shared or separately owned. Conversely,
retaining a config does not retain permission to impersonate the deleted Persona.

Default export is configuration-only: a reviewed Role or Persona template and
sanitized Behavior/Flow templates. It excludes memory/core memory, WorkItems,
mailbox, conversations, runs/tool results, meetings/private Activity, credentials,
OAuth state, account bindings, direct-app grants, private filesystem content, and
private presentation/relationship data. Concrete account config names, secrets,
tokens, headers, environment variables, and private paths are replaced by declared
capability placeholders. Any category-specific private export is explicit,
encrypted where appropriate, listed in a manifest, and subject to workspace access
checks. Import never turns exported observations into active memory automatically.

## Threat model and required mitigations

The trusted control plane is FLUJO’s workspace-authenticated services, schema
validation, lease store, and execution orchestrator. Model output, Flow variables,
webhooks, imported files, external pages, tool result content, and remote MCP data
are untrusted data even when their transport is authenticated.

| Threat | Failure mode | Required controls |
|---|---|---|
| Memory poisoning / indirect prompt injection | External text becomes identity, instructions, core memory, or a behavioral lesson | Trust labels and source refs; candidate quarantine; instruction/data separation; bounded consolidation; conflict/freshness checks; explicit correction/forget UI; no automatic core promotion or Behavior activation. |
| Confused-deputy tool use | A Persona, model, memory item, or caller causes a Behavior to use ambient tools/accounts | Flow-only `boundServer` + `enabledTools` authority; fail-closed resolution; existing approvals; trusted attribution stamping; memory never grants authority; no `BehaviorToolBinding` or Persona tool union. |
| Cross-Persona account leakage | Jim’s execution reuses Sarah’s credentials, client, cache, home, or OAuth state | Distinct named configs and homes; workspace/config identity in client/cache keys; no per-Activity mutation of shared configs; audit resolved config identity; direct-app grants separated from Behavior execution; isolation tests. |
| Lease split-brain | Expired/recovered worker and new worker both mutate one Persona | Atomic acquire/renew; authoritative time; monotonic fencing token checked on every Persona-state write; heartbeat/expiry; idempotent mailbox inputs and external operations; stop dispatch after renewal loss; recovery tests. |
| Attribution/context forgery | Webhook, client, model, or subflow claims a Persona id to access private state | Orchestrator-issued context only after workspace, binding, and lease validation; workspace-qualified references; allow-listed propagation; causal links distinguished from actor identity; tokens never placed in prompts or Flow variables. |
| Revision tampering or time-of-check/time-of-use drift | A published Behavior changes when its source Flow/subflow is edited or history is pruned | Canonical immutable snapshots, pinned dependency manifest, content digest verification, append-only revisions, audited compare-and-swap activation, fail closed on missing/corrupt dependencies. |
| Cross-workspace disclosure | Guessed ids, cache collisions, retrieval, or export crosses tenant boundaries | Workspace-qualified storage/service checks, cache and filesystem namespaces, scoped memory retrieval, export authorization, cross-workspace negative fixtures. |
| Deletion/export privacy failure | Raw private life or credentials leak in a template, or cascading delete destroys required evidence | Preview and manifest; configuration-only default; category allow-list and redaction; secret scanning; explicit retention/anonymization; non-cascading shared config handling; auditable backup purge policy. |

## Consequences

- Persona continuity is built above existing execution locks rather than hidden
  inside Flow or conversation state.
- Published Behaviors consume durable storage because their executable snapshots
  cannot rely on prunable history. That cost buys reproducibility and reversible
  activation.
- Attribution is optional and cannot be treated as authorization. Existing quick
  chats, utility Flows, meetings, schedules, subflows, and workers remain valid
  without a Persona.
- Factories and Role capability resolution may suggest or materialize tool bindings,
  but the resulting Flow graph is always the runtime authority.
- Privacy erasure may replace immutable private records with minimal tombstones;
  auditability does not justify retaining the private payload indefinitely.

## Deferred by this record

- Distributed/cross-host lease backends and any future indexed storage-engine layout.
- Shared Behavior instances across Personas or cross-workspace living Personas.
- Logical account-slot substitution for shared Behaviors.
- Direct Persona app/device grants and rich Persona UI.
- Automatic behavioral self-modification, voice/avatar rendering, and package
  portability.
- Renaming existing UI navigation or persisted Flow concepts.

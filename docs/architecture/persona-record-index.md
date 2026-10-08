# Persona record indexes

Persona memory, mailbox, Activity, work-item, and lease-history collections use
workspace-local JSON sidecars under `db/`. The sidecars are derived data;
collection records remain the source of truth. Lease history uses
`persona-lease-history.index.json` with
`persona-lease-history.generation.json`, and its source records are sharded at
`db/persona-lease-history/<personaId>/<recordId>.json`.

## Ownership

Workspace-global scan elimination belongs to epic #448 lane 1 (scaling and
indexing), following #449's sidecar precedent. Retention and compaction remain
owned by #453 and consume the bounded indexed APIs without changing their
logical storage-statistics contract. Issue #480 records this decision.

## Contract

Every current sidecar is a `PersonaRecordIndex` with:

- `recordKind: "PersonaRecordIndex"` and the current `schemaVersion`;
- the exact collection name;
- monotonically advancing `revision` and matching `sourceRevision`;
- `sourceCount`, deterministic `generatedAt` (the maximum entry `updatedAt`, or
  zero for an empty collection), and entries sorted by record ID;
- unique, runtime-validated entries. Memory and mailbox statuses are checked against
  their domain status sets. Lease-history entries map `renewedAt` to the common
  `updatedAt` index field.

A validated empty index is valid and is not confused with a missing sidecar.

## Freshness and recovery

Each index has a small generation file. An indexed mutation is serialized per
workspace and collection:

1. persist the next generation with `dirty: true`;
2. atomically save or delete the source record;
3. atomically replace the index at the same generation;
4. clear the dirty marker.

A missing, corrupt, future-version, count-mismatched, revision-mismatched, duplicate,
unsorted, or dirty index is rebuilt from the source collection on the next read.
This protocol deliberately makes interrupted writes self-healing instead of allowing
a committed record to remain silently absent from indexed reads.

Legacy workspaces with records but no index or generation files rebuild
transparently on first read. Legacy v1 index records have an explicit
`PersonaRecordIndex` migration for tooling and fixtures; on-disk sidecars without
freshness metadata are conservatively rebuilt.

Warm reads filter index entries by Persona before opening source record files. A
malformed record owned by another Persona is therefore outside the read set and
cannot block the target Persona. Runtime storage statistics consume these bounded
Persona reads for mailbox, Activity, and lease history; flow-dispatch statistics
remain workspace-global until that collection has its own index.

Persona gallery projections use the memory, mailbox, Activity, and work-item
sidecars for the requested page. Role versions remain global because they are
shared immutable records, while behavior bindings and app grants remain residual
global collections pending their own ownership/cardinality decision.

## Performance tests

Large wall-clock benchmarks are opt-in:

```powershell
$env:FLUJO_PERF_TESTS = '1'
npm test -- __tests__/enduringAgents/memoryScanPerf.test.ts
```

Absolute latency is not a default CI gate because shared runners and filesystem
caches vary substantially. Default acceptance coverage uses deterministic file-read
sets, entry counts, and scale-invariance assertions; opt-in runs may additionally
record p95 latency and machine/filesystem context.

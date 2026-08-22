# Persona record indexes

Persona memory, mailbox, Activity, and work-item collections use workspace-local JSON
sidecars under `db/`. The sidecars are derived data: collection records remain the
source of truth.

## Contract

Every current sidecar is a `PersonaRecordIndex` with:

- `recordKind: "PersonaRecordIndex"` and the current `schemaVersion`;
- the exact collection name;
- monotonically advancing `revision` and matching `sourceRevision`;
- `sourceCount`, deterministic `generatedAt` (the maximum entry `updatedAt`, or
  zero for an empty collection), and entries sorted by record ID;
- unique, runtime-validated entries. Memory and mailbox statuses are checked against
  their domain status sets.

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
cannot block the target Persona.

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

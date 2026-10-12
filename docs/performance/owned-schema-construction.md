# Owned tool schema construction and archive metadata

This Source candidate adds constructor-metered tool schemas and immutable archive
descriptors. Runtime, compiler and SDK qualification are **UNRUN** for this head.
It does not close the original #520 failure or establish a total heap/RSS bound.

The public JSON-schema converter and Claude tool factory construct actual Zod
schemas for provider validation. At the same time they construct immutable JSON
descriptors of the represented converter semantics. Archiving a registered
schema uses that descriptor without invoking `z.toJSONSchema`, cloning its
private graph, or interpreting declarative property names as runtime secrets.
Claude also records the corresponding tool property descriptors in SDK request
metadata. The factory shares one construction meter across all tools in that
invocation. Canonical history assertions and the original 47 memory controls
remain unchanged.

| Proposed constructor limit | Value |
| --- | --- |
| Declarative input representation per input | 1 MiB |
| Inspected input values per input | 16,384 |
| Shared construction work units | 4,096 |
| Shared represented allocation allowances | 8 MiB |
| Input depth / reference depth | 48 / 8 |

These are conservative work and representation allowances, not measured library
allocations. Input normalization uses own data descriptors and null-prototype
copies. Proxies, accessors, cycles, private objects, sparse arrays, nonfinite
numbers and `__proto__` keys are rejected before construction. This deliberately
restricts arbitrary JavaScript inputs to declarative data. Missing fields cannot
invoke inherited getters. Supported conversion retains the original reference
fallbacks, inclusive unions, intersections, optional fields, descriptions and
passthrough objects; exact equality is a qualification requirement, not a result
already established by this Source candidate.

Archive policy defaults to `legacy-unbounded` to preserve ordinary existing
unowned Zod compatibility. That route retains the full 256 MiB write reservation
and official projector, including its known allocation-before-measurement gap.
An explicit `owned-only` policy rejects unowned schemas before the archive
callback. No global compatibility loss is being counted as an OOM fix.

Owned metadata assumes the constructed schemas are not subsequently mutated by
host code or global Zod metadata changes. Weak registration does not cap schema
residency across invocations and is not a replacement for the shared archive
ledger. Other provider SDKs and arbitrary unowned schemas remain on the existing
compatibility path. This candidate does not establish a bound for their hooks or
for all process allocations.

Qualification must run the unchanged original memory suites separately from
`ownedArchiveSchema.test.ts`, the whole converter suite and Claude adapter
compatibility suites. The new suite compares against a preserved pre-change
converter fixture, validates actual Zod parsing, exercises actual archive
write/read without a projector, checks shared constructor admission and checks
explicit rejection separately from default unowned compatibility. Failed or
uncertain archive fixtures are preserved. No test, typecheck, provider request
or runtime measurement was performed in the Source lane.

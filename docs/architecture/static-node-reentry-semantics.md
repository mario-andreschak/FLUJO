# Static Node Re-entry Semantics

## Context

A Static node appends authored messages or synthetic tool-call/result pairs to the conversation, then passes control to its successor. Re-entry is therefore observable: a node can be reached repeatedly by loops, retries, or conditional paths. This record ratifies the behaviour introduced in #358 (commit `75cd9188`) and clarified by #381.

## Decision

| Rule | Normative behaviour |
|---|---|
| Default | A Static node MUST append its entries on every traversal. |
| `injectOnce` | `false` or omission means append on every traversal; only literal `true` means inject once. |
| Scope | Once-only bookkeeping is per run, keyed by Static node id in `SharedState.staticInjected`. |

Append is the default because a Static node is a replay device: loop scaffolding and per-iteration reminders must be present on every iteration, with variables resolved at that time. The decompiler omits `injectOnce` unless it is `true`, so omission remains the compact representation of the default. Hand-edited non-boolean values, including `"true"`, are ignored and behave as `false`; FlowSpec compilation warns.

## Scope and lifecycle

| Boundary | `staticInjected` |
|---|---|
| Later traversal in the same run | Preserved |
| Pause then resume / serialized state restore | Preserved |
| Child subflow invocation (`runDepth + 1`) | Fresh and empty |
| Return from subflow | Parent map is unaffected |
| New run or conversation | Fresh and empty |

An entry reached only after a conditional skip still injects: the map is updated by execution, not reachability. Nested loops append on every entry by default; with `injectOnce: true`, they inject exactly once for the whole run. There is no per-outer-iteration mode.

## Examples

Few-shot examples inside a retry loop should normally be one-time:

```json
{ "type": "static", "entries": [{"kind":"message","role":"user","content":"Example input"}], "injectOnce": true }
```

A per-iteration reminder uses the default and sees updated run variables:

```json
{ "type": "static", "entries": [{"kind":"message","role":"system","content":"Attempt ${var:attempt}: verify the result."}] }
```

A synthetic `toolCall` entry creates an assistant tool call and matching tool result; it is commonly one-time so the model does not receive the same seed repeatedly. Static nodes can also be placed on a conditional branch: they inject the first time that branch is actually reached.

## Edge cases

- Empty entries are a legal no-op. They do not mark `staticInjected`, so entries supplied later in the same run can still inject.
- Each injection creates fresh message ids, timestamps, and tool-call ids. Dedupe by message content is intentionally not used.
- `${var:...}` and `${res:...}` resolve at every injection.
- Static system entries are independent of StartNode's system-message handling. StartNode has one known prompt and can inspect the message list; many Static nodes can have arbitrary entries, so explicit per-node bookkeeping is required.
- Duplicated node ids are invalid flow identity: they share the same once-only key.

## Validation rules

| Layer | Rule | Outcome |
|---|---|---|
| FlowSpec | Invalid/non-object entry, role, kind, or incomplete tool call | Drop + `static-invalid-entry` |
| FlowSpec | Non-empty invalid `argumentsJson` | Keep + `static-toolcall-invalid-json` |
| FlowSpec | More than 200 entries | Truncate + `static-too-many-entries` |
| FlowSpec | No valid entries | Legal no-op + `static-no-entries` |
| FlowSpec | `injectOnce` present but not boolean | Ignore + `static-invalid-injectonce` |
| Runtime | Entries not an array | Treat as `[]` |
| Runtime | `injectOnce` not exactly `true` | Treat as `false` |
| Runtime | Invalid tool-call JSON at execution | Fail loudly |

## Future work

If authors need a middle ground, a future backward-compatible scope enum could add `per-subflow` or `per-outer-iteration`. This record does not add those modes.

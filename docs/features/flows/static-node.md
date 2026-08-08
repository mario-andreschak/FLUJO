# Static node

A Static node is a deterministic, non-LLM pass-through node. When a run reaches it, the node appends its authored entries to the conversation in order, then continues through its first outgoing edge. It is useful for system-prompt scaffolding, few-shot context, and synthetic tool exchanges.

Static nodes are an **Advanced** FlowSpec feature. They are unavailable in Guided/simple authoring. For the inclusion and round-trip policy, see the [FlowSpec node-type inclusion policy](../../architecture/flowspec-node-inclusion-policy.md).

## Entry schema

```ts
type StaticEntry =
  | { kind: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | { kind: 'toolCall'; toolName: string; argumentsJson: string; result: string };
```

| Entry | Required fields | Effect |
|---|---|---|
| `message` | `role`, `content` | Appends one message with the selected role. |
| `toolCall` | `toolName`, `argumentsJson`, `result` | Appends an assistant tool call followed immediately by its matching tool result. |

The node property `injectOnce` defaults to `false`. When false, entries are appended on every traversal (including loops). When true, a node injects only on its first traversal in a run.

## Common patterns

### System prompt scaffolding

Put a Static node before a Process node to add stable instructions without invoking a model:

```json
{
  "type": "static",
  "entries": [
    { "kind": "message", "role": "system", "content": "Answer concisely and cite supplied evidence." },
    { "kind": "message", "role": "user", "content": "Use the following request as the task." }
  ]
}
```

Entries retain their authored order, so place each message exactly where it should appear in the conversation.

### Few-shot synthetic tool exchange

A `toolCall` entry models a prior assistant tool call and its result. This can show a Process node the shape of a successful tool interaction:

```json
{
  "kind": "toolCall",
  "toolName": "read_file",
  "argumentsJson": "{\"path\":\"README.md\"}",
  "result": "# Project README\n..."
}
```

The node creates a valid assistant/tool pair with one shared `tool_call_id`. `toolName` is free-form: it is not resolved against the active tool list, so choose a name that makes sense to the model and the intended example.

### Variables and run resources

Every text field (`content`, `argumentsJson`, and `result`) resolves run variables before run resources:

```json
{
  "kind": "toolCall",
  "toolName": "lookup_customer",
  "argumentsJson": "{\"id\":\"${var:customerId}\"}",
  "result": "Profile: ${res:customerProfile}"
}
```

- `${var:NAME}` reads the run variable named `NAME`.
- `${res:NAME}` reads the named run resource.
- Unknown variables or resources resolve to an empty string. Resource failures also do not stop the run.

Resource contents are resolved after variable substitution. The resolution is not recursive: placeholders inside a resource's contents remain literal.

## Validation and limitations

| Situation | What happens | Guidance |
|---|---|---|
| No entries | Authoring validation reports `static-no-entries`; runtime passes through without adding messages. | Add at least one entry before relying on this node. |
| Missing tool name | Authoring validation reports `static-toolcall-missing-name`; runtime throws. | Provide a non-empty `toolName`. |
| Invalid `argumentsJson` | Authoring validation and FlowSpec compilation report `static-toolcall-invalid-json`; runtime throws before injecting the pair. | Use valid JSON, not JavaScript object syntax. |
| Malformed FlowSpec entry | The compiler drops it and warns `static-invalid-entry`. | Use only the schema shown above. |
| Too many entries | The compiler caps the list and warns `static-too-many-entries`. | Keep the authored list focused. |
| Re-entry | Entries are appended again by default. | Enable `injectOnce` when a loop must not duplicate context. |

A tool-call entry validates only that its name is non-empty and its arguments parse as JSON. The Static node does not execute the call, verify that a tool is registered, or validate the arguments against a tool schema.

## Authoring

In FlowBuilder, add a **Static** node, choose **Add message** or **Add tool call**, and connect it to the next step. The modal validates tool-call JSON before saving.

In FlowSpec, use a `static` node with `entries` and optional `injectOnce`. Static nodes survive FlowSpec compile/decompile round trips when their entries conform to the schema.

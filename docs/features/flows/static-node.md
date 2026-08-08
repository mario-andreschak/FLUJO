# Static node

A Static node is a deterministic, non-LLM pass-through node. When a run reaches it, the node appends its authored entries to the conversation in order, then continues through its first outgoing edge. Use it for system-prompt scaffolding, few-shot context, deterministic context seeding, and synthetic tool exchanges.

Static nodes are an **Advanced** FlowSpec feature. They are unavailable in Guided/simple authoring. For the inclusion and round-trip policy, see the [FlowSpec node-type inclusion policy](../../architecture/flowspec-node-inclusion-policy.md).

## When to use a Static node

Use a Static node when content must be present in the conversation without calling a model or executing a tool. Common cases include:

- Adding stable system or user instructions before a Process node.
- Showing a model a prior tool-call and tool-result pair as a few-shot example.
- Inserting values from run variables or run resources into authored context.
- Replaying a known tool result in a demo or test flow.

## Add a Static node

1. In FlowBuilder, drag a **Static** node from the palette onto the canvas.
2. Open the node's properties.
3. Add a message or tool-call entry, then fill in its fields.
4. Reorder entries so they appear in the intended conversation order.
5. Optionally enable **Inject once** when the node can be revisited in a loop.
6. Save the node and connect it to the next step.

The modal validates tool-call JSON before it can be saved.

## Entry and property reference

```ts
type StaticEntry =
  | { kind: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | { kind: 'toolCall'; toolName: string; argumentsJson: string; result: string };

interface StaticNodeProperties {
  name?: string;
  entries?: StaticEntry[];
  injectOnce?: boolean;
}
```

| Field | Type | Required | Description | Variable/resource substitution |
|---|---|---:|---|---|
| `name` | string | No | Optional node label. | No |
| `entries` | `StaticEntry[]` | No | Ordered content to append. | Per entry field |
| `injectOnce` | boolean | No | Inject only on the first traversal in a run; defaults to `false`. | No |
| `role` | `system\|user\|assistant` | Yes for a message | Role of a message entry. | No |
| `content` | string | Yes for a message | Message text. | Yes |
| `toolName` | string | Yes for a tool call | Function name in the synthetic assistant call. | No |
| `argumentsJson` | string | Yes for a tool call | JSON-encoded function arguments; empty means no arguments. | Yes |
| `result` | string | Yes for a tool call | Content of the matching synthetic tool result. | Yes |

A `message` entry creates one conversation message. A `toolCall` entry creates two: an assistant message with a tool call, followed immediately by its matching tool-result message.

## Common patterns

### System-prompt scaffolding

Place a Static node before a Process node to add stable instructions without invoking a model:

```json
{
  "type": "static",
  "entries": [
    { "kind": "message", "role": "system", "content": "Answer concisely and cite supplied evidence." },
    { "kind": "message", "role": "user", "content": "Use the following request as the task." }
  ]
}
```

Entries retain their authored order, so place each message exactly where it belongs.

### Few-shot synthetic tool exchange

A `toolCall` entry models a prior assistant tool call and its result:

```json
{
  "kind": "toolCall",
  "toolName": "read_file",
  "argumentsJson": "{\"path\":\"README.md\"}",
  "result": "# Project README\n..."
}
```

The node creates a valid assistant/tool pair with one shared `tool_call_id`. It does not execute this call.

### Variables and run resources

Text fields (`content`, `argumentsJson`, and `result`) resolve run variables before run resources:

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
- Unknown variables or resources resolve to an empty string and emit a console warning.
- Resource contents resolve after variables, and resolution is not recursive.

Keep the final substituted `argumentsJson` valid JSON. The modal validates the authored value, while execution parses the resolved value.

### Avoiding duplicate context on re-entry

By default, a Static node injects entries on every traversal. In loops or multi-turn flows, enable `injectOnce` to inject only the first time that node is visited during a run. The setting is per run and per node ID; routing still continues when a repeat visit skips injection.

## Validation and limitations

| Situation | What happens | How to resolve it |
|---|---|---|
| No entries | Authoring validation reports `static-no-entries`; runtime passes through without adding messages. | Add an entry. |
| Missing tool name | Authoring validation reports `static-toolcall-missing-name`; runtime throws `Static node <nodeId>: a tool-call entry requires a tool name.` | Provide a non-empty `toolName`. |
| Invalid `argumentsJson` | Authoring validation and FlowSpec compilation report `static-toolcall-invalid-json`; runtime throws `Static node <nodeId>: tool-call entry for "<toolName>" has invalid JSON arguments.` | Use valid JSON, not JavaScript object syntax. |
| Malformed imported FlowSpec entry | The compiler drops it and warns `static-invalid-entry`. | Use only the schema shown above. |
| More than 50 entries | The compiler caps the list and warns `static-too-many-entries`. | Keep the list focused. |
| Unknown entry kind | Runtime throws `Static node <nodeId>: unknown entry kind.` | Use `message` or `toolCall`. |

A tool-call entry validates only that its name is non-empty and its arguments parse as JSON. The Static node does not execute the call, check that the tool is registered, add a server prefix, or validate arguments against a tool schema. A misspelled name still becomes synthetic context that a model may imitate.

Static nodes do not call a model or consume tokens by themselves, but their injected messages increase context for later model calls. Imported or untrusted FlowSpecs are sanitized, so malformed entries can be silently discarded in addition to compiler warnings.

## Troubleshooting

### The Save button is disabled

Check every tool-call entry's `argumentsJson`. It must be valid JSON, including quoted property names and string values.

### The flow fails with invalid JSON arguments

A substituted variable or resource may have made `argumentsJson` invalid. Inspect resolved values and ensure the completed string remains valid JSON.

### My entries appear twice

The flow revisited the node. Enable **Inject once** if entries should appear only once per run.

### My variable or resource came out empty

Verify its name and that it is available for the run. Unknown `${var:...}` and `${res:...}` references resolve to an empty string.

### The model ignores my injected tool result

A Static node adds an example; it does not execute or register a tool. Use a realistic tool name, arguments, and result, and explain in the surrounding prompt how the example should guide the model.

## Related

- [Flow node reference](./README.md)
- [FlowSpec node-type inclusion policy](../../architecture/flowspec-node-inclusion-policy.md)

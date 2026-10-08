# Static node

A Static node is a non-LLM pass-through node. When a run reaches it, the node appends its authored entries to the conversation in order, then continues through its first outgoing edge. Messages and mocked tools are deterministic; a real tool-call entry executes its connected MCP tool at that point in the sequence. Use it for system-prompt scaffolding, few-shot context, deterministic context seeding, synthetic tool exchanges, and fixed MCP operations that do not need a model to decide when to call them.

Static nodes are an **Advanced** FlowSpec feature. They are unavailable in Guided/simple authoring. For the inclusion and round-trip policy, see the [FlowSpec node-type inclusion policy](../../architecture/flowspec-node-inclusion-policy.md).

## When to use a Static node

Use a Static node when an authored conversation sequence must run without asking a model to decide what happens next. Common cases include:

- Adding stable system or user instructions before a Process node.
- Showing a model a prior tool-call and tool-result pair as a few-shot example.
- Inserting values from run variables or run resources into authored context.
- Replaying a known tool result in a demo or test flow.
- Running a fixed MCP operation at a precise point in the sequence.

## Add a Static node

1. In FlowBuilder, drag a **Static** node from the palette onto the canvas.
2. Open the node's properties.
3. Add a message or tool-call entry. Messages use the chat-style composer with references and attachments. For a tool call, choose **Real call at runtime** or **Mocked result**, then pick its MCP server/tool and fill the schema-driven parameter form.
4. For a mock, either author the result or select **Run & use as mock** to execute the selected tool now and capture both its parameters and result.
5. Reorder entries so they appear in the intended conversation order.
6. Optionally enable **Inject once** when the node can be revisited in a loop.
7. Save the node and connect it to the next step.

Saving reconciles MCP graph wiring automatically. The Static node gets one connected MCP node per server used by its real calls. Several real calls on the same server share that MCP node, and their tool names are merged into its enabled-tool list.

The modal validates tool-call JSON before it can be saved. Arguments that contain
`${var:…}` / `${res:…}` placeholders are exempt from that check, because they only become
JSON once the placeholders resolve at run time.

## Entry and property reference

```ts
type StaticEntry =
  | {
      kind: 'message';
      role: 'system' | 'user' | 'assistant';
      content: string;
      attachments?: StaticAttachment[];
    }
  | {
      kind: 'toolCall';
      toolName: string;
      argumentsJson: string;
      result: string;
      executionMode?: 'mock' | 'real';
      serverName?: string;
      captureVariable?: string;
      resultFormat?: 'text' | 'json';
      onError?: 'continue' | 'fail';
    };

interface StaticNodeProperties {
  name?: string;
  entries?: StaticEntry[];
  injectOnce?: boolean;
  outputTemplate?: string;
}
```

| Field | Type | Required | Description | Variable/resource substitution |
|---|---|---:|---|---|
| `name` | string | No | Optional node label. | No |
| `entries` | `StaticEntry[]` | No | Ordered content to append. | Per entry field |
| `injectOnce` | boolean | No | Inject only on the first traversal in a run; defaults to `false`. | No |
| `role` | `system\|user\|assistant` | Yes for a message | Role of a message entry. | No |
| `content` | string | Yes for a message | Message text. | Yes |
| `attachments` | `StaticAttachment[]` | No | Chat-style message attachments. Text documents are appended to content; supported binary media is attached to the message. | Text documents only |
| `toolName` | string | Yes for a tool call | Function name in the assistant tool call. | No |
| `argumentsJson` | string | Yes for a tool call | JSON-encoded function arguments; empty means no arguments. | Yes |
| `result` | string | Yes for a mock | Authored mock result. Ignored/replaced with the actual result for real calls. | Mocks only |
| `executionMode` | `mock\|real` | No | Whether to inject the authored result or execute MCP at runtime. Missing defaults to `mock`. | No |
| `serverName` | string | Yes for a real call | MCP server used for selection, graph wiring, and execution. Optional metadata for a mock. | No |
| `captureVariable` | string | No | Save this entry's bounded result snapshot in a run variable. Names start with a letter or `_`, followed by letters, digits, `_` or `-`. | No |
| `resultFormat` | `text\|json` | No | Capture text blocks (default) or structured MCP JSON. Affects captures only. | No |
| `onError` | `continue\|fail` | No | Real-call policy; default `continue` preserves context injection. `fail` stops on service failure or MCP `isError: true`. | No |
| `outputTemplate` | string | No | Node-level output resolved after the entries, exported as an assistant response. | Yes |

A `message` entry creates one conversation message. Text documents are appended to its text and binary/image/audio/video attachments become message media. A `toolCall` entry creates two messages: an assistant message with a tool call, followed immediately by its matching tool-result message.

`executionMode: 'mock'` injects the authored `result`. It is also the default when `executionMode` is absent, preserving old Static nodes. `executionMode: 'real'` requires `serverName`, a connected MCP node for that server, and the selected tool in that node's `enabledTools`; the runtime executes the tool and injects its actual result. A tool error is injected as `Error: …`, while missing/incorrect graph wiring fails the node explicitly.

## Common patterns

### Deterministic output and failure policy

For a model-free health check, connect Start → Static → Finish and configure the Static step as follows:

```json
{
  "key": "probe",
  "type": "static",
  "outputTemplate": "${var:health}",
  "entries": [{
    "kind": "toolCall",
    "executionMode": "real",
    "serverName": "bash",
    "toolName": "run",
    "argumentsJson": "{\"command\":\"printf healthy\"}",
    "result": "",
    "captureVariable": "health",
    "resultFormat": "text",
    "onError": "fail"
  }]
}
```

Capture distinct variables for several calls; `outputTemplate` selects the desired result even if another tool ran last. Captures are available immediately to later entries and nodes through `${var:NAME}`. The explicit template sets `lastResponse` and adds an assistant output message, so Finish, API output, terminal events, and scheduled history use that response. A later responding stage can replace it normally. Without a template, context-injection defaults remain unchanged. A separate empty Static step can select previously captured variables. On an `injectOnce` revisit, entries stay skipped and the optional output template is re-resolved from the run variables.

For output templates, authored resource/dynamic references resolve first and run variables are inserted last. Reference-like text inside a captured result is always literal data; it cannot trigger a resource read, global-variable lookup, or dynamic-reference expansion.

`text` joins MCP text blocks and textual embedded resources with newlines. Media is explicitly marked as omitted; structured-only results direct the author to JSON capture. `json` preserves the protocol envelope, including `structuredContent` and `isError`, but replaces inline image/audio/video data and resource blobs with omission markers. Mock text capture is the authored result; JSON capture parses valid authored JSON, or stores ordinary text as a JSON string. The original tool message stays unchanged.

Captures and resolved output templates are capped at 65,536 characters. Text includes a truncation marker; oversized JSON becomes a parseable `{ "truncated": true, "originalChars": ..., "preview": ... }` envelope. Scheduler history then applies its existing 4,096-character output limit, so a truncated history preview may no longer be parseable JSON. History retains the selected result with `saveConversations: false` without persisting an ephemeral transcript. Variables and successful outputs remain plaintext; tools should avoid returning private secrets.

`onError: 'fail'` is valid only for real calls. Service/transport failure, timeout, or MCP `isError: true` stops remaining entries, skips the success edge, and does not export the success template. The API preserves bounded structured failure metadata (`type`, `code`, tool `name`, server `param`, optional HTTP `status`). Scheduled history retains the message and this classification even for ephemeral runs. Error messages use existing error redaction rules and a 2,048-character cap. Static has no authored error branch; unsupported policy values and `fail` on a mock are validation errors.

The engine never infers failure from arbitrary `exitCode`, application JSON, stderr, or stdout. Bash explicitly maps nonzero process exits to MCP `isError`; other servers must report their protocol error flag. `continue` retains paired error context for a downstream model to inspect or recover. User cancellation always stops the run and reaches in-flight MCP calls regardless of this policy.

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

### Mocked tool exchange

A `toolCall` entry models a prior assistant tool call and its result:

```json
{
  "kind": "toolCall",
  "executionMode": "mock",
  "serverName": "filesystem",
  "toolName": "read_file",
  "argumentsJson": "{\"path\":\"README.md\"}",
  "result": "# Project README\n..."
}
```

The node creates a valid assistant/tool pair with one shared `tool_call_id`. It does not execute this call during the flow. In the editor, **Run & use as mock** may execute it once during authoring and capture the returned payload.

### Real MCP tool call

```json
{
  "kind": "toolCall",
  "executionMode": "real",
  "serverName": "filesystem",
  "toolName": "read_file",
  "argumentsJson": "{\"path\":\"README.md\"}",
  "result": ""
}
```

The Static node executes `filesystem/read_file` every time this entry is reached (subject to `injectOnce`). Its MCP attachment is configuration wiring, not a control-flow successor.

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

### Dynamic references and fixed tool parameters

Static messages, mock results, and JSON argument values also resolve dynamic
references such as `@current.conversation.id`, `@current.flow.id`, and `@current.node.id` from the current
execution. JSON values resolve after parsing, preserving nested objects and quoted
names. Conversation IDs retain their original form, including Slack thread IDs.

For real MCP calls, server parameter presets apply first and connected MCP node
presets override them per parameter. These presets override the authored call's
arguments, matching Process-node dispatch. Fixed values resolve immediately before
the MCP call and are excluded from the assistant tool-call message added to model
history. Tool results can still disclose values returned by the server.

An enabled preset whose value is an empty string is still a fixed parameter. Disable
the preset to allow the model or authored call to supply that parameter. A trusted
customer binding must come from server-controlled configuration; `@conversation.id`
provides correlation and does not authenticate the customer. See the
[complete command reference](../dynamic-references.md) for current context,
entity pickers, aliases, and available fields.

## Re-entry semantics

A Static node can be traversed more than once in a single run — inside a loop, or via two
branches that both lead to it. What happens on the second visit is controlled by one
optional property, `injectOnce`.

### The rule

| `injectOnce` | Behaviour on every traversal | Default |
|---|---|:--:|
| omitted / `false` | **Append.** The entries are added again, with `${var:…}` and `${res:…}` re-resolved at that moment, so repeated injections can differ in content. | ✅ |
| `true` | **Inject once per logical run.** The first traversal injects; later traversals of the same node in the same run are skipped. | |

Append-on-every-traversal is the default because a Static node is a *deterministic replay
of a conversation fragment*: passing through it again normally means the fragment is wanted
again. Only the strict value `true` enables the once-per-run mode — any other value
(including the string `"true"`) is treated as "append".

Routing is unaffected either way: a skipped injection still passes through to the node's
first successor.

### The dedupe key: `(logical run, node ID)`

When a Static node injects, the engine records a marker on the run state
(`SharedState.staticInjected`) that maps the **node ID** to the **logical run ID** that
injected it. `injectOnce` suppresses an injection only when that marker matches the run
that is executing right now.

A *logical run* is one user turn of a conversation (and, independently, one execution of a
subflow). It is preserved while a run is paused for tool approval or debugging, and a new
one starts for every new user message. This gives the following, deliberately chosen,
scoping:

| Scope | Does an `injectOnce` node inject again? |
|---|---|
| Second traversal in the same run (loop, second branch) | No |
| Resume after tool approval or a debug pause | No — same logical run |
| New user turn in the same conversation | **Yes** — new logical run |
| Each subflow execution | Yes — a subflow has its own run state and its own markers |
| A copy of the node (new node ID) | Yes — it has its own budget |

"Once per *conversation*" is intentionally not offered. Put content that must appear
exactly once per conversation in the Start node's system prompt instead.

### Worked example: a three-iteration loop

A Static node with a single `user` entry `"Remember: ${var:CRITERIA}"` inside a loop that
runs three times:

| Iteration | `injectOnce` omitted (default) | `injectOnce: true` |
|---|---|---|
| 1 | message appended (criteria v1) | message appended |
| 2 | message appended (criteria v2, re-resolved) | skipped |
| 3 | message appended (criteria v3, re-resolved) | skipped |
| Total messages | 3 | 1 |

### Use cases

1. **Few-shot priming before a loop — `injectOnce: true`.** A worked example belongs in the
   context once; repeating it every iteration only bloats the context window.
2. **Per-iteration reminder — default.** "Remember the acceptance criteria:
   `${var:CRITERIA}`" inside a critique loop is restated on every pass and picks up the
   latest variable values.
3. **Synthetic tool exchange — usually `injectOnce: true`.** A replayed assistant tool call
   plus its result seeds a lookup the model believes already happened; repeating the pair
   every iteration produces noisy, near-duplicate history.
4. **Conditional re-entry — `injectOnce: true`.** When two branches converge on the same
   Static node, only the branch that arrives first injects.
5. **Multi-turn chat flow.** An `injectOnce` node re-injects at the start of *each new user
   turn*, so per-turn scaffolding stays present without accumulating within a turn.

### Edge cases

- **Nested loops:** the marker is per run, not per loop level. An `injectOnce` node in an
  inner loop injects once for the whole run, not once per outer iteration.
- **Subflow re-entry:** markers never cross the parent/child boundary. An ephemeral
  subflow's injected messages do not persist into the parent conversation at all.
- **Toggling `injectOnce` mid-conversation:** markers are written whenever the node
  injects, even with the setting off, but they carry the run ID — so turning the toggle on
  can at most affect the current run, and the next user turn behaves as configured.
- **Variable drift:** re-injected entries re-resolve `${var:…}` and `${res:…}`, so the same
  node can contribute different text on each traversal.
- **Unlike the Start node:** the Start node dedupes its system message implicitly (by
  checking whether one is already present). A Static node never inspects the conversation;
  it relies solely on the `injectOnce` marker.
- **Runaway loops:** the engine has no iteration cap. A Static node inside an unbounded
  loop grows the conversation until the run is cancelled or the context limit is hit;
  `injectOnce` is the mitigation.

## Validation and limitations

| Situation | What happens | How to resolve it |
|---|---|---|
| No entries | Authoring validation reports `static-no-entries`; runtime passes through without adding messages. | Add an entry. |
| Missing tool name | Authoring validation reports `static-toolcall-missing-name`; runtime throws `Static node <nodeId>: a tool-call entry requires a tool name.` | Provide a non-empty `toolName`. |
| Invalid `argumentsJson` | Authoring validation and FlowSpec compilation report `static-toolcall-invalid-json` (error); runtime throws `Static node <nodeId>: tool-call entry for "<toolName>" has invalid JSON arguments.` | Use valid JSON, not JavaScript object syntax. |
| `argumentsJson` contains `${var:…}` / `${res:…}` | Authoring validation reports `static-toolcall-unverifiable-json` (warning) and skips the JSON check, because the authored text is not JSON until the placeholders resolve. Runtime still parses the resolved value. | Make sure the *resolved* string is valid JSON (quote placeholders that stand in for strings). |
| `injectOnce: true` on a node that is not on a loop | Authoring validation reports `static-injectonce-without-loop` (warning); the flow still runs, the setting simply has no effect. | Remove the setting, or connect the node so it can actually be re-entered. |
| `injectOnce` is not a boolean | FlowSpec compilation warns `static-invalid-injectonce` and ignores the value; the runtime treats anything other than `true` as "append". | Use `true` or `false`. |
| Malformed imported FlowSpec entry | The compiler drops it and warns `static-invalid-entry`. | Use only the schema shown above. |
| More than 200 entries | The compiler caps the list and warns `static-too-many-entries`. | Keep the list focused. |
| Unknown entry kind | Runtime throws `Static node <nodeId>: unknown entry kind.` | Use `message` or `toolCall`. |
| Real call has no server | The modal disables Save; FlowSpec compilation warns and safely downgrades it to a mock. | Select an MCP server. |
| Real call lacks connected/enabled MCP wiring | Runtime fails explicitly instead of silently using the wrong tool. | Re-save the Static node to reconcile its MCP attachments, or repair the graph/tool allowlist. |

The visual editor selects registered tools and builds parameters from the live tool schema. Imported flows are still validated defensively at runtime: mocks can carry any realistic tool name, while real calls must match a connected server and enabled tool.

Static nodes do not call a model or consume tokens by themselves, but their injected messages increase context for later model calls. Imported or untrusted FlowSpecs are sanitized, so malformed entries can be silently discarded in addition to compiler warnings.

## Troubleshooting

### The Save button is disabled

Check every tool-call entry's `argumentsJson`. It must be valid JSON, including quoted
property names and string values — unless it contains `${var:…}` / `${res:…}` placeholders,
which are not checked at authoring time.

### The flow fails with invalid JSON arguments

A substituted variable or resource may have made `argumentsJson` invalid. Inspect resolved values and ensure the completed string remains valid JSON.

### My entries appear twice

The flow revisited the node. Enable **Inject once** if entries should appear only once per
run. Note that even with **Inject once**, entries are injected again on each *new user turn*,
because every turn is a new logical run — see [Re-entry semantics](#re-entry-semantics).

### My variable or resource came out empty

Verify its name and that it is available for the run. Unknown `${var:...}` and `${res:...}` references resolve to an empty string.

### The model ignores my injected tool result

A mocked Static entry is an example, not a registered capability. Use a realistic tool name, arguments, and result, and explain in the surrounding prompt how the example should guide the model. If you need the operation to happen during the run, switch the entry to **Real call at runtime**.

## Related

- [Flow node reference](./README.md)
- [FlowSpec node-type inclusion policy](../../architecture/flowspec-node-inclusion-policy.md)

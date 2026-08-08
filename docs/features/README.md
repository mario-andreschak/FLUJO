# Flujo Features

This section provides detailed documentation for Flujo's features.

## Model Context Protocol (MCP)

- **[Overview](./mcp/overview.md)**: Introduction to the Model Context Protocol
- **[Local Servers](./mcp/local-servers.md)**: Running local MCP servers
- **[GitHub Servers](./mcp/github-servers.md)**: Using GitHub MCP servers
- **[Launch-and-connect servers](./mcp/launch-and-connect.md)**: Registry packages you run locally but talk to over HTTP — the `launch` field, loopback-only URL templating, and the ServerModal flow (Issue #392)

## Flows

- **[Flow Node Types](./flows/README.md)**: Reference guides for individual FlowBuilder nodes
- **[Static node](./flows/static-node.md)**: Inject authored messages and synthetic tool exchanges into a conversation
- **[Running Flows](./flows/running-flows.md)**: How to run and monitor flows
- **[FlowSpec ↔ FlowBuilder UI Coverage](./flowspec-ui-coverage.md)**: Which DSL capabilities the visual FlowBuilder can author vs. what still requires the generator / `POST /api/flow/compile` (Issue #186)
- **[Flow Templates](./flows/templates.md)**: Using and creating flow templates
- **[Resumable Subflow Sessions](./subflow-session-scope.md)**: Experimental `per-run` session scope that lets a Subflow node resume the same child conversation across repeat visits inside one parent run, instead of starting fresh every time (Issue #363/#391)

### Process Node vs Subflow Node: input/output modes

Both Process nodes and Subflow nodes have an **input mode** (what the step *receives*)
and an **output mode** (what *later* steps or the chat see of the step's work). The
value names look similar but mean different things per node type, which is a common
source of confusion (see Issue #152).

> **Important:** input modes only reshape the *wire view* a model/subflow sees. The
> persisted conversation transcript always stays lossless.

#### Terminology map

Informal words people use map to specific, differently-named settings:

| Word you might use   | Where it actually lives                | Internal value(s)                          |
|----------------------|----------------------------------------|--------------------------------------------|
| "last-message"       | **inputMode** (both node types)        | `latest-message`                           |
| "full-conversation"  | Process Node **outputMode** only       | `full-conversation` (vs `latest-message`)  |
| "isolated"           | **inputMode** (both node types)        | `isolated`                                 |
| (full history in)    | **inputMode** default (both)           | `full-history`                             |
| (subflow output)     | Subflow Node **outputMode**            | `steps` \| `final-only`                    |

`latest-message` means the most recent exchange: the last user message plus the last
settled assistant response after it. Process nodes also retain their current in-flight
tool tail so an agentic loop can continue safely.

#### Input mode comparison (what the step receives)

| inputMode        | Process Node                                                                 | Subflow Node                                                                                       |
|------------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `full-history`   | The whole assembled context, unchanged.                                      | The whole parent transcript, **sanitized** (see below).                                             |
| `latest-message` | System prompt(s) + the most recent exchange, **including the current turn's in-flight tool calls/results**. | The most recent exchange from the **sanitized** transcript.                                         |
| `isolated`       | System prompt(s) + `isolatedPrompt` as a single synthetic user message; prior conversation dropped. | The parent conversation is ignored; the child receives `promptTemplate`/`prompt` as its only user message. |

**Key difference — Subflow sanitizing:** in *every* history mode, a Subflow node first
runs the parent transcript through a sanitizer that **always drops** system messages,
tool-result messages, and **any assistant turn that made tool calls** (handoff or
otherwise). Only user messages and prose-only assistant messages survive. A Process node
does **not** do this — it keeps the current turn's tool exchange.

#### Output mode comparison (what comes out)

| Node type    | outputMode values                | Meaning                                                                                          |
|--------------|----------------------------------|--------------------------------------------------------------------------------------------------|
| Process Node | `full-conversation` (default) / `latest-message` | `latest-message` hides this step's tool calls/results from *later* steps (they see only its final response). Persistence stays lossless. |
| Subflow Node | `steps` (default) / `final-only` | Controls how the child's events fold into the parent **live view**. The child's final answer is **always** injected back into the parent transcript regardless of this setting. |

#### How messages pass between conversations: injection vs tool-call parameters

- **Injection (default):** a Process node injects the scoped message array into the
  model request; a Subflow node passes `{ messages }` (history modes) or `{ prompt }`
  (isolated) to the child, and the child's final answer is injected back into the
  parent transcript as an assistant message attributed to the node.
- **Tool-call parameters:** every Subflow handoff tool accepts a `task` for that child
  job. A routing model may call the same handoff repeatedly in one response; every call
  is queued. For an isolated Subflow, the configured prompt is the default when `task`
  is omitted and `task` overrides it when supplied. Process-to-Process handoffs keep
  their existing caller-prompt behavior.

#### Session scope (experimental)

By default, every visit to a Subflow node starts a brand-new, memory-less child
conversation. An experimental **session scope** setting lets a node opt into resuming
the same child conversation across repeat visits within one parent run — useful for
retry loops (e.g. produce → validate → re-produce) where re-stating the whole task on
every retry is wasteful. It is off by default and requires both an experimental-features
toggle and a `sessionScope` set on the node. See
[Resumable Subflow Sessions](./subflow-session-scope.md) for the full picture, including
current limitations.

#### Subflow execution queue

A Subflow node references exactly one child flow. One visit is always represented as a
job queue: an ordinary traversal creates one job, while repeated model handoff calls
create multiple jobs for that same child.

`Maximum simultaneous children` controls active workers, not accepted work. A value of
`1` runs jobs sequentially; a higher value runs up to that many in parallel. Additional
jobs wait in the queue, available worker slots are kept full, and all results are folded
in request order after the queue drains.

Afterward, graph topology controls the handoff. A terminal Subflow returns to the
Process node that actually invoked it. A Subflow with an explicit outgoing edge follows
that successor instead.

#### Worked example (Issue #152)

> "I set a Subflow node to `last-message` (`latest-message`) and it received the whole
> conversation, but the tool calls/results were stripped."

This is expected behavior, not a bug:

1. The tool calls/results were removed by the Subflow **sanitizer**, which runs in every
   history mode independently of the input mode.
2. With a single user turn, the most recent exchange can look like the entire sanitized
   conversation even though intermediate assistant turns are dropped.

## Models

- **[Connecting Models](./models/connecting.md)**: How to connect to AI models
- **[Model Settings](./models/settings.md)**: Configuring model settings

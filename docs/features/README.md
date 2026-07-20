# Flujo Features

This section provides detailed documentation for Flujo's features.

## Model Context Protocol (MCP)

- **[Overview](./mcp/overview.md)**: Introduction to the Model Context Protocol
- **[Local Servers](./mcp/local-servers.md)**: Running local MCP servers
- **[GitHub Servers](./mcp/github-servers.md)**: Using GitHub MCP servers

## Flows

- **[Creating Flows](./flows/creating-flows.md)**: How to create and design flows
- **[Running Flows](./flows/running-flows.md)**: How to run and monitor flows
- **[FlowSpec ↔ FlowBuilder UI Coverage](./flowspec-ui-coverage.md)**: Which DSL capabilities the visual FlowBuilder can author vs. what still requires the generator / `POST /api/flow/compile` (Issue #186)
- **[Flow Templates](./flows/templates.md)**: Using and creating flow templates

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

`latest-message` means **"everything from the most recent user message onward"** — it
is **NOT** "the last user message + the last assistant message".

#### Input mode comparison (what the step receives)

| inputMode        | Process Node                                                                 | Subflow Node                                                                                       |
|------------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `full-history`   | The whole assembled context, unchanged.                                      | The whole parent transcript, **sanitized** (see below).                                             |
| `latest-message` | System prompt(s) + everything from the most recent user message onward, **including the current turn's in-flight tool calls/results**. | The **sanitized** transcript sliced from the most recent user message onward.                       |
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
- **Tool-call parameters (opt-in):** an **isolated** Subflow node with
  `allowCallerPrompt: true` exposes an optional `prompt` argument on its *handoff tool*,
  so a routing model passes the child's instruction as a tool-call parameter (Issue #96).
  Likewise `allowCallerFanout: true` exposes a per-call `task` brief for spawning parallel
  copies (Issue #156). Every other handoff tool stays parameter-less.

#### Worked example (Issue #152)

> "I set a Subflow node to `last-message` (`latest-message`) and it received the whole
> conversation, but the tool calls/results were stripped."

This is expected behavior, not a bug:

1. The tool calls/results were removed by the Subflow **sanitizer**, which runs in every
   history mode independently of the input mode.
2. With a single user turn, "from the last user message onward" is effectively the entire
   (sanitized) conversation — so it looked like "the whole conversation" rather than
   "last user + last assistant".

## Models

- **[Connecting Models](./models/connecting.md)**: How to connect to AI models
- **[Model Settings](./models/settings.md)**: Configuring model settings

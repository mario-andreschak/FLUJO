# What can you do with FLUJO?

Connect your models and tools once, build an agent around a job, and see how it gets an answer. Start with [a coffee workshop checklist](../journeys/first-agent.md), then add more structure when you need it.

## Make useful helpers

**Choose the AI that fits the job.** Save cloud API connections, supported subscription logins or local Ollama models. Reuse them across agents. Ordered fallback policies can try a backup for selected limits or outages, before output or tool activity begins. Providers still determine availability, supported inputs, allowance and charges. [Model choices](../features/models/connecting.md) · [Fallback policies](../features/model-fallback-policies.md).

**Bring the right tools.** Connect a server from GitHub, the MCP Registry, a remote address or a local command. Test its tools before giving an agent access. Compatible servers can also supply reference material, reusable prompts and interactive interfaces. MCP is the shared connection standard behind these apps. [Connected Apps](../features/mcp/overview.md).

**Build at your own pace.** Start in the Easy editor with plain-language steps. Use the Expert graph when you need branches, loops, handoffs or reusable subflows. AI can help draft a flow; review its steps and tool access before running it. [Agent building](../features/flows/README.md).

## Keep the work visible

**Talk, inspect and adjust.** Watch steps and tool results in chat, inspect model usage, and use optional approvals or the visual debugger. Edit a message or branch a conversation to try another direction. Supported attachments bring files and audio into the work. [Running and debugging](../features/flows/running-flows.md).

**Use interactive results.** Servers that implement MCP Apps can return an interface inside chat. Enable Apps for that connection; ordinary text results remain the fallback. The Apps dashboard discovers interfaces published by enabled connections. [Apps support](../features/mcp/apps.md).

**Put agents together.** Use subflows to reuse a helper inside another agent, or bring multiple agents into a shared Meeting. Each model and tool still needs the right connection and access.

## Reuse what you set up

**Separate projects.** Workspaces keep each project's agents, models, conversations, connected apps and settings together. Back up and restore one workspace at a time. They organize one trusted operator's work; they are not separate user accounts. [Workspaces](../features/workspaces.md).

**Use connections from other software.** Compatible apps can call FLUJO agents through its OpenAI-compatible API or reuse configured MCP servers through its local proxy. [Integration guide](developers.md).

**Move supported work carefully.** Workspace snapshots support a portable-worker path with explicit credential transfer and runtime preparation. This is an advanced setup: external files, unsupported local commands and copied schedules have limits, and a worker is a snapshot of the workspace rather than ongoing synchronization. [Portable workers](../features/hot-clone-workspace.md).

## Return to work over time

**Run an agent when something happens.** Schedules, webhooks, file changes, connected-tool polling and website changes can trigger work. Review run history and errors. The FLUJO server must be running, and failed tools, provider limits or approvals can need your attention. [Everyday automation](using-flujo.md#schedule-work-after-a-manual-run-succeeds).

**Give a Persona continuing context — experimental.** A Persona has a name, instructions, memory and goals across conversations. You can review its activity and memories, adjust its tools and model, and pause or stop ongoing goals. Try [Maya's workshop example](../journeys/persona.md). Short demonstrations and controlled tests do not establish indefinite unattended reliability.

## Maturity at a glance

| Scope | Status and boundary |
| --- | --- |
| Model connections, chat, Easy/Expert agents, debugging | Available; model and tool compatibility still matters |
| MCP tools, resources, prompts and interactive Apps | Available; depends on the server and enabled permissions |
| Workspaces, backups and integration endpoints | Available within their documented local/transfer boundaries |
| Schedules and triggers | Available while the server runs; successful execution must be checked |
| Personas, Roles and persistent goals | Experimental; owner supervision and recovery can be needed |
| MCP Skills, beta protocol features and selected generators | Opt-in experiments; availability depends on configuration |

This page is a source-backed overview, not certification that every feature was tested on every platform. See [project status and acceptance evidence](../project-status.md), [privacy and costs](privacy.md), and [release notes](../../CHANGELOG.md).

[Compare alternatives](compare.md) · [Start here](README.md)

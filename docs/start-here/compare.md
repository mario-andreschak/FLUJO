# Which way of working fits you?

Choose the experience that fits your task, setup and accounts. These products overlap: model connections, MCP tools, schedules, memory and visual workflows are not exclusive to FLUJO.

**Consider FLUJO when you want to assemble reusable agents visually, choose their models and tools, and inspect their work in chat—all in a local installation you operate.** Its Easy editor is a small first step; its Expert graph gives you more control as the task grows. [FLUJO capabilities and limits](capabilities.md).

The fit descriptions below are editorial judgments based on official documentation checked **October 11, 2026**. They are not performance rankings or results from installing the other products. Features, plans and availability can change.

| Product | A useful starting point when you want… | Shared ground and things to check |
| --- | --- | --- |
| **Claude** | A ready-made workspace for research, writing, files and connected tasks using Claude. | Connectors/MCP, skills, memory, projects and scheduled work overlap. Claude Code is a separate coding agent with terminal, editor, desktop and browser access. Plan, rollout and surface affect availability. [Claude](https://claude.com/product/overview) · [Claude Code](https://code.claude.com/docs/en/overview) |
| **Goose** | An agent in a desktop app or terminal, with shareable recipes for repeatable work. | Local operation, multiple model providers, MCP extensions, scheduled recipes and interactive MCP Apps overlap. Check provider and extension setup for your workflow. [Overview](https://goose-docs.ai/) · [Recipes](https://goose-docs.ai/docs/guides/recipes/session-recipes/) |
| **Dify** | A visual platform for building and publishing AI applications with knowledge retrieval and operational logs. | Workflows organize jobs; Chatflows add conversation. Models, tools/MCP and scheduled workflows overlap. Its app publishing and deployment choices may suit a different audience from a personal local workspace. [Workflow and Chatflow](https://docs.dify.ai/en/cloud/use-dify/build/workflow-chatflow) · [Project](https://github.com/langgenius/dify) |
| **n8n** | Business-system automation on a visual canvas, with AI agents as part of a larger process. | Model connections, chat, schedules and MCP overlap. Choose managed cloud or self-hosting; check execution allowances and the operational work of your chosen deployment. [Project](https://github.com/n8n-io/n8n) · [Deployment choices](https://docs.n8n.io/choose-how-to-use-n8n) |
| **OpenClaw** | A self-hosted assistant reached through messaging apps such as Telegram, WhatsApp, Slack or Discord, with a browser control panel. | Multiple providers, MCP, memory, skills, schedules and multiple agents overlap. Its gateway centers ongoing assistant work in your communication channels. [Overview](https://docs.openclaw.ai/) · [Providers](https://docs.openclaw.ai/providers) |
| **Hermes Agent by Nous Research** | A personal agent that carries context and reusable procedures between sessions, through desktop, terminal and messaging access. | Multiple providers, MCP, persistent memory, agent-managed skills and scheduled jobs overlap. Its learning loop uses saved memory, session recall and skills; this is a design focus, not a guarantee of improvement. [Overview](https://hermes-agent.nousresearch.com/docs/) · [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |

## A few details worth checking

**Claude's surfaces are changing.** Its current overview describes Cowork becoming part of Claude through a gradual Pro/Max rollout. New scheduled work is documented as remote, while older local schedules can differ. Claude Code separately documents cloud routines, desktop schedules and session loops. [Claude scheduling](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) · [Claude Code scheduling](https://code.claude.com/docs/en/scheduled-tasks).

**Dify connects and publishes through MCP.** Its tool connections document HTTP transport, and apps can be published as MCP servers. Schedule triggers apply to Workflow apps. [MCP tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools) · [Publish through MCP](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp) · [Schedules](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger).

**n8n can sit on either side of a tool connection.** It provides an MCP Client Tool and an MCP Server Trigger, plus hosted or embedded chat. Each chat message starts a workflow execution, which matters for applicable execution allowances. [MCP client](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp) · [MCP server](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger) · [Chat](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger).

**Memory and recurring work are shared ideas.** OpenClaw documents centralized MCP connections, memory and automations; Hermes documents MCP, persistent memory and cron jobs. FLUJO's particular combination of guided setup, visual agents, inspectable runs and experimental Personas is the reason to try it—not a claim that these ideas are absent elsewhere. [OpenClaw MCP](https://docs.openclaw.ai/cli/mcp/registry) · [Memory](https://docs.openclaw.ai/concepts/memory) · [Automations](https://docs.openclaw.ai/cron) · [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) · [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) · [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

## Try one task before choosing

Use a small job you can judge: build a local page, try its form, then revise it with one new constraint. Check the output, the setup effort, what data leaves your computer, and the provider or hosting costs. Avoid choosing from a feature count alone.

For FLUJO, [create a reusable Website Builder](../journeys/website-builder.md). Personas remain experimental, schedules require a running server, and the default local profile has no owner login. [Privacy, costs and deployment boundaries](privacy.md).

[Start here](README.md)

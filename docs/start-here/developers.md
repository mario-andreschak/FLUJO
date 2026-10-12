# Build on FLUJO

Use the [contributor setup](../contributing/README.md) for a clean development installation, focused tests and a first change. Read the checkout's `AGENTS.md` and its installed Next.js documentation before changing application code.

## Reuse agents and connections

- **OpenAI-compatible API:** point a compatible client at `http://localhost:4200/v1` and use `flow-<your-flow-name>`. The default local profile accepts a compatibility API-key value; an explicitly enabled owner policy requires an issued, scoped bearer. [API guide](../api-reference/README.md).
- **MCP proxy:** a compatible client can reuse a configured server through `http://localhost:4200/mcp-proxy/<server-name>`, currently localhost-only. This is a separate path from connecting FLUJO to an MCP server.
- **Built-in reference:** open `/docs` in the running app for searchable HTTP documentation covering conversations, models, agents, connected apps, automations and administration.

FLUJO connects to Ollama as a model provider; it does not expose an Ollama-compatible server endpoint. For external clients, use the OpenAI-compatible endpoint above.

## Response and debugging options

Messages can include `~FLUJO=HTML`, `~FLUJO=MARKDOWN`, `~FLUJO=JSON` or `~FLUJO=TEXT` to request output formatting. Rendering depends on the consuming client. `~FLUJOEXPAND=1` and `~FLUJODEBUG=1` expose additional detail. Application logging settings live in `src/config/features.ts`.

## Project reference

- [Architecture](../architecture/README.md), [API reference](../api-reference/README.md) and [full documentation](../README.md).
- [Capability maturity](../project-status.md), [release history](../../CHANGELOG.md) and [security policy](../../SECURITY.md).
- [Contribution guide](../contributing/README.md), [starter backlog](../contributing/starter-backlog.md) and [documentation guide](../contributing/documentation-guidelines.md).
- [Maintainer release procedure](../npm-release.md), including `npm run release -- patch`.

The project is [MIT licensed](../../LICENSE), powered by [PocketFlow](https://the-pocket-world.github.io/Pocket-Flow-Framework/), and built with help from Cline and Claude Code. Questions and ideas belong in [GitHub issues](https://github.com/mario-andreschak/FLUJO/issues) or [Discord](https://discord.gg/KPyrjTSSat).

Project author: [mario-andreschak](https://github.com/mario-andreschak) · [LinkedIn](https://www.linkedin.com/in/mario-andreschak-674033299/).

For earlier creative work, the [original product film and studio](https://flujo.com.co/short/) and [“A sad song about MCP”](https://www.youtube.com/watch?v=boOS9XHQdZc) remain available. [Star history](https://www.star-history.com/?repos=mario-andreschak%2Fflujo&type=date&legend=top-left) and the [MseeP listing](https://mseep.ai/app/mario-andreschak-flujo) are external project links, not current release qualifications.

[Start here](README.md)

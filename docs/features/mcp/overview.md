# Connected Apps and MCP

An MCP server exposes tools, resources, prompts, or interactive Apps to FLUJO. A model can use only the capabilities that its agent and connection configuration make available. Connecting a server does not automatically make every tool appropriate for every agent.

1. Open **Connected Apps → Connect App**.
2. Choose a curated app, remote URL, GitHub repository, or local command.
3. Review where it runs and any credentials it needs.
4. Connect and inspect its discovered capabilities.
5. Test one harmless operation, then explicitly add the needed tools to your agent.

Local servers run as processes with the host user's permissions. Installing a repository can execute its installation/build scripts. A remote server receives requests at its configured URL. Tool approvals help review actions but do not turn arbitrary local processes into a sandbox.

Use [local server setup](local-servers.md), [GitHub server setup](github-servers.md), or [launch-and-connect](launch-and-connect.md) for the relevant transport. See [MCP Apps](apps.md) for the separate sandbox origin used by interactive interfaces.

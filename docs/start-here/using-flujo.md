# Everyday use

Start with a working model connection, then add the tools your task needs. The [Website Builder guide](../journeys/website-builder.md) puts these steps together.

## Connect an AI once

Open **AI Setup → Connect AI**. Choose guided setup or **Manual creation**, select a provider and supply its credentials or supported local login. Save, then use **Test model** on the card before adding it to an agent. Edit the model to replace a bad key; masked placeholders are not credentials to copy.

Saved connections can be reused across agents and conversations. Folders and favorites help organize them. **Create fallback policy** lets you choose a primary connection and ordered backups for selected limits or outages. It does not restart a run after output or tool activity has begun.

[Connection choices](../features/models/connecting.md) · [Model settings](../features/models/settings.md) · [Fallback policies](../features/model-fallback-policies.md)

## Add a connected tool

Open **Connected Apps → Connect App**. Use a curated choice, registry entry, GitHub repository, remote URL or local command. Review its source and requested access, finish setup, and test one harmless operation in the tool inspector.

Connecting a server and getting a successful tool result are separate checks. Attach the connection to your agent's AI step and review the tools it makes available. **MCP** is the connection standard that lets FLUJO and compatible AI apps use these tools.

[GitHub setup](../features/mcp/github-servers.md) · [Other connection methods](../features/mcp/overview.md) · [Interactive Apps](../features/mcp/apps.md)

## Build, talk and inspect

Open **Agents → Start simple** for the **Easy** editor. Add a goal step, choose an AI for it, and add the connected tools it needs. Name the agent, choose **Save**, then **Try it** in the toolbar to open a conversation. The initial setup may also offer **Try my agent**. Use **Talk → New** to return to a saved agent later.

The **Expert** graph gives you branching, loops, handoffs and reusable subflows. In chat, optional tool approvals and the debugger help you see what is happening. You can inspect steps and model usage, edit messages, branch conversations, and add supported file or audio inputs. Experimental Meetings bring multiple agents into a shared conversation.

[Build flows](../features/flows/README.md) · [Run and debug](../features/flows/running-flows.md)

## Schedule work after a manual run succeeds

Open **More → Automations**, then choose **Add trigger** on the **Triggers** page. Select a schedule, webhook, file change, connected-tool poll or website change. Pick the agent, configure the trigger and review its run history.

The FLUJO server must stay running. A browser tab does not have to stay open. Credentials, provider limits, failures or approval requests can still need your attention. Scheduled occurrence records help explain missed or failed runs; a schedule is not a guarantee that a task succeeded.

If **Triggers** cannot refresh, it keeps the last saved schedules and marks their status as out of date. Choose **Try again** to refresh. Pause changes wait for server confirmation, and failed deletions keep their dialog open for retry. A request that stalls for 30 seconds releases the controls; refresh to confirm the outcome before trying the change again.

[Scheduled occurrence accounting](../features/scheduled-occurrences.md) · [Experimental Personas](../journeys/persona.md)

## When something goes wrong

| What you see | Try this |
| --- | --- |
| Missing model binding | Choose the AI on the agent's AI step and save |
| Login, key or quota error | Edit and test the saved model; check provider access and allowance |
| Ollama unreachable | Start Ollama where FLUJO can reach it; a container's localhost is not your host computer |
| Connected tool fails | Test it directly; inspect its runtime, command, working directory and credentials |
| Agent answers without using the tool | Check that the correct tool is attached to its AI step; ask for a result from the actual source |
| Runtime command missing | Install its prerequisite and restart after PATH changes; [proxy help](proxy.md) |
| Workspace is initializing | Let migration finish; retain data and inspect the error before attempting repair |

For support, include your install method, OS, version/revision and a redacted error in a [GitHub issue](https://github.com/mario-andreschak/FLUJO/issues) or [Discord](https://discord.gg/KPyrjTSSat).

[Start here](README.md)

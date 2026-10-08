# Your first successful conversation

FLUJO runs on your computer and connects AI models to agents and optional tools. Start with one model and one plain conversation. Add apps, workflows, and scheduled work after that succeeds.

## Install and open FLUJO

You need Node.js **22 or newer** for npm/source installations. Cloud providers require credentials or a supported subscription login; local inference requires a running Ollama instance and a downloaded model.

| Installation | What you receive | Update method |
| --- | --- | --- |
| `npx flujo-ai@latest` | Latest published npm release | Run the updated package; retain the FLUJO data directory |
| Windows release installer | Bootstrapper from the selected GitHub release; check its release notes and channel | Use an installer for the intended release |
| Shell installer or source checkout | Development branch by default; may contain unreleased changes | Review changes and use a clean, fast-forward update |
| Docker Compose from a checkout | That checkout's source, compiled locally | `git pull --ff-only` then `docker compose up --build` |

For a published package, run:

```sh
npx flujo-ai@latest
```

Open [FLUJO on localhost](http://localhost:4200). Keep the terminal/server running. If the port is already in use, return to the existing instance instead of launching another copy. See the [main installation instructions](../../README.md#-getting-started) for source builds, Docker, corporate proxies, certificates, and uninstall behavior.

Use **Workspaces → Create workspace** for separate projects. Workspace separation is organization within a single-user installation, not multi-user authorization.

## Connect and test one AI

1. Open **AI Setup → Connect AI**. This opens guided setup; the adjacent dropdown also offers **Manual creation**.
2. Choose a provider or local Ollama. Supply the credentials, endpoint, or subscription login requested by that path. For Ollama, start the local server and download a model first.
3. Save the connection. A saved configuration is not proof that its credentials or quota work.
4. Use **Test model** (the flask icon) on the model card. Read the error if it fails. A cloud-model test may use quota or incur the provider's normal charge.
5. If a key is incorrect, choose **Edit model** (the pencil icon), replace the key, save, and test again. Check endpoint/model access and available allowance before proceeding.

The [model connection guide](../features/models/connecting.md) covers credentials and runtime setup. Never paste an API key into a chat message or public issue.

## Create an agent and get an answer

1. Open **Agents → Start simple**. The editor calls this the **Easy** view.
2. If asked whether AI should help build the agent, choose **No, I’ll build it myself** for this first manual setup.
3. In **Workflow goal**, enter `Answer the user's question clearly.` and select **Create goal step**.
4. Select the new **AI step**. In its settings panel, use **Choose an AI** under **AI for this step**, then select the model you tested.
5. Set **Agent name** to `My first assistant`. Choose **Try my agent** (or **Try it** in the toolbar). FLUJO saves the agent and opens a chat. To open it again later, use **Talk → New** and select the saved agent.
6. Send `Reply with one sentence explaining what you can help me with.`

Success means an actual assistant reply appears and the run completes. A saved agent, empty message, spinner, or error does not count. The longer tutorial is optional: open **Settings → Onboarding → Start Stage 1** when you are ready to add web tools. Paused tutorials can be resumed there; a saved active tutorial resumes after a reload.

## Recover from a failed first run

| Symptom | Next step |
| --- | --- |
| No model / missing model binding | Select the agent's AI step, use **Choose an AI** in its settings panel, select an existing model, and save |
| Authentication or permission error | Edit and test the connection; verify key/login and model access |
| Quota or rate limit error | Check provider allowance; retry when available |
| Ollama unreachable | Start Ollama on the server running FLUJO; a container's localhost is not the host computer |
| CLI/runtime missing | Follow the server OS installation guidance; restart the runtime if PATH changed |
| App/tool failure | Return to an AI-only agent, then test the individual tool in Connected Apps |
| Workspace initializing | Allow migration to finish; retain data and inspect errors rather than deleting it |

## Add a tool after chat works

Open **Connected Apps → Connect App**. Choose a known server, review its command or URL and credentials, connect, and test a harmless tool. Add only tools the agent needs. Enable tool approvals for actions you want to review. Local shell/filesystem tools run with the FLUJO process's permissions; they are not a security sandbox.

Data is stored locally, but cloud models and remote tools receive the content needed for your requests. Configure a private encryption password and telemetry choices in **Settings**. Keep Network access on **Localhost** unless you deliberately configure authentication and network controls.

Next: [run and debug an agent](../features/flows/running-flows.md), [connect apps](../features/mcp/overview.md), or [check feature maturity](../project-status.md).

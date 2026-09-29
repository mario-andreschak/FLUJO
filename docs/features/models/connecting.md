# Connect a model

Open **AI Setup → Connect AI**. Guided setup creates model configurations for a selected provider. For the full model form, open the dropdown beside **Connect AI → Manual creation**, or choose **I’m an expert** in the wizard. The form lets you specify the provider, technical model name, endpoint, and supported settings; the selected provider profile determines the adapter.

- **Cloud API:** use a credential issued by that provider with access to the selected model. An OpenAI-compatible endpoint is not necessarily identical to OpenAI; choose the appropriate adapter and base URL.
- **Subscription CLI:** install and authenticate the supported CLI on the machine running FLUJO. Credentials in a browser on another machine do not automatically authenticate the server.
- **Ollama:** start Ollama, download a model, and use its reachable address. With Docker, configure a container-reachable endpoint rather than the host's `localhost`.

Saving creates a configuration. Use **Test model** (the flask icon on the model card) to check actual access before using it in an agent. Tests can consume model quota. For failures, inspect authentication, model availability, endpoint, rate limits, and the runtime's PATH. Use **Edit model** (the pencil icon) to replace credentials; masked credential placeholders should not be copied to other connections.

Cloud requests send content and credentials to the selected provider. Store secrets in the credential fields, not agent prompts. Set a private encryption password in Settings if you need protection against access to stored data.

Continue with [your first conversation](../../getting-started/README.md) or [model settings](settings.md).

## Antigravity CLI

Choose **Antigravity CLI** in guided setup or manual creation. FLUJO installs a pinned native executable for its model runs. Enter a Gemini API key, or confirm an existing local Google account login. Model availability and quota depend on your account or API key.

For account login, launch FLUJO's bundled `flujo-agy` interactively on the machine running FLUJO and complete Google sign-in in your browser. From a FLUJO source checkout, run `npx --no-install flujo-agy`. The CLI uses the operating system's credential store or its official private credential cache. Over SSH, follow the authorization URL and paste the returned code into the remote terminal. Return to FLUJO, leave the API key empty, confirm the local login, save the connection, and use **Test model**. An existing [official standalone Antigravity CLI](https://antigravity.google/docs/cli/install/) login through `agy` is also supported.

Sign-in must be available to the operating-system user running the FLUJO server or worker. A login on another computer or under another user does not authenticate a remote server or container. A background model request cannot complete interactive sign-in. FLUJO links the official platform instructions; there is no Antigravity WinGet one-click installer. For unattended hosts, a saved Gemini API key avoids the account login flow.

The **Antigravity CLI Default** selection uses the CLI's default model. For a specific model, use a slug listed by `flujo-agy models` (or standalone `agy models`); an unknown headless model fails explicitly. Account and API-key model catalogs can differ. See [Google's headless CLI documentation](https://antigravity.google/docs/cli/headless/) for model selection.

FLUJO gives each invocation a private CLI home and working directory and exposes the tools configured for that FLUJO run through its approval checks. Account runs may copy only the official credential cache into that private home. Personal settings, plugins, hooks, project instructions, and CLI sessions are not imported. FLUJO conversation history supplies subsequent turns. Antigravity CLI connections currently accept text; choose the Gemini native API connection for supported media inputs. Temperature and output-token controls are not forwarded to the CLI.

Workspace snapshots preserve the saved model configuration while excluding the private Antigravity runtime, copied credentials, and CLI sessions. Authenticate separately on the destination host before using a restored account connection. Keep credentials and authorization codes out of Git and shared evidence.

# Connect a model

Open **AI Setup → Connect AI**. Guided setup creates model configurations for a selected provider. For the full model form, open the dropdown beside **Connect AI → Manual creation**, or choose **I’m an expert** in the wizard. The form lets you specify the provider, technical model name, endpoint, and supported settings; the selected provider profile determines the adapter.

- **Cloud API:** use a credential issued by that provider with access to the selected model. An OpenAI-compatible endpoint is not necessarily identical to OpenAI; choose the appropriate adapter and base URL.
- **Subscription CLI:** install and authenticate the supported CLI on the machine running FLUJO. Credentials in a browser on another machine do not automatically authenticate the server.
- **Ollama:** start Ollama, download a model, and use its reachable address. With Docker, configure a container-reachable endpoint rather than the host's `localhost`.

Saving creates a configuration. Use **Test model** (the flask icon on the model card) to check actual access before using it in an agent. Tests can consume model quota. For failures, inspect authentication, model availability, endpoint, rate limits, and the runtime's PATH. Use **Edit model** (the pencil icon) to replace credentials; masked credential placeholders should not be copied to other connections.

Cloud requests send content and credentials to the selected provider. Store secrets in the credential fields, not agent prompts. Set a private encryption password in Settings if you need protection against access to stored data.

Continue with [your first conversation](../../getting-started/README.md) or [model settings](settings.md).

## Gemini CLI

Choose **Gemini CLI** in guided setup or manual creation to use the official CLI. FLUJO bundles a pinned CLI for execution. Enter a Gemini API key, or authenticate with a supported Gemini Code Assist Standard or Enterprise account. Google retired consumer Gemini CLI access for individual, Google AI Pro and Google AI Ultra accounts on June 18, 2026. Personal Google browser sign-in can still complete while model requests fail with `unsupported_client`; see [Google's account deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).

For a supported licensed Google account, install the [official Gemini CLI](https://geminicli.com/docs/get-started/installation/) on the machine running FLUJO, run `gemini`, and choose **Sign in with Google**. Follow the [browser authentication instructions](https://geminicli.com/docs/get-started/authentication/), then return to FLUJO, leave the API key empty, save the connection and use **Test model**. If your license requires a Google Cloud project, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` in the FLUJO server's environment before launching it. FLUJO passes these project ids to Google-login runs while excluding competing API-key, ADC and Vertex authentication settings. Account permissions and quotas remain Google's responsibility.

Sign-in must be available to the operating-system user that runs FLUJO. Signing in on a different computer, or under a different user, does not connect a remote server or container. Initial Google sign-in requires the CLI's interactive authentication flow; a background model request cannot complete it for you. Gemini CLI does not have FLUJO's WinGet one-click installer.

FLUJO gives each invocation a private CLI home and working directory and exposes the tools configured for that FLUJO run. Personal Gemini settings, extensions, project instructions and CLI sessions are not imported. Machines with system-wide Gemini policy files cannot use this connection because the CLI cannot isolate those policies. FLUJO conversation history supplies subsequent turns. Gemini CLI connections currently accept text; choose the Gemini native API connection for supported media inputs. Temperature and output-token controls are not forwarded to the CLI.

Workspace snapshots preserve the saved model configuration but exclude the Gemini CLI runtime, Google login and CLI sessions. Authenticate separately on the destination host before using the restored connection. Keep Google OAuth cache files private and out of Git and shared evidence.

# Connect a model

Open **AI Setup → Connect AI**. Guided setup creates model configurations for a selected provider. For the full model form, open the dropdown beside **Connect AI → Manual creation**, or choose **I’m an expert** in the wizard. The form lets you specify the provider, technical model name, endpoint, and supported settings; the selected provider profile determines the adapter.

- **Cloud API:** use a credential issued by that provider with access to the selected model. An OpenAI-compatible endpoint is not necessarily identical to OpenAI; choose the appropriate adapter and base URL.
- **Subscription CLI:** install and authenticate the supported CLI on the machine running FLUJO. Credentials in a browser on another machine do not automatically authenticate the server.
- **Ollama:** start Ollama, download a model, and use its reachable address. With Docker, configure a container-reachable endpoint rather than the host's `localhost`.

Saving creates a configuration. Use **Test model** (the flask icon on the model card) to check actual access before using it in an agent. Tests can consume model quota. For failures, inspect authentication, model availability, endpoint, rate limits, and the runtime's PATH. Use **Edit model** (the pencil icon) to replace credentials; masked credential placeholders should not be copied to other connections.

OpenRouter offers three provider profiles: **OpenRouter** uses Responses through the OpenAI SDK, **OpenRouter Messages** uses the Anthropic Messages SDK for compatible Claude models, and **OpenRouter Agent SDK** uses `@openrouter/agent` and `callModel`. Responses and Agent SDK use `https://openrouter.ai/api/v1`; Messages uses `https://openrouter.ai/api` because the Anthropic SDK appends `/v1/messages`. All profiles use your OpenRouter API key. Select the technical model ID from OpenRouter's catalogue and set **Reasoning effort** where supported by that model.

The Agent SDK integration supports streaming text and tool arguments, cancellation, usage reporting, and request inspection. It uses the SDK's manual-tool mode so FLUJO executes MCP tools and handoffs with its existing approval and execution controls. Each SDK call makes one provider turn; FLUJO supplies the updated history for the next turn.

Cloud requests send content and credentials to the selected provider. Store secrets in the credential fields, not agent prompts. Set a private encryption password in Settings if you need protection against access to stored data.

Continue with [your first conversation](../../getting-started/README.md) or [model settings](settings.md).

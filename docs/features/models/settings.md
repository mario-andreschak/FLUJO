# Model settings

Open **AI Setup** and choose **Edit model** (the pencil icon) on a model card. Its display name is the label shown in FLUJO; its technical name must match the provider's model or deployment identifier. An agent's AI step binds to a saved configuration, not merely its display name.

Choose the provider profile that implements your endpoint; it determines the adapter. Verify the base URL, Azure deployment/API version where applicable, credentials, and advertised text/image/tool capabilities. Provider support varies; selecting a capability does not add it to the remote model.

Generation controls such as temperature and output limits must be supported by the selected adapter/model. Start from the provider defaults and change one setting at a time. A larger context or output limit can increase latency and cost.

For **Antigravity CLI**, the CLI manages its generation settings; FLUJO does not forward temperature or output-token controls. A local Google account login can use an empty API key, or you can supply a Gemini API key. The technical name must be an available Antigravity model slug. The separate Gemini native API profile requires a key. See [Antigravity CLI setup](connecting.md#antigravity-cli) for authentication and host requirements.

After changing an endpoint, credential, or model name, use **Test model** on the saved model card. Then open dependent agents and confirm their model binding still exists. Replacing or deleting a model can leave an existing step unable to run.

**Gemini (Native)** uses Google's Interactions API with the same API key and
model names. Model discovery still reads Google's live model-list API. FLUJO
keeps the conversation history (`store: false`), executes tools through its
normal controls, and preserves signed model steps for later tool turns. Text,
media, streaming and cancellation use the native adapter. No CLI is required.
See Google's [Interactions migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-interactions).

Argon offers **low**, **medium** (Google's default) and **high** thinking; its
temperature control is hidden because Google ignores it. Numeric thinking
budgets from older Gemini configurations are not supported by Interactions.
Open and save an affected model to clear the old budget, optionally selecting
a thinking level. Existing connections without that old setting need no change.

See [connecting a model](connecting.md) and [running agents](../flows/running-flows.md).

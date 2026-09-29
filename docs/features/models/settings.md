# Model settings

Open **AI Setup** and choose **Edit model** (the pencil icon) on a model card. Its display name is the label shown in FLUJO; its technical name must match the provider's model or deployment identifier. An agent's AI step binds to a saved configuration, not merely its display name.

Choose the provider profile that implements your endpoint; it determines the adapter. Verify the base URL, Azure deployment/API version where applicable, credentials, and advertised text/image/tool capabilities. Provider support varies; selecting a capability does not add it to the remote model.

Generation controls such as temperature and output limits must be supported by the selected adapter/model. Start from the provider defaults and change one setting at a time. A larger context or output limit can increase latency and cost.

For **Gemini CLI**, the CLI manages its generation settings; FLUJO does not forward temperature or output-token controls. Supported Code Assist Standard/Enterprise Google login can use an empty API key; personal consumer subscriptions no longer provide Gemini CLI access. The separate Gemini native API profile requires a key. See [Gemini CLI setup](connecting.md#gemini-cli) for authentication and host requirements.

After changing an endpoint, credential, or model name, use **Test model** on the saved model card. Then open dependent agents and confirm their model binding still exists. Replacing or deleting a model can leave an existing step unable to run.

See [connecting a model](connecting.md) and [running agents](../flows/running-flows.md).

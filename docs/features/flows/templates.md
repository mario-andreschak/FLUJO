# Reuse a flow or generate a draft

Use an existing agent as a starting point, import a shared configuration through FLUJO's supported import/package UI, or choose **Agents → Create with AI** and describe the desired agent. A generated graph is a draft to inspect, not a guarantee that its selected models, tools, or credentials exist in your workspace.

Before the first run:

1. Read each step's instructions and inspect connected tools.
2. Bind AI steps to your tested model configurations.
3. Connect the required apps and supply credentials in their designated fields.
4. Review branches, loops, triggers, and actions that affect files or external services.
5. Validate, save, and test with a small harmless input.

Remove credentials, private examples, and environment-specific paths before sharing your own configuration. Imported app/server installation scripts can execute code; use sources you trust.

See [running an agent](running-flows.md) and [FlowSpec coverage](../flowspec-ui-coverage.md) for the distinction between the visual editor and advanced generated definitions.

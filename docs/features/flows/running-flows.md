# Run and debug an agent

An agent is a saved flow. **Start simple** opens the editor's **Easy** view, which presents steps in plain language; **Expert** view exposes the graph and advanced routing. Every AI step must bind to an existing model, and every tool step must refer to an available connection/tool.

1. Open **Agents** and edit the agent. In **Easy** view, select an AI step and use **Choose an AI** in its settings panel to inspect or replace the model. Check its connected apps as well.
2. For graph validation, turn on **Expert** view and choose **Check flow**; resolve blocking errors. In Easy view, **Check setup with AI** is an optional separate check available when AI help is on, and may use provider quota.
3. Save, then return to **Easy** view and choose **Try it** or **Try my agent**. These actions also save pending changes before opening chat. Alternatively, open **Talk → New** and select the saved agent.
4. Send a small request and observe the assistant answer and execution status.

Enable tool approvals to review actions before they run. The debugger can pause execution and show the current node and conversation state. If a run fails, inspect the reported node, input, provider error, and tool output. Fix the underlying connection or graph before retrying; repeated retries may consume provider quota or repeat external actions.

For advanced composition, review [node types](README.md), [static nodes](static-node.md), [subflow sessions](../subflow-session-scope.md), and [tool approvals](../tool-approval.md).

Schedules and triggers run while the FLUJO server is running. Start with a successful interactive run before adding unattended triggers. Persistent Personas are a separate experimental capability; see [project status](../../project-status.md).

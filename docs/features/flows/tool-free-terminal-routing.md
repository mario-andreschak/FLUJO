# Tool-free terminal routing

Use `terminalRouting: "tool-free"` on an Advanced FlowSpec Process node when
the engine should send its answer directly to a single Finish node. This is
useful with execution adapters that reject synthetic handoff tools.

```json
{
  "name": "Direct answer",
  "nodes": [
    { "key": "start", "type": "start" },
    { "key": "answer", "type": "process", "model": "your-model", "terminalRouting": "tool-free" },
    { "key": "finish", "type": "finish" }
  ],
  "edges": [
    { "from": "start", "to": "answer" },
    { "from": "answer", "to": "finish" }
  ]
}
```

Replace `your-model` with a configured model. The Process must have exactly one
unconditioned outgoing control edge to Finish. Multiple successors, conditions,
MCP connections, resource tools, Persona tools, questions and todo tools are
refused. The setting survives compilation and exported FlowSpec snapshots.

The model receives no FLUJO graph tools. Invented handoff or tool calls are
rejected, and the engine advances a successful answer to Finish. Omitting the
setting preserves the existing model-selected handoff behavior.

This setting controls FLUJO graph tools and terminal routing. Native CLI
capabilities remain governed by the selected adapter and its execution profile;
it does not grant execution authority or replace a CLI isolation policy.

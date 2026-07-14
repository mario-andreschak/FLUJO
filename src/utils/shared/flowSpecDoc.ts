/**
 * The canonical FlowSpec documentation (issue #14 follow-up: FlowSpec as the public
 * authoring contract).
 *
 * FlowSpec is the semantic flow-authoring format: what the flow-generation LLM emits,
 * what POST /api/flow/compile accepts, and what the built-in MCP server's authoring
 * tools (create_flow / validate_flow_spec) take. Raw ReactFlow JSON (POST /api/flow)
 * stays the internal/advanced surface; FlowSpec is the stable contract external
 * agents author against, and `compileFlowSpec` absorbs the canvas format underneath.
 *
 * This ONE text is shared by the generator's system prompt, the MCP authoring tool
 * descriptions, and the in-app /docs API reference, so the three can never drift.
 * Keep it model-friendly: compact, imperative, no prose padding.
 */

export const FLOWSPEC_DOC = `A FlowSpec is a JSON object describing a FLUJO flow semantically — node keys and edges, no coordinates, no ids, no layout:
{
  "name": "short_flow_name",            // letters/digits/_/- only
  "description": "what the flow does",
  "nodes": [ ... ],
  "edges": [ ... ]
}

NODE TYPES:
- { "key": "unique_key", "type": "start", "label": "...", "prompt": "system-level instructions for the whole flow" }
- { "key": "...", "type": "process", "label": "...", "description": "what this step does",
    "model": "<model id or name from the catalog>",
    "prompt": "instructions for this step",
    "servers": [ { "name": "<server name>", "tools": ["tool_a"] } ],   // optional; omit "tools" to enable all
    "inputMode": "full-history" | "latest-message" | "isolated",       // optional, default full-history
    "isolatedPrompt": "...",                                            // only with inputMode "isolated"
    "outputMode": "full-conversation" | "latest-message" }              // optional, default full-conversation; latest-message hides this step's tool calls/results from later steps (they see only its final response)
- { "key": "...", "type": "subflow", "label": "...",
    "flow": "<existing flow name or id>",          // reference an EXISTING flow, OR:
    "subflowSpec": { ...a nested FlowSpec... },     // define a brand-new child flow INLINE (compiled into its own flow and wired automatically)
    "inputMode": "full-history" | "latest-message" | "isolated",
    "allowCallerPrompt": true | false,             // optional, only with inputMode "isolated"; when true a routing step may pass a "prompt" via its handoff tool that overrides the subflow's "prompt" (default)
    "outputMode": "steps" | "final-only" }
- { "key": "...", "type": "finish", "label": "..." }

EDGES: { "from": "<node key>", "to": "<node key>", "bidirectional": true|false }

RULES:
1. Exactly ONE start node; at least one finish node reachable from it.
2. Every process node MUST reference a configured model (by id, display name, or name).
3. A process step uses MCP tools ONLY via its "servers" list — never emit nodes of type "mcp".
4. Do not embed \${tool:...} or \${resource:...} references in prompts — tools are wired through "servers".
5. Branching: give a process node multiple outgoing edges; its model decides where to hand off at runtime. "bidirectional": true lets the target hand back to the source (agent <-> agent).
6. A subflow node may have only ONE outgoing edge. Give it EITHER a "flow" (naming an existing flow) OR a "subflowSpec" (an inline nested FlowSpec that becomes its own child flow) — not both. A "subflowSpec" may itself contain subflow nodes with their own "subflowSpec" (bounded nesting), so you can author whole multi-level flows in one object.
7. Keep flows minimal — only the steps the task needs. Write clear, specific prompts and labels; fill "description" on process nodes.`;

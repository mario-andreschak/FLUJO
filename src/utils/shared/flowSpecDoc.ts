/**
 * The canonical FlowSpec documentation (issue #14 follow-up: FlowSpec as the public
 * authoring contract).
 *
 * FlowSpec is the semantic flow-authoring format: what the flow-generation LLM emits,
 * what POST /api/flow/compile accepts, and what the control-plane MCP package's authoring
 * tools (create_flow / validate_flow_spec) take. Raw ReactFlow JSON (POST /api/flow)
 * stays the internal/advanced surface; FlowSpec is the stable contract external
 * agents author against, and `compileFlowSpec` absorbs the canvas format underneath.
 *
 * This ONE text is shared by the generator's system prompt, the MCP authoring tool
 * descriptions, and the in-app /docs API reference, so the three can never drift.
 * Keep it model-friendly: compact, imperative, no prose padding.
 *
 * For the authoritative audit of which of these DSL capabilities the FlowBuilder UI
 * can currently author (and which still require the generator / POST /api/flow/compile),
 * see docs/features/flowspec-ui-coverage.md (issue #186).
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
    "inputMode": "full-history" | "latest-message" | "isolated",       // optional, default full-history. Reshapes ONLY the wire view the model sees (persisted history stays lossless): full-history = the whole assembled context; latest-message = leading system prompt(s) + the most recent EXCHANGE (the last user message + the last assistant response, intermediate turns since the last user message dropped) + this turn's in-flight tool calls/results; isolated = system prompt(s) + isolatedPrompt as a synthetic user message, prior conversation dropped. NOTE: for Claude-subscription models the whole wire history (incl. prior tool calls/results under full-history) is flattened into one text prompt rather than sent as native tool turns
    "isolatedPrompt": "...",                                            // only with inputMode "isolated"
    "allowCallerPrompt": true | false,                                 // optional, only with inputMode "isolated"; default true — a step that hands off to this isolated step may pass a "prompt" via its handoff tool that overrides "isolatedPrompt". Set false to forbid it
    "outputMode": "full-conversation" | "latest-message",              // optional, default full-conversation; latest-message hides this step's tool calls/results from later steps (they see only its final response)
    "maxTurns": 20,                                                     // optional; per-step cap on agentic tool-loop turns (retry-until-done in ONE node). Unset = model/system default (255)
    "allowedTools": ["tool_a"],                                        // optional; step-level tool allowlist (independent of servers[].tools)
    "captureVariable": "NAME",                                         // optional; save this step's output into a run variable other steps inject with \${var:NAME}
    "captureKv": "NAME",                                               // optional; ALSO save this step's output to a PERSISTENT cross-run key other steps inject with \${kv:NAME} (see rule 9d)
    "excludeModelPrompt": true|false,                                   // optional; drop the model's base prompt
    "excludeStartNodePrompt": true|false,                              // optional; drop the start node's prompt for this step
    "excludeSystemPrompt": true|false }                                // optional; drop the workflow/handoff guidance block
- { "key": "...", "type": "subflow", "label": "...",
    "flow": "<existing flow name or id>",          // reference exactly ONE existing child flow, OR:
    "subflowSpec": { ...a nested FlowSpec... },     // define exactly ONE new child flow inline (compiled and wired automatically)
    "concurrencyLimit": 4,                          // optional; maximum ACTIVE child jobs, default 4. 1 = sequential; queued jobs are never discarded
    "inputMode": "full-history" | "latest-message" | "isolated",   // optional, default full-history. DIFFERS from a process node: history modes ALWAYS sanitize the parent transcript first — system messages, tool-result messages, and ANY assistant turn that made tool calls are dropped (only user + prose-only assistant messages survive). full-history = the full sanitized transcript; latest-message = the most recent EXCHANGE of the sanitized transcript (the last user message + the last assistant response after it, intermediate turns dropped); isolated = ignore the parent conversation and send "prompt" as the child's single user message
    "prompt": "default child instruction",         // optional, only with inputMode "isolated"; a handoff's task overrides it for that queued job
    "captureVariable": "NAME",                     // optional; save the subflow's output into a run variable other steps inject with \${var:NAME}
    "captureResource": "NAME",                     // optional; ALSO save the subflow's output as a tracked run resource (\${res:NAME}, rule 9b)
    "captureKv": "NAME",                           // optional; ALSO save the subflow's output to a PERSISTENT cross-run key (\${kv:NAME}, rule 9d)
    "outputMode": "steps" | "final-only" }
- { "key": "...", "type": "finish" }                              // a finish node is ALWAYS named "Finish Node"; omit "label" (any label you supply is ignored)
- { "key": "...", "type": "signal", "label": "...",                // fire-and-forget event (rule 11): emits {topic, payload} then passes through unchanged
    "topic": "<event topic other flows' triggers listen for>",     // REQUIRED — a signal with no topic emits nothing
    "payloadTemplate": "event body, may use \${var:NAME}" }         // optional; defaults to the node prompt
- { "key": "...", "type": "resource", "label": "...",              // OPTIONAL/advanced (rule 9c): a data artifact shown in the graph
    "server": "<server name>", "uri": "<resource uri>",            // EITHER a static MCP resource…
    "runName": "NAME" }                                            // …OR a run artifact steps produce/consume
- { "key": "...", "type": "static", "label": "...",                // OPTIONAL/advanced (rule 13): injects pre-authored
    "entries": [                                                    //   messages / few-shot examples, then passes through unchanged
      { "kind": "message", "role": "system|user|assistant", "content": "..." },
      { "kind": "toolCall", "toolName": "...", "argumentsJson": "{...}", "result": "..." }
    ],
    "injectOnce": true }                                            // optional; default appends every traversal; true injects once per run

EDGES: { "from": "<node key>", "to": "<node key>", "bidirectional": true|false,
         "condition": { "kind": "contains"|"regex"|"equals", "value": "...",
                        "target": "last-assistant"|"last-message",  // optional, default last-assistant
                        "ignoreCase": true|false, "negate": true|false } }   // condition optional; process-node edges only

RULES:
1. Exactly ONE start node; at least one finish node reachable from it.
2. Every process node MUST reference a configured model (by id, display name, or name).
3. A process step uses MCP tools ONLY via its "servers" list — never emit nodes of type "mcp".
4. Do not embed \${tool:...} or \${resource:...} references in prompts — tools are wired through "servers".
5. Branching: give a process node multiple outgoing edges; its model decides where to hand off at runtime. "bidirectional": true lets the target hand back to the source (agent <-> agent).
5b. Deterministic routing: give a process node's outgoing edges a "condition" to route WITHOUT the model — the engine takes the first outgoing edge whose predicate matches the last message (default the step's own last assistant message), and a bare (condition-less) edge is the fallback. Use this for reliable data-driven branches (e.g. output contains "FAIL" -> fix step, else -> publish) instead of relying on a small model to emit a handoff. Only process-node edges may carry a condition. Without any condition on a node, that node keeps model-decided handoff (rule 5). If the model still calls a handoff tool, that wins over the condition.
6. A subflow node references exactly ONE child: EITHER "flow" (an existing flow) OR "subflowSpec" (one inline nested FlowSpec), never both. It may have at most ONE outgoing edge. A nested FlowSpec may itself contain subflow nodes (bounded nesting).
7. Every visit to a subflow is a queue of child jobs, even when the queue contains only one job. A routing model may call the SAME subflow handoff tool any number of times in one response; every call adds one job and may carry a "task" string. A call without "task" uses the subflow's configured input. Results are folded in request order after the complete queue drains.
8. "concurrencyLimit" controls only the maximum number of child jobs running simultaneously. Set it to 1 for sequential execution or above 1 for parallel execution. It NEVER limits the total jobs accepted: extra jobs wait in the queue, and the runtime keeps available worker slots filled until the queue is empty.
8b. Topology determines the handoff after the queue finishes. A terminal subflow invoked from a Process node returns its folded result to that actual invoking Process. If the subflow has an explicit outgoing edge, that successor wins and execution continues there instead of returning to the invoker.
9. Named variables (scratchpad): a step can save its output with "captureVariable": "NAME" (process or subflow) and any LATER step injects it with \${var:NAME} inside its "prompt" / "isolatedPrompt" / subflow prompt. This survives "latest-message"/"isolated" scoping, unlike conversation history — use it to carry a todo list, a file path, a diff, or a captured result across steps that don't share history. \${var:NAME} is run-scoped and plaintext; it is DISTINCT from \${global:VAR} (configured secrets/config, resolved only for tool args). Capture a subflow's output on the PARENT subflow node — a variable set inside a child flow is not visible to the parent.
9b. Run resources (tracked data): a SUBFLOW may use "captureResource": "NAME" because its folded child output is a concrete result. A PROCESS must use an explicit Resource node: process→resource arms write_resource so the process writes the full artifact; resource→process injects it into a reader with \${res:NAME}. Do not put passive captureResource on a process node. Large or binary MCP tool results are auto-captured as run resources without any spec field.
9c. Resource nodes are OPTIONAL/advanced — most flows should use conversation history. Resource edges are data wiring, not flow control: they never carry conditions and do not count as a step's successor.
9d. Persistent state (cross-run): "captureKv": "NAME" (process or subflow) saves the step's output to a PERSISTENT key-value store that SURVIVES ACROSS RUNS, injected by any step with \${kv:NAME}. Unlike \${var:} / \${res:} (discarded when the run ends), \${kv:} is what a long-lived SCHEDULED flow uses to carry a loop counter, a pagination cursor, a last-seen id, or a flag to its NEXT run. By default a key lives on the flow's FOLDER board (flows in the same folder share it); prefix the name to change scope: "flow/NAME" (this flow only) or "global/NAME" (whole instance). Plaintext, never secrets (distinct from \${global:VAR}). A model can also read/update a key mid-run via the built-in "flujo" server's kv_get / kv_set tools.
10. Keep flows minimal — only the steps the task needs. Write clear, specific prompts and labels; fill "description" on process nodes.
11. Signals (fire-and-forget events): a "signal" node is a deterministic pass-through that, when the path reaches it, emits an event {topic, payload} onto the flow-run event bus and then continues to its successor unchanged (it never calls a model or touches the conversation). Use it when the flow should notify or kick off ANOTHER flow mid-run — a flow-event trigger configured elsewhere listens for the same "topic" (e.g. "when the review finds blockers, emit a review-blocked signal"). Always give it a "topic" (a signal with no topic emits nothing); "payloadTemplate" is the optional event body and may inject \${var:NAME}. Make emission conditional by putting a conditioned edge (rule 5b) INTO the signal node.
12. Input vs output modes are two DISTINCT axes whose value names differ per node type (issue #152 clarification). inputMode ("full-history" | "latest-message" | "isolated") controls what a step RECEIVES and exists on BOTH process and subflow nodes, but they behave differently: a process node keeps the current turn's in-flight tool calls/results, while a subflow node ALWAYS strips system/tool-result/tool-call turns from the parent transcript in every history mode (see the inputMode notes above). "latest-message" means the last user message plus the last settled assistant response after it, with the current in-flight tool tail retained for Process nodes. outputMode controls what LATER steps see of a step's work and is a SEPARATE enum per node type: a process node uses "full-conversation" | "latest-message" (latest-message hides this step's tool exchange from later steps), a subflow node uses "steps" | "final-only" (live-view folding only). Common word traps: "last-message" = inputMode latest-message; "full-conversation" is a process outputMode value, NOT an input mode. A subflow's final answer is always injected back into the parent transcript regardless of outputMode.
13. Static replay (few-shot / tool-exchange injection): a "static" node is a deterministic, non-LLM pass-through that INJECTS its authored "entries" onto the conversation, in order, when reached, then continues to its successor unchanged. Prefer a process node's "prompt" for ordinary instructions; use "static" only to replay a few-shot example or a known tool call + result exchange the model should see as if it already happened. A "message" entry adds one system/user/assistant turn; a "toolCall" entry adds a synthetic assistant tool call plus its matching tool result (two turns) — "argumentsJson" must be valid JSON. "injectOnce": true injects only on the first traversal per run (useful inside a loop). A static node with no entries injects nothing.

COMPATIBILITY: the compiler/runtime can still read legacy fan-out, map-over-list, authored-brief, join, and fail-fast fields from saved FlowSpecs. Do not emit those fields in new FlowSpecs; author one child flow and let repeated handoff calls form the job queue.`;

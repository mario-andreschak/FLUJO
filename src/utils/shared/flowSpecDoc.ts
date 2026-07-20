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
    "inputMode": "full-history" | "latest-message" | "isolated",       // optional, default full-history. Reshapes ONLY the wire view the model sees (persisted history stays lossless): full-history = the whole assembled context; latest-message = leading system prompt(s) + everything FROM the most recent user message ONWARD (NOT "last user + last assistant"), INCLUDING this turn's in-flight tool calls/results; isolated = system prompt(s) + isolatedPrompt as a synthetic user message, prior conversation dropped. NOTE: for Claude-subscription models the whole wire history (incl. prior tool calls/results under full-history) is flattened into one text prompt rather than sent as native tool turns
    "isolatedPrompt": "...",                                            // only with inputMode "isolated"
    "outputMode": "full-conversation" | "latest-message",              // optional, default full-conversation; latest-message hides this step's tool calls/results from later steps (they see only its final response)
    "maxTurns": 20,                                                     // optional; per-step cap on agentic tool-loop turns (retry-until-done in ONE node). Unset = model/system default (50)
    "allowedTools": ["tool_a"],                                        // optional; step-level tool allowlist (independent of servers[].tools)
    "captureVariable": "NAME",                                         // optional; save this step's output into a run variable other steps inject with \${var:NAME}
    "captureResource": "NAME",                                         // optional; ALSO save this step's output as a tracked run resource other steps inject with \${res:NAME} (see rule 9b)
    "captureKv": "NAME",                                               // optional; ALSO save this step's output to a PERSISTENT cross-run key other steps inject with \${kv:NAME} (see rule 9d)
    "excludeModelPrompt": true|false,                                   // optional; drop the model's base prompt
    "excludeStartNodePrompt": true|false,                              // optional; drop the start node's prompt for this step
    "excludeSystemPrompt": true|false }                                // optional; drop the workflow/handoff guidance block
- { "key": "...", "type": "subflow", "label": "...",
    "flow": "<existing flow name or id>",          // reference an EXISTING flow, OR:
    "subflowSpec": { ...a nested FlowSpec... },     // define a brand-new child flow INLINE (compiled into its own flow and wired automatically), OR fan out concurrently:
    "parallelFlows": ["flow_a", "flow_b"],          // run several EXISTING child flows CONCURRENTLY, same input to each, outputs joined; OR:
    "parallelSubflowSpecs": [ { ...FlowSpec... } ], // run several INLINE child flows concurrently; OR:
    "parallelFlowsVariable": "NAME",                // DYNAMIC fan-out (rule 7b): pick the target flows AT RUNTIME from run variable \${var:NAME} (a JSON array of flow ids/names, or newline list); mutually exclusive with mapOverList
    "mapOverList": true | false,                    // optional; run the SINGLE child ("flow"/"subflowSpec") ONCE PER ITEM parsed from the input; mutually exclusive with parallelFlows/parallelSubflowSpecs
    "itemSplit": "json-array" | "lines",            // optional (mapOverList only), how to split the input into items, default json-array
    "sequential": true | false,                     // optional (mapOverList only), run items one at a time in order instead of concurrently, default false
    "spawnBriefs": ["brief 1", "brief 2"],          // optional (rule 7d); run the SINGLE child once PER BRIEF, in parallel — the author-defined spawn set; mutually exclusive with parallelFlows/parallelSubflowSpecs/mapOverList
    "concurrencyLimit": 4,                          // optional (parallel / mapOverList / spawn), default 4
    "joinSeparator": "\\n\\n---\\n\\n",              // optional (parallel / mapOverList / spawn), string between joined lane outputs, default "\\n\\n"
    "errorStrategy": "collect-all" | "fail-fast",   // optional (parallel / mapOverList / spawn), default collect-all
    "inputMode": "full-history" | "latest-message" | "isolated",   // optional, default full-history. DIFFERS from a process node: history modes ALWAYS sanitize the parent transcript first — system messages, tool-result messages, and ANY assistant turn that made tool calls are dropped (only user + prose-only assistant messages survive). full-history = the full sanitized transcript; latest-message = the sanitized transcript FROM the most recent user message ONWARD (NOT "last user + last assistant"); isolated = ignore the parent conversation and send "prompt" as the child's single user message
    "allowCallerPrompt": true | false,             // optional, only with inputMode "isolated"; when true a routing step may pass a "prompt" via its handoff tool that overrides the subflow's "prompt" (default)
    "allowCallerFanout": true | false,             // optional (subflow); makes this a SPAWNABLE sub-agent: the routing step may call its handoff tool SEVERAL TIMES in one turn, each call with a "task" brief spawning one parallel instance of the child flow (rule 7c)
    "captureVariable": "NAME",                     // optional; save the subflow's output into a run variable other steps inject with \${var:NAME}
    "captureResource": "NAME",                     // optional; ALSO save the subflow's output as a tracked run resource (\${res:NAME}, rule 9b)
    "captureKv": "NAME",                           // optional; ALSO save the subflow's output to a PERSISTENT cross-run key (\${kv:NAME}, rule 9d)
    "outputMode": "steps" | "final-only" }
- { "key": "...", "type": "finish", "label": "..." }
- { "key": "...", "type": "signal", "label": "...",                // fire-and-forget event (rule 11): emits {topic, payload} then passes through unchanged
    "topic": "<event topic other flows' triggers listen for>",     // REQUIRED — a signal with no topic emits nothing
    "payloadTemplate": "event body, may use \${var:NAME}" }         // optional; defaults to the node prompt
- { "key": "...", "type": "resource", "label": "...",              // OPTIONAL/advanced (rule 9c): a data artifact shown in the graph
    "server": "<server name>", "uri": "<resource uri>",            // EITHER a static MCP resource…
    "runName": "NAME" }                                            // …OR a run artifact steps produce/consume

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
6. A subflow node may have only ONE outgoing edge. Give it EITHER a "flow" (naming an existing flow) OR a "subflowSpec" (an inline nested FlowSpec that becomes its own child flow) — not both. A "subflowSpec" may itself contain subflow nodes with their own "subflowSpec" (bounded nesting), so you can author whole multi-level flows in one object.
7. A subflow node may instead fan out to SEVERAL child flows CONCURRENTLY via "parallelFlows" (existing flows) or "parallelSubflowSpecs" (inline). These are STATIC (fixed at author time): the same input is sent to every lane and their outputs are joined. This is about multiple CHILDREN, not successors — the single-outgoing-edge rule (rule 6) still holds. Prefer "parallelFlows" for large fan-outs.
7b. For DYNAMIC fan-out — when the set of target flows should be decided AT RUNTIME by an earlier step — use "parallelFlowsVariable": "NAME". An upstream process/subflow node captures a JSON array of flow ids/names (or a newline list) into run variable NAME via "captureVariable": "NAME"; this subflow node then fans out over exactly those flows. Unknown ids and a self-reference are dropped, the count is capped, and a non-empty resolution overrides any static "parallelFlows" (empty falls back to it). Mutually exclusive with "mapOverList". Still one outgoing edge (rule 6).
7c. For AGENTIC spawning — when the ROUTING MODEL itself should split the work at the very moment it hands off — set "allowCallerFanout": true on the target subflow node. This makes it a SPAWNABLE sub-agent: its handoff tool gains an optional "task" (string) argument and the routing model may call the tool SEVERAL TIMES IN ONE TURN, each call spawning one parallel instance of the child flow briefed with that call's "task". All instances run concurrently, their outputs are joined in call order, and the flow continues once every instance finishes. A call with no "task" is a plain single handoff. Caller briefs override "spawnBriefs"/"parallelFlows"/"parallelFlowsVariable"; the count is capped. Mutually exclusive with "mapOverList". Still one outgoing edge (rule 6). Use 7c when the deciding (routing) step should choose how to split the work; use 7d's "spawnBriefs" when the AUTHOR fixes the briefs; use 7b when an earlier step computes a set of DIFFERENT flows.
7d. For AUTHOR-DEFINED spawning — a fixed set of parallel briefs for ONE sub-agent — give the subflow node "spawnBriefs": ["...", "..."]. Every visit runs the single child once per brief, concurrently (same pool/tuning as parallel). Each brief may inject \${var:NAME}/\${res:NAME}/\${kv:NAME}. With inputMode "isolated" the brief is the lane's whole prompt; with history modes each lane sees the conversation plus its brief as the closing instruction. Mutually exclusive with "parallelFlows"/"parallelSubflowSpecs"/"mapOverList"; needs a single child ("flow"/"subflowSpec").
8. A subflow node may instead run its SINGLE child flow ONCE PER ITEM via "mapOverList": true. The input is split into items by "itemSplit" ("json-array" default, or "lines"), each item is sent to its own child run, and the per-item outputs are joined (same pool/tuning as parallel). Use "sequential": true to run items in order. Mutually exclusive with "parallelFlows"/"parallelSubflowSpecs".
9. Named variables (scratchpad): a step can save its output with "captureVariable": "NAME" (process or subflow) and any LATER step injects it with \${var:NAME} inside its "prompt" / "isolatedPrompt" / subflow prompt. This survives "latest-message"/"isolated" scoping, unlike conversation history — use it to carry a todo list, a file path, a diff, or a captured result across steps that don't share history. \${var:NAME} is run-scoped and plaintext; it is DISTINCT from \${global:VAR} (configured secrets/config, resolved only for tool args). Capture a subflow's output on the PARENT subflow node — a variable set inside a child flow is not visible to the parent.
9b. Run resources (tracked data): "captureResource": "NAME" (process or subflow) ALSO saves the step's output as a run-scoped RESOURCE — an addressable artifact (flujo://run/... URI) with lineage (which step produced it, which steps read it), readable via the built-in "flujo" MCP server. A later step injects it with \${res:NAME} exactly like \${var:NAME}. Prefer "captureVariable" for short strings; use "captureResource" when the output is a large document/report/dataset worth tracking, or when other tools/agents should be able to read it back. Large or binary MCP tool results (screenshots, files) are auto-captured as run resources without any spec field.
9c. Resource nodes are OPTIONAL/advanced — most flows should not use them; prefer rule 9b's captureResource/\${res:NAME}. Emit one only when the data artifact itself should be VISIBLE in the graph: an edge resource→process means the step READS the artifact (its contents are injected into the step's context); process→resource means the step's output is SAVED to it (run artifacts only, equivalent to captureResource with the node's runName). Resource edges are data wiring, not flow control — they never carry conditions and don't count as a step's successor.
9d. Persistent state (cross-run): "captureKv": "NAME" (process or subflow) saves the step's output to a PERSISTENT key-value store that SURVIVES ACROSS RUNS, injected by any step with \${kv:NAME}. Unlike \${var:} / \${res:} (discarded when the run ends), \${kv:} is what a long-lived SCHEDULED flow uses to carry a loop counter, a pagination cursor, a last-seen id, or a flag to its NEXT run. By default a key lives on the flow's FOLDER board (flows in the same folder share it); prefix the name to change scope: "flow/NAME" (this flow only) or "global/NAME" (whole instance). Plaintext, never secrets (distinct from \${global:VAR}). A model can also read/update a key mid-run via the built-in "flujo" server's kv_get / kv_set tools.
10. Keep flows minimal — only the steps the task needs. Write clear, specific prompts and labels; fill "description" on process nodes.
11. Signals (fire-and-forget events): a "signal" node is a deterministic pass-through that, when the path reaches it, emits an event {topic, payload} onto the flow-run event bus and then continues to its successor unchanged (it never calls a model or touches the conversation). Use it when the flow should notify or kick off ANOTHER flow mid-run — a flow-event trigger configured elsewhere listens for the same "topic" (e.g. "when the review finds blockers, emit a review-blocked signal"). Always give it a "topic" (a signal with no topic emits nothing); "payloadTemplate" is the optional event body and may inject \${var:NAME}. Make emission conditional by putting a conditioned edge (rule 5b) INTO the signal node.
12. Input vs output modes are two DISTINCT axes whose value names differ per node type (issue #152 clarification). inputMode ("full-history" | "latest-message" | "isolated") controls what a step RECEIVES and exists on BOTH process and subflow nodes, but they behave differently: a process node keeps the current turn's tool calls/results, while a subflow node ALWAYS strips system/tool-result/tool-call turns from the parent transcript in every history mode (see the inputMode notes above). "latest-message" means "from the most recent user message onward", NOT "last user + last assistant". outputMode controls what LATER steps see of a step's work and is a SEPARATE enum per node type: a process node uses "full-conversation" | "latest-message" (latest-message hides this step's tool exchange from later steps), a subflow node uses "steps" | "final-only" (live-view folding only). Common word traps: "last-message" = inputMode latest-message; "full-conversation" is a process outputMode value, NOT an input mode. A subflow's final answer is always injected back into the parent transcript regardless of outputMode.`;

# Journey contract for Feature surface (#572)

Product fit owns these task/observation requirements; Feature surface owns frontend/tool code and candidate browser acceptance. These are proposed acceptance cases to align under #564, not current-release claims. The [pilot protocol](tasks.md) measures human outcomes after the identified artifact is accepted.

| Boundary | User must be able to do | Observable check | Drop-off code |
| --- | --- | --- | --- |
| Install/open | Identify the candidate and keep their data while opening it; understand a missing runtime or occupied port | Start/open or stop with actionable guidance; no suggestion to delete workspace data | `install` |
| Model | Save, then distinguish an untested connection, successful test and failed test | Credentials/quota/prerequisite error leads to the relevant edit/retest action; saving never implies verified access | `model` |
| MCP connect | See whether the server is saved, discovering, connected or failed, and where it executes | Runtimes/credentials/root requirements are visible before install; a failure preserves entered configuration and provides retry | `connect` |
| Inspect | Find and understand an available tool without assuming every discovery call returns the whole list | All 128 tools in #526's fixture are reachable through list/search and keyboard navigation; failed refresh preserves prior results with clear stale status | `inspect` |
| Tool test | Enter/edit a complex form and decide when it actually invokes a tool | #517 form remains mounted; equivalent discovery/prefill/refresh cannot erase edits; no call occurs before explicit Test | `tool-test` |
| Agent | Bind the tested AI and selected MCP tool in Easy mode, save, run and inspect the result | Missing model/app binding points to the setting; completion includes an actual tool call and assistant result | `agent` |
| Approval | Inspect the tool/arguments and choose approve/reject accessibly | No operation before approval; denial preserves the conversation and explains the result | `approval` |
| Debugger | Discover Expert/visual controls when needed, pause, locate the node/result and resume | Pause state, current node and resume/step actions remain understandable and keyboard reachable | `debugger` |
| Reuse | Discover proxy/OpenAI client configuration for the same saved connection/agent | Copyable localhost connection details match the candidate auth/transport contract; real discovery and invocation both pass | `proxy` |

Keep Apps, Agents/Talk and ordinary Automations understandable by default. Advanced graphs, debugger and approvals must remain available when the user needs them. Do not replace MCP inspection/proxy or visual control with a chat-only first-run funnel. Experimental Personas remain distinct from the normal agent task.

## Browser and accessibility acceptance

On each claimed supported candidate/platform/language, check this complete path at ordinary desktop size, 200% zoom and a 360 CSS-pixel viewport. Check keyboard focus order, visible focus, dialog focus restoration, labelled inputs/buttons, readable validation errors and an announced status change with the supported screen-reader/browser pair. Include the tool editor, approval panel and paused debugger; passing the landing page alone is insufficient.

Verify the saved/unverified/tested distinction using actual state transitions, not green styling. A failed discovery/model test must announce failure without treating the last success as a fresh check. If cached tools remain visible, identify that they are from the previous discovery. Keep user-entered fields when retry/refresh fails and when the same server's capability list changes. Switching to another server must not present a stale form as that server's tool.

Include upgrades of a disposable workspace with model/app bindings, edited tool arguments and conversation history. Bind evidence to both pre-upgrade and post-upgrade artifacts; screenshots from a source patch cannot stand in for published artifact results. Cover #517's complex Firecrawl/Playwright-like schemas and #526's 128-tool fixture with their owners' exact contract. Existing user patches in the primary checkout remain their owner's work.

## Observation and feedback handoff

For each novice, retain the first attempt, product and provisioning clocks, completion or last successful boundary, and any live help/coding. Capture optional redacted screenshots only with explicit consent. A later successful fix is a follow-up confirmation; it does not overwrite the failed first attempt or change the original denominator.

Map failures to the pilot's finite codes: installation, prerequisite, authentication, quota, discovery, tool-form, tool-call, model-binding, runtime, approval, debugger, proxy, accessibility, unclear-next-step or other. No credentials, prompts, customer names, tool arguments or raw logs go in the shared handoff. Supply a redacted issue number, candidate revision/artifact digest and private receipt checksum for reassessment.

Product fit will consume Feature surface's accepted artifact and journey receipts; Feature surface can consume the task cards and aggregated drop-off codes. Docs can link [this packet](README.md) from its #564/#578 ledger and bind a private report's `inputSha256`, `toolSha256`, `artifacts`, `asOf` and scope. The packet requires no change to factory, O, Brain or avatar dispatch/runtime contracts.

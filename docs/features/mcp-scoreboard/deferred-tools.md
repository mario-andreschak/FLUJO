# Deferred tool descriptions

Scoreboard row: **Deferred tool descriptions** on [Is MCP good yet?](https://ismcpgoodyet.com/)
(epic [#1448](https://github.com/mario-andreschak/FLUJO/issues/1448)).
Status in FLUJO: **Yes** (on by default, see below). Read on 2026-11-27.

## What the scoreboard asks for

The row's definition, in short: the model must not receive every MCP tool's
full JSON schema up front. It first sees names or a short index, and a tool's
full schema is loaded only when it is needed. The row cites Cursor's
[dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery).
The page's only rule for grades is that "Partial" means opt-in, a subset of
cases, or experimental; every client rated "Yes" on this row has it on by
default (Codex, Cursor, Claude Code, Grok, OpenCode, Factory Droid).

FLUJO's checklist, taken from that definition and from how the rated clients
and provider docs do it (Anthropic tool search with `defer_loading` and
`tool_reference`, OpenAI `tool_search`, Claude Code's `auto` threshold):

| # | Criterion | FLUJO |
|---|---|---|
| 1 | The model first sees names or a short index, not full schemas | Yes |
| 2 | A search or describe step finds tools | Yes, `search_tools` (words or exact names) |
| 3 | Full schemas load only when needed, then the tool can be called | Yes, found tools are loaded; next turn they carry their full schema |
| 4 | On by default | Yes, `auto` is the default |
| 5 | Works with every provider, native or fallback | Yes, FLUJO's own loader works the same for all; see "Providers" |
| 6 | Per-tool filters still decide what a step may use | Yes |
| 7 | Every call still passes the one approval gate | Yes |
| 8 | Covered by tests for the whole flow | Yes, see "Tests" |

## How it works

1. **Catalog first.** When a Process step defers, its MCP tools are left out of
   the tool list. The model gets one extra tool, `search_tools`, whose
   description lists each tool on one line: name, server and the first sentence
   of its description. The list is capped at about 2,000 tokens: if it does not
   fit, it shows names only, then tool counts per server.
2. **Search.** The model calls `search_tools` with words (`query`) or exact
   names (`names`). FLUJO answers with the matching tools' full descriptions and
   input schemas (up to 5 by default, 20 at most).
3. **Load.** Every tool returned is recorded on the conversation
   (`loadedDeferredTools`). From the next turn on it is offered with its full
   schema, like any other tool, and the model calls it directly.
4. **Stays loaded.** Loaded tools stay for the rest of the conversation, and the
   catalog text never changes, so the provider's prompt cache keeps working: the
   tool block only grows.

FLUJO's own tools (hand-offs, `todo`, `read_resource`, `question` and so on)
are never deferred: they are few, small and steer the run.

### When it is on

Each Process step has a **Tool descriptions** setting (Expert view → step →
Full settings → Input / output; FlowSpec field `toolLoading`):

| Setting | What the model gets |
|---|---|
| Automatic (`auto`, default) | Names first once the step's MCP tool descriptions would take more than 5% of the model's context window (at least 2,000 tokens; 128K window assumed when unknown). Small tool sets keep their full descriptions, because a search would only cost an extra turn. |
| Names first, details when needed (`on-demand`) | Always names first. |
| All details on every turn (`up-front`) | Every description on every turn, as before. |

With a 128K-token model, `auto` defers a step whose MCP tools need more than
about 6,500 tokens, which is roughly 25 to 40 typical tools. This follows
Claude Code's `auto` mode for tool search, which also defers only past a share
of the context window.

### Providers

- **FLUJO's own tool loop** (OpenAI, Anthropic API, Gemini, OpenRouter, Azure,
  Ollama and other OpenAI-compatible models): the flow above. Loaded tools are
  added to the next request.
- **Adapters that run their own tool loop** (Claude subscription, Codex,
  Antigravity): their tool list is fixed for one whole agentic call, so FLUJO
  also offers `call_tool`, which runs a found tool by name. Later turns still
  get the loaded tools with full schemas.
- **Native provider tool search** (Anthropic `tool_search_tool_*` with
  `defer_loading`, OpenAI `tool_search`, Claude Code's and Codex's built-in tool
  search) is not used. FLUJO's restricted Claude and Codex profiles keep their
  built-in tools off for security (`tools: []` in
  `claudeSubscriptionAdapter.ts`, `supports_search_tool: false` in
  `codexRestrictedProfile.ts`), and FLUJO's own loader gives every provider the
  same behaviour and the same approval gate. Using the providers' native search
  where it exists is possible later without changing what the model sees.

### Filters and approval

- A step's per-tool filters (the MCP node's enabled tools, `allowedTools`,
  decisions, private executions) run **before** deferral. A filtered tool is
  never in the catalog and `search_tools` cannot find it.
- Deferred tools stay in the step's offer list (`offeredToolNames`): deferral
  decides what is described, not what is allowed.
- Direct calls to a loaded tool go through runFlow's pause as before.
  `call_tool` asks the gate live with the **real** tool name and arguments;
  the gate lets the `call_tool` wrapper itself through
  (`createLiveToolApproval` in `toolApprovalGate.ts`), so the person sees one
  card for the real tool, not two.
- Private executions keep their exact approved tool list: no deferral there.

## Source

- `src/backend/execution/flow/toolLoading/deferredTools.ts`: modes, threshold,
  catalog, search, `search_tools` and `call_tool` definitions.
- `src/backend/execution/flow/toolLoading/planStepTools.ts`: the per-turn plan
  used by `ProcessNode.prep`.
- `src/backend/execution/flow/toolLoading/toolLoadingExecutors.ts`: what the
  tools do, shared by FLUJO's loop (`ModelHandler.processToolCalls`) and the
  adapters (`localToolExecutors`).
- `src/backend/execution/flow/toolLoading/stepToolInvoker.ts`: how `call_tool`
  runs a step tool (step list, approval, preset arguments, identity, timeout).
- `src/shared/types/flow/toolLoading.ts`: the setting and its values.
- `src/shared/utils/flujoSystemPrompt.ts`: one line in the "FLUJO tools" part of
  the system prompt when `search_tools` is offered.

## Tests

| Test | What it proves |
|---|---|
| `__tests__/flow/deferredToolsFlow.test.ts` | Full flow through the real `ProcessNode.prep` and tool loop: catalog only on turn 1, search returns full schemas, found tools load, turn 2 offers their schema with an unchanged catalog, a direct call runs; search after a restart; small sets stay up front; a filtered tool is never in the catalog. |
| `__tests__/flow/deferredTools.test.ts` | The `auto` threshold, modes, catalog fallbacks, search ranking, `call_tool` only for adapters with their own loop, private executions untouched, FlowSpec round trip. |
| `__tests__/flow/callToolApproval.test.ts` | `call_tool` asks once with the real tool and arguments, a rejection stops it, tools outside the step are refused. |
| Existing `stepToolAllowlist`, `toolApprovalGate`, `respondApprovalGate`, `flujoSystemPrompt` tests | The four rows already at Yes (per-tool filter, approval policy) still hold. |

```powershell
node scripts/run-local-jest.cjs __tests__/flow/deferredToolsFlow.test.ts __tests__/flow/deferredTools.test.ts __tests__/flow/callToolApproval.test.ts --maxWorkers=2
```

## Not done yet

- Not yet checked with a live model in the app: the unattended run had no model
  account. The tests drive the real step and tool loop with a fake MCP service.
- Native provider tool search is not used (see "Providers").
- The search is keyword-based. It ranks a word in the tool's name highest, then
  its server, then its description; there is no embedding search.

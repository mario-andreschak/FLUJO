# Code mode

Scoreboard row: **Code mode** on [Is MCP good yet?](https://ismcpgoodyet.com/)
(epic [#1448](https://github.com/mario-andreschak/FLUJO/issues/1448)).
Status in FLUJO: **Yes** for steps with large tool sets by default, and for any
step that turns it on (see "When it is on"). Read on 2026-11-27.

## What the scoreboard asks for

The row's definition, in short: the model writes code that calls MCP tools, and
the intermediate results stay out of the prompt. It cites Anthropic's
[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
"Partial" means opt-in, a subset of cases, or experimental. The clients rated
"Yes" (OpenCode, Factory Droid) have it on by default; Codex and Claude Code
are "Partial" because theirs is off by default or experimental.

FLUJO's checklist, from that definition, the cited article and the rated
clients (OpenCode's `tools.<server>.<tool>()`, Droid's sandboxed Script tool,
Claude Code's REPL rules):

| # | Criterion | FLUJO |
|---|---|---|
| 1 | The model writes a program that calls MCP tools as functions | Yes, `run_tool_script`, `await tools.<server>.<tool>(args)` |
| 2 | Intermediate tool results stay out of the model's context | Yes, only the return value and `console.log` output come back |
| 3 | Runs in a sandbox with no network or file access of its own | Yes, QuickJS in WebAssembly on a worker thread |
| 4 | Time, CPU and memory are bounded | Yes, see "Limits" |
| 5 | Every tool call passes the same rules as a direct call | Yes, the step's tool list and the one approval gate, with the real tool name |
| 6 | On by default, can be set per step | Yes, `auto` (default) is on with deferred descriptions; `on`/`off` per step |
| 7 | Works with every provider | Yes, it is a FLUJO tool, so OpenAI, Anthropic, Gemini, Claude subscription, Codex and the rest all get it |
| 8 | Documented, with an end-to-end example | This page, `docs/examples/code-mode-folder-report.flowspec.json` |

## What the model sees

One tool, `run_tool_script`, with one input, `code`: the body of an async
JavaScript function. Its description lists the functions (`tools.github.list_issues`
and so on, up to 40, then "… and N more") and says how results look.

```js
const open = await tools.github.list_issues({ state: "open" });
const bare = open.filter((issue) => issue.labels.length === 0);
for (const issue of bare) await tools.github.add_label({ number: issue.number, label: "triage" });
return { labelled: bare.map((issue) => issue.number) };
```

- `tools.<server>.<tool>(args)` calls a step tool. Server and tool names become
  identifiers (`mcp-filesystem` → `mcp_filesystem`).
- `callTool("<tool name>", args)` calls a tool by its model-facing name, or by
  its MCP name when only one server has it.
- A tool returns its structured result; otherwise its text, parsed when it is
  JSON; otherwise its parts with pictures and other binary data left out.
- A failed call (tool error, rejected approval, tool outside the step) throws
  an `Error`, so `try`/`catch` works.

FLUJO answers the model with JSON:
`{ "ok": true, "result": …, "logs": "…", "calls": [{ "tool": "list_issues", "ok": true }, …], "seconds": 0.4 }`,
or `{ "ok": false, "error": "…" }`. The answer is kept within the tool result
size limit (#1226); a longer one is stored as a run resource for `read_resource`.

## When it is on

Each Process step has a **Code mode** setting (Expert view → step → Full
settings → Input / output; FlowSpec field `codeMode`):

| Setting | Meaning |
|---|---|
| Automatic (`auto`, default) | On whenever the step defers tool descriptions, which `auto` tool loading does for large tool sets ([deferred-tools.md](deferred-tools.md)). That is exactly the case the cited article is about: many tools and big results. |
| On (`on`) | Always offered when the step has MCP tools. |
| Off (`off`) | Never offered. |

Code mode is never offered in private executions or tool-free terminal steps.
With deferred descriptions a program can call a deferred tool without loading
it first; `search_tools` tells the model each tool's inputs and its script name.

## The sandbox

Research summary (November 2026):

| Option | Licence | Why (not) |
|---|---|---|
| **QuickJS in WebAssembly** ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten), `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` 0.32.0) | MIT | Chosen. A separate interpreter with no Node APIs at all, a hard heap limit, an interrupt hook for CPU time, and no native build, so Windows and Linux behave the same. |
| Node `vm` | MIT (Node) | Not a security boundary: same process, same memory, Node APIs reachable. Now blocked by lint (`flujo/no-node-vm`). |
| isolated-vm | ISC | A V8 isolate is strong, but it is a native addon that must be built per Node and Electron version, which breaks installs on Windows. |
| SES / Hardened JavaScript | Apache-2.0 | Locks down the shared realm but shares the event loop and has no CPU or memory limit. |
| Deno or containers | MIT / varies | An extra runtime or Docker per user machine. |

How it runs (`src/backend/execution/flow/codeMode/sandbox.ts`):

- Each program gets a fresh worker thread (`node:worker_threads`), so it never
  blocks FLUJO's event loop, and the worker is ended when the program is done.
- Inside the worker the program runs in a fresh QuickJS context. Its only way
  out is one function that posts a tool call to FLUJO; FLUJO checks and runs the
  call and posts the answer back. There is no `require`, `process`, `fetch`,
  file system or timers.
- A program reaches nothing a direct tool call could not reach: it can only
  call the step's own MCP tools.

### Limits

| Limit | Value | When it is reached |
|---|---|---|
| Wall time | 10 minutes, tool calls and approvals included | The program is stopped and the model gets "The program ran longer than … seconds". |
| Busy CPU | 10 seconds of program code without a pause | The interpreter stops it (`interrupted`). |
| Memory | 1/128 of the computer's RAM, between 32 MB and 256 MB | The program fails with "out of memory". |
| Tool calls | 1,000 per program | Further calls throw "Split the work into several programs". |
| Parallel tool calls | 8 per program | More calls wait their turn, nothing is refused. |
| Programs at once | half the CPU cores, at least 2 | A new program waits up to 2 minutes for a free slot, then reports that FLUJO is busy. Every slot is given back when its program ends, however it ends. |
| Console output | 20,000 characters | The rest is dropped and `logsTrimmed` is set. |

All limits are per program and end with that program, so nothing stays blocked.
Stop in the chat ends a running program at once.

### Approval

Every tool call a program makes goes through `invokeStepTool`
(`src/backend/execution/flow/toolLoading/stepToolInvoker.ts`):

1. The tool must be one the step offers (its per-tool filters).
2. The one approval gate is asked with the **real** tool name and arguments,
   through `createLiveToolApproval` (`toolApprovalGate.ts`). A program cannot
   pause the run, so it waits live on the same card and `/respond` route the
   Claude and Codex adapters use (30-minute limit).
3. Then the same steps as a direct call: preset arguments, run authority, the
   advertised tool identity, the tool's timeout and Stop.

| The run's setting | What the person sees |
|---|---|
| Approval off, no step rule | No card. |
| A step rule (`requireApprovalFor`, "Ask before tools that can change data") | A card for each covered call, with its real arguments. |
| Require tool approvals on | A card for the program itself (the code), then one for each call it makes. This is how Claude Code treats its REPL outside auto mode. |
| Nobody can answer (`approvalPolicy: fail`, unsaved run) | Covered calls fail and do not run; the program sees the error. |

## End-to-end example

`docs/examples/code-mode-folder-report.flowspec.json` is a complete agent: a
start step, a "Folder report" step bound to the built-in `filesystem` app with
`"toolLoading": "on-demand"` and `"codeMode": "on"`, and a finish step. To try
it: replace `<your model>` with the name of one of your AI models, send the file
as `{ "spec": …, "save": true }` to `POST /api/flow/compile`, then open the new
agent and ask in the chat "What is in my notes folder?". Or build the same step
by hand in Expert view and set "Tool descriptions" and "Code mode".

What happens:

1. Turn 1: the model sees `search_tools` (with a one-line list of the
   filesystem tools) and `run_tool_script`.
2. It may call `search_tools` with `{"names": ["list_dir", "read_file"]}` to
   read their inputs.
3. It calls `run_tool_script` with a program that lists the folder, reads every
   file and returns `[{ "name": "a.md", "lines": 120, "heading": "# Plan" }, …]`.
4. FLUJO runs each `list_dir` and `read_file` call through the step's tool list
   and the approval gate. The file contents stay inside the program; the model
   receives only the short list and answers with a table.

The same flow, with a fake MCP server instead of the filesystem, is the test
`__tests__/flow/deferredToolsFlow.test.ts` ("code mode, full flow"): a program
lists 40 issues (40 KB of text), labels the 10 without labels, and the model's
answer holds only the 10 numbers and the call summary.

## Tests

| Test | What it proves |
|---|---|
| `__tests__/flow/codeModeSandbox.test.ts` | Real worker and interpreter: functions, parallel calls, errors, no Node/network/file/timer access, busy-CPU stop, memory limit, wall-time limit, Stop, call limit with waiting parallel calls, log limit. |
| `__tests__/flow/deferredToolsFlow.test.ts` | Full flow through `ProcessNode.prep` and `ModelHandler.processToolCalls`: the tool and its function list are offered, only the result returns, step rules ask the gate with the real tool and arguments, "require approval" asks for each call, no approver fails closed, tools outside the step are refused, `auto` turns it on with deferred descriptions. |
| `__tests__/flow/deferredTools.test.ts` | When code mode is offered, FlowSpec support, the documented example compiles. |
| `tooling/eslint-plugin-flujo/rules.test.mjs` | `flujo/no-node-vm` catches `node:vm` and `new Function`. |

```powershell
node scripts/run-local-jest.cjs __tests__/flow/codeModeSandbox.test.ts __tests__/flow/deferredToolsFlow.test.ts --maxWorkers=2
```

## Not done yet

- Not yet checked with a live model in the app: the unattended run had no model
  account. The tests drive the real step, tool loop and sandbox with a fake MCP
  service.
- Code mode is on by default only where descriptions are deferred. A stricter
  reading of the scoreboard that wants it on every step would rate this
  "Partial"; switching the default means changing `offersCodeMode` in
  `src/backend/execution/flow/codeMode/codeModeTool.ts` once it has been tried
  with real models.
- Programs cannot keep state between runs or save helper functions (the
  article's "skills"); each program starts fresh.

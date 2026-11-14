# Flow turn benchmark

Issue #1404 measures FLUJO's own time for one flow turn, the part a voice
front-end waits for on top of the model and its tools.

`scripts/flow-turn-benchmark.mjs` starts a production build of FLUJO with an
empty data folder, a local OpenAI-compatible stub model and a local stub MCP
server. The flow has one Process node with three MCP tools and one knowledge
resource bound in its prompt with `${resource:...}`. Each stub records when
FLUJO reached it, so the time that is left is FLUJO's own. Nothing outside the
machine is contacted unless `--real` is given.

## Running it

Build first, then run from the checkout:

```bash
npm run build
node scripts/flow-turn-benchmark.mjs --runs 10
```

The report goes to standard output. `--out <file>` also writes all runs as
JSON; keep that file outside the checkout. To compare two such files step by
step (for example before and after a change):

```bash
node scripts/flow-turn-benchmark.mjs --compare before.json after.json
```

- `--modes stream,json`: streamed and non-streamed `/v1/chat/completions`.
- `--scenarios answer,tool,continue` (default `answer,tool`):
  - `answer`: a new conversation, the model answers at once.
  - `tool`: a new conversation, the model calls one MCP tool first.
  - `continue`: one conversation across all runs. Each turn appends only its new
    message (`metadata.appendMessages`), as a stateful voice client does.
- `--no-owner-auth`: run like a default localhost install (no owner sign-in).
  By default the server runs with an owner policy, as a network-exposed install does.
- `--app <dir>`: benchmark another checkout or build (it needs `.next`).
- `--real`: use a real model instead of the stub
  (`FLUJO_BENCH_REAL_BASE_URL`, `FLUJO_BENCH_REAL_MODEL`, key from
  `FLUJO_BENCH_REAL_KEY` or `OPENAI_API_KEY`).
- `--seed-from <FLUJO data folder> --seed-model <model id>`: use a model that is already configured in another FLUJO, such as a Claude subscription model. Only that model entry and the encryption key file are copied, still encrypted, into the throwaway data folder. This needs FLUJO's default encryption (no password).
- `--fs-probe`: count file-system calls per turn inside the server.
- `--profile <dir>`: write CPU profiles of the warm runs.
- `--node-options <flags>`: extra Node flags for the server under test.

Every mode/scenario pair gets a fresh server process. Run 1 is the cold turn
(first turn after start); the report shows it, the last run and the median of
runs 5 to the last.

## What the columns mean

| step | meaning |
|---|---|
| `total` | request sent until the response (or stream) ended |
| `before_model` | request sent until FLUJO's first request reached the model |
| `mcp_before_model` | time the MCP server spent answering FLUJO before that |
| `first_token_from_send` | request sent until the first streamed text arrived |
| `first_token_pass` | model sent its first token until the client received it |
| `tool_roundtrip` | model finished asking for a tool until FLUJO asked the model again |
| `after_model` | model finished until the response (or stream) ended |
| `flujo_own` | `total` minus the stubs' own time |

## Step timers inside FLUJO

When the server starts with `FLUJO_TURN_TRACE_FILE=<file>`, each
`/v1/chat/completions` request appends one JSON line with named spans and marks
(see `src/backend/execution/flow/turnTrace.ts`). The benchmark sets it and adds
the spans to its report as `trace: <name>`. Spans can nest, so they do not add
up. Without the variable the timers call straight through and cost nothing.
</content>

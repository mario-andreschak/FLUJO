# Parallel chat load test

Issue #757 measured 300 parallel `/v1/chat/completions` requests with
`flow-<name>` models: they waited minutes before FLUJO's first model call.
`scripts/chat-burst-load-test.mjs` repeats that test on any machine.

## Running it

Build first, then run from the checkout:

```bash
npm run build
node scripts/chat-burst-load-test.mjs --parallel 300 --out <file outside the checkout>.json
```

It starts a production FLUJO on a free port with an empty data folder, a stub
OpenAI-compatible model on loopback and a flow `BurstPlain` (Start, Process,
Finish). Each request hides a unique code in about 1,000 tokens of filler text
and asks for it back, so every answer is checked. The stub notes when FLUJO
reached it, so "first model call" is FLUJO's own time. Nothing outside the
machine is contacted. The exit code is 2 when any request did not answer
correctly.

- `--parallel <n>` requests sent at once (default 300); `--rounds <n>` bursts in a row.
- `--mode stream|json` streamed (default) or plain replies.
- `--filler-tokens <n>` prompt size; `--stub-delay <ms>` how long the stub model takes.
- `--no-warmup` skips the single request sent before the burst.

Against a running FLUJO with a real model (for example vLLM), use one of its
own flows. No stub is started and nothing is created. Start that FLUJO with
`FLUJO_TURN_TRACE_FILE=<file>` to see its first model call and its waits:

```bash
FLUJO_LOADTEST_TOKEN=<token, if the server needs one> \
node scripts/chat-burst-load-test.mjs --url http://127.0.0.1:4200 --flow plain \
  --workspace <workspace> --parallel 300 --trace-file <file>
```

## What the rows mean

| row | meaning |
|---|---|
| first model call (stub) | request sent until FLUJO's model request reached the stub |
| first token / total | request sent until the first answer text / the end |
| server: request admitted | until FLUJO started reading the request |
| server: waiting for a run slot / stream slot | time spent waiting for a free run or reply stream |
| server: run started | until the flow run began |
| server: model catalog registration | time to register as a reader of the model list |
| server: saving conversation state | time spent saving the conversation during the run |

## Results so far

In-process runs of the same burst (`__tests__/chat/parallelChatBurst.test.ts`
with `FLUJO_CHAT_BURST_COUNTS=1,50,300`): real route, storage and locks, stub
model, streamed replies, Windows 10, 8 threads, a machine shared with other
work. First model call in ms, for the requests that got one.

| parallel | before #757 fix | after |
|---:|---|---|
| 1 | | 294 |
| 50 | 39 answered, 11 refused with 503 at once; p50 8,115, p95 12,037 | 50 answered; p50 4,802, p95 7,193 |
| 300 | 46 answered, 248 refused with 429 after 10 s, 6 with 503; p50 8,036, p95 12,094 | 300 answered; p50 26,458, p95 45,085 |

What changed: requests with a declared size are read together instead of two
at a time; busy runs and reply streams make a request wait its turn instead of
refusing it; concurrent model calls share one model-catalog registration; and
the end of a run no longer re-measures every cached conversation.

What is left: each run still saves its state and recovery checkpoints several
times (about 1 to 3.5 s per run during a burst), and a workspace runs up to 16
streamed chats at once, so the 300th request waits for the ones before it.
The original vLLM/H100 production numbers still need a run on that setup.

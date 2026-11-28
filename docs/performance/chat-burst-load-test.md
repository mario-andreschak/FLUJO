# Parallel chat load test

Issue #757 measured 300 parallel `/v1/chat/completions` requests with
`flow-<name>` models: they waited minutes before FLUJO's first model call.
`scripts/chat-burst-load-test.mjs` repeats that test on any machine, and the
`Chat burst load test` job of `verify-full.yml` reruns it without anyone.

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
machine is contacted.

- `--parallel <n>` requests sent at once (default 300); `--rounds <n>` bursts in a row.
- `--mode stream|json` streamed (default) or plain replies.
- `--cold-start` sets FLUJO up, stops it, starts it again on the same data and
  sends the burst the moment the new process accepts connections. The stub
  model is starting too: for three seconds after FLUJO first reaches it, it
  answers 503 with no body, as vLLM did in #757.
- `--filler-tokens <n>` prompt size; `--stub-delay <ms>` how long the stub model takes.
- `--no-warmup` skips the single request sent before the burst.

## Pass rules

A run against its own FLUJO passes only when every request is answered
correctly with HTTP 200, no request is refused or lost, and the 95th
percentile of FLUJO's time before its first model call stays under 45 s
(75 s for `--cold-start`, which includes the model server's own start).
Otherwise the exit code is 2. The rules are fixed in `PASS_RULES` in the
script, so the CI job cannot loosen them.

`verify-full.yml` runs, on a fresh production build on Ubuntu:

```bash
node scripts/chat-burst-load-test.mjs --parallel 300 --mode stream
node scripts/chat-burst-load-test.mjs --parallel 300 --mode json
node scripts/chat-burst-load-test.mjs --parallel 50 --mode json
node scripts/chat-burst-load-test.mjs --parallel 300 --mode stream --cold-start
```

`scripts/workflow-contract.mjs` (`assertChatBurstLoadJob`) fails when any of
these runs is missing, optional, changed or run before the build.

## Against a real model

Against a running FLUJO with a real model (for example vLLM), use one of its
own flows. No stub is started and nothing is created. Start that FLUJO with
`FLUJO_TURN_TRACE_FILE=<file>` to see its first model call and its waits:

```bash
FLUJO_LOADTEST_TOKEN=<token, if the server needs one> \
node scripts/chat-burst-load-test.mjs --url http://127.0.0.1:4200 --flow plain \
  --workspace <workspace> --parallel 300 --trace-file <file>
```

Only the answer and refusal rules apply there; the time rule needs the stub.

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

## Results

Production build, Node 22.23.4, Windows 10, 8 threads, 32 GB, on a PC shared
with other work, so the same run varies by up to a third; where a run was
repeated both results are shown. Stub model that answers at once. First model
call in seconds, p50 / p95. FLUJO answered every request that reached it
correctly with HTTP 200 and refused none.

| run | before (bundle `c3dcc0e5`) | after |
|---|---|---|
| 50 plain | | 1.5 / 3.0, 0.9 / 1.7 |
| 50 streamed | | 1.3 / 2.2 |
| 300 streamed | 17.7 / 26.5 | 10.4 / 14.9, 13.1 / 19.7 |
| 300 plain | 18.3 / 25.8, 20.7 / 25.8 | 6.3 / 10.8 |
| 50 streamed, FLUJO just restarted | 8.8 / 11.5 | 6.1 / 7.5 |
| 300 streamed, FLUJO just restarted | 17.2 / 24.8 | 13.7 / 20.2, 10.5 / 16.1, 11.1 / 17.0 |
| 50 streamed, FLUJO and the model starting | ended with the model's 503 | 12.7 / 13.3, 16.3 / 18.3 |
| 300 streamed, FLUJO and the model starting | ended with the model's 503 | 18.7 / 24.4 |

In the "model starting" runs the stub answered 503 48 times; every one of
those chats waited and was answered. On this Windows PC, which queues only
about 200 connections a busy process has not accepted yet, one of the three
"just restarted" 300 runs had 3 connections refused by Windows before they
reached FLUJO (while all routes were still loaded at start, two of four runs
had 22 and 33). The load test now tries such a connection again after half a
second, as the OpenAI SDK does, and reports how often. Linux, where the CI job
runs, queues 511 and makes a client wait instead of refusing it.

What made the difference, found by profiling the server during a burst:

- Node 22 keeps AsyncLocalStorage values with async hooks that run for every
  promise. They took about a sixth of the server's time. The server now runs
  with async context frames, as Node 24 does by default
  (`serverNodeArgs` in `scripts/launch-next.mjs`). This alone made a burst
  about twice as fast.
- Every release of a run or stream slot retried every waiting request, and each
  retry built a new error with a stack trace: 300 waiters times 300 releases. A
  workspace that is full now ends its waiters' turn after the first refusal
  (`src/utils/capacityWaitQueue.ts`).
- Requests that check the same workspace folders or the same lock file at the
  same time share one fresh check (`src/utils/sharedFreshCheck.ts`), instead
  of each making a dozen file system calls.
- Storage paths no longer read the environment and rebuild the same folder
  path for every file (`getDataDir`, `getWorkspaceDir`).
- Saving a conversation writes each small message with one native JSON call
  instead of thousands of generator steps (`conversationPublication.ts`).
- A restarted FLUJO loads each route when it is first used. Loading all 151 at
  start held its only thread for seconds just as it began to accept
  connections (`preloadEntriesOnStart` in `next.config.mjs`).
- A model server that answers 502, 503 or 504 while it starts gets about a
  minute across the automatic retries (`planAutomaticRetry`), and a request
  that reaches FLUJO before its own startup began waits for it
  (`src/backend/services/workspace/startupWait.ts`).

Earlier in-process results (`__tests__/chat/parallelChatBurst.test.ts` with
`FLUJO_CHAT_BURST_COUNTS=1,50,300`), from the first #757 fix that made bursts
wait instead of being refused: 50 answered of 50 (p50 4.8 s, p95 7.2 s) and
300 of 300 (p50 26.5 s, p95 45.1 s), where before 11 of 50 and 254 of 300 had
been refused.

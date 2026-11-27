// Actual installed Agent SDK with its bundled Claude Code, in its own Node
// process (Jest cannot load the SDK's ESM build). It receives the plain query
// options FLUJO's adapter built and relays every callback (hooks, canUseTool,
// in-process tool handlers) back to the test process over stdin/stdout, so
// FLUJO's own callbacks answer the real Claude Code process.
//
// stdin, one JSON object per line: first the config
// ({ prompt, options, runtime: { cwd, env }, callbacks }), then
// { type: 'reply', id, result | error } for each relayed call, or
// { type: 'abort' } when the adapter stops the query.
// stdout: { type: 'frame', message } for each SDK message and
// { type: 'call', id, target, ... } for each callback.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const config = JSON.parse((await lines.next()).value);
const abortController = new AbortController();
const pending = new Map();
let nextId = 0;
let finish;
const finished = new Promise(resolve => { finish = resolve; });

void (async () => {
  for (;;) {
    const { value, done } = await lines.next();
    if (done) break;
    const line = JSON.parse(value);
    if (line.type === 'abort') {
      abortController.abort();
      finish();
    } else if (line.type === 'reply') {
      const waiter = pending.get(line.id);
      pending.delete(line.id);
      if (line.error !== undefined) waiter?.reject(new Error(line.error));
      else waiter?.resolve(line.result);
    }
  }
  abortController.abort();
  finish();
})();

const write = line => process.stdout.write(`${JSON.stringify(line)}\n`);
const relay = (target, fields) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  write({ type: 'call', id, target, ...fields });
});

// Keep the input open until the run ends: hook and permission answers travel
// on the same channel.
async function* prompt() {
  yield config.prompt;
  await finished;
}

const { callbacks } = config;
const response = query({ prompt: prompt(), options: {
  ...config.options,
  cwd: config.runtime.cwd,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    ...config.runtime.env },
  abortController,
  ...(callbacks.canUseTool ? { canUseTool: (name, input, opts) => relay('canUseTool',
    { args: [name, input, { toolUseID: opts.toolUseID, decisionReason: opts.decisionReason }] }) } : {}),
  hooks: Object.fromEntries(Object.entries(callbacks.hooks).map(([event, count]) =>
    [event, [{ hooks: Array.from({ length: count }, (_, index) =>
      (input, toolUseID) => relay('hook', { event, index, args: [input, toolUseID] })) }]])),
  mcpServers: Object.fromEntries(Object.entries(callbacks.mcpServers).map(([server, tools]) =>
    [server, createSdkMcpServer({ name: server, version: '1.0.0', tools: tools.map(definition => tool(
      definition.name, definition.description,
      Object.fromEntries(definition.properties.map(property => [property, z.string().optional()])),
      args => relay('tool', { server, name: definition.name, args: [args] }),
    )) })])),
} });

try {
  for await (const message of response) {
    write({ type: 'frame', message });
    if (message.type === 'result') break;
  }
} finally {
  finish();
  response.close();
  process.stdin.destroy();
}

#!/usr/bin/env node
/**
 * The smallest useful tool server for load tests: one tool, `echo`, that returns its
 * text. It has no dependencies and speaks MCP over standard input and output, so a load
 * test exercises FLUJO's real path for tool calls, including its real child process.
 *
 * LOAD_TEST_TOOL_DELAY_MS makes each call slower.
 */
import { createInterface } from 'node:readline';

const delayMs = Number(process.env.LOAD_TEST_TOOL_DELAY_MS ?? 0);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });

const tool = {
  name: 'echo',
  description: 'Returns the text it was given.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'load-test-echo', version: '1.0.0' },
    });
  } else if (method === 'ping') {
    respond(id, {});
  } else if (method === 'tools/list') {
    respond(id, { tools: [tool] });
  } else if (method === 'tools/call') {
    const reply = () => respond(id, { content: [{ type: 'text', text: String(params?.arguments?.text ?? '') }] });
    if (delayMs > 0) setTimeout(reply, delayMs); else reply();
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));

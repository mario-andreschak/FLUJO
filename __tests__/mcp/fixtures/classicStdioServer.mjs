// Real stdio MCP server that only knows the classic `initialize` handshake.
// CLASSIC_EARLY_REQUEST decides what it does with any other first request:
//   reply (default) - answers "Method not found" like the official v1 SDKs
//   exit            - quits, like servers whose SDK dies on an early request
// It records its pid so tests can count the processes FLUJO started.
import { appendFileSync } from 'node:fs';

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let initialized = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      initialized = true;
      write({ id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'classic-stdio-fixture', version: '1.0.0' },
      } });
    } else if (!initialized && message.id !== undefined) {
      if (process.env.CLASSIC_EARLY_REQUEST === 'exit') process.exit(1);
      write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    } else if (message.method === 'tools/list') {
      write({ id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (message.method === 'tools/call') {
      write({ id: message.id, result: { content: [{ type: 'text', text: 'classic echo' }] } });
    } else if (message.method === 'ping') {
      write({ id: message.id, result: {} });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

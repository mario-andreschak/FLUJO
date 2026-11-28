// Real stdio MCP server for the secret setting checks (#1337). Its one tool,
// `deploy`, answers with a hash of the FLY_API_TOKEN it was started with, so a
// test can tell which value arrived without the secret ever being printed.
// It records its pid so tests can tell a restarted process from the old one.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const token = createHash('sha256').update(process.env.FLY_API_TOKEN ?? '').digest('hex');
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
      write({ id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'secret-env-fixture', version: '1.0.0' },
      } });
    } else if (message.method === 'tools/list') {
      write({ id: message.id, result: { tools: [{ name: 'deploy', description: 'Reports which token it was started with.',
        inputSchema: { type: 'object', properties: {} } }] } });
    } else if (message.method === 'tools/call') {
      write({ id: message.id, result: { content: [{ type: 'text', text: `deployed with token ${token} pid ${process.pid}` }] } });
    } else if (message.method === 'ping') {
      write({ id: message.id, result: {} });
    } else if (message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

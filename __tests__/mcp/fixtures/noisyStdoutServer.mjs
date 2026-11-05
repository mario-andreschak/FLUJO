// Minimal real stdio MCP server for lifecycle tests. It records its pid on start and,
// when NOISY_STDOUT=1, prints one line that is not JSON right after the handshake,
// which is what many ordinary third-party servers do with a stray console.log.
import { appendFileSync } from 'node:fs';

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

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
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'noisy-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'notifications/initialized') {
      if (process.env.NOISY_STDOUT === '1') process.stdout.write('server ready, this line is not JSON\n');
    } else if (message.method === 'tools/list') {
      reply(message.id, { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] });
    } else if (message.method === 'ping') {
      reply(message.id, {});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

// The smallest working MCP server, for the MCP bundle tests (#1230). It needs
// no packages: it answers newline-separated JSON-RPC on stdin and stdout.
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`);

function handle(message) {
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'hello-bundle', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'hello',
        description: 'Say hello',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      }],
    });
  } else if (message.method === 'tools/call') {
    const name = message.params?.arguments?.name || 'world';
    reply(message.id, { content: [{ type: 'text', text: `${process.env.GREETING || 'Hello'}, ${name}!` }] });
  } else if (message.method === 'ping') {
    reply(message.id, {});
  } else {
    fail(message.id, `Unknown method ${message.method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

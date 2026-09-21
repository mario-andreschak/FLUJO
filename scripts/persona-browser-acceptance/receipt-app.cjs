const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const url = new URL(process.argv[2]);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Local fixture URL required.');
const server = new Server({ name: 'Journey receipt App', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'journey_receipt', description: 'Return a deterministic receipt from the disposable local journey fixture.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: { type: 'object', properties: { token: { type: 'string', enum: ['JOURNEY_CHAT', 'JOURNEY_BUSY', 'JOURNEY_TASK'] } },
    required: ['token'], additionalProperties: false },
}] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const token = request.params.arguments?.token;
  if (request.params.name !== 'journey_receipt' || !['JOURNEY_CHAT', 'JOURNEY_BUSY', 'JOURNEY_TASK'].includes(token)) {
    throw new Error('Invalid fixture invocation.');
  }
  const response = await fetch(new URL('/receipt', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Fixture returned ${response.status}.`);
  const { receipt } = await response.json();
  return { content: [{ type: 'text', text: receipt }] };
});
server.connect(new StdioServerTransport()).catch(error => { process.stderr.write(String(error)); process.exit(1); });
process.stdin.on('end', () => process.exit(0));

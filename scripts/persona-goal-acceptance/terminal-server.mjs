import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fixture from './terminal-fixture.cjs';

const directory = process.argv[2];
if (!directory) throw new Error('An isolated fixture directory is required.');
const researchServer = await fixture.startResearchServer(directory);
const server = new Server({ name: 'terminal-only-goal-environment', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'terminal',
  description: `Execute a general command in the isolated campaign workspace. Shell: ${process.platform === 'win32' ? 'Windows PowerShell' : 'bash'}. Read README.md for the environment, research/publication endpoints and success criteria. Install missing tools locally if needed. This is the only external tool; you choose the commands. All dependencies, browser downloads and authored artifacts must stay inside the working directory.`,
  inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 } }, required: ['command'], additionalProperties: false },
}] }));
server.setRequestHandler(CallToolRequestSchema, request => {
  if (request.params.name !== 'terminal') throw new Error('Only the terminal tool is available.');
  return fixture.executeTerminal(directory, request.params.arguments ?? {});
});
process.stdin.on('end', () => researchServer.close());
await server.connect(new StdioServerTransport());

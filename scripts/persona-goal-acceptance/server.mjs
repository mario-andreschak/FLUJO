import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fixture from './fixture.cjs';

const directory = process.argv[2];
if (!directory) throw new Error('Fixture directory is required.');
const server = new Server({ name: 'goal-acceptance-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fixture.tools }));
server.setRequestHandler(CallToolRequestSchema, request => fixture.callFixtureTool(directory, request.params.name, request.params.arguments));
await server.connect(new StdioServerTransport());

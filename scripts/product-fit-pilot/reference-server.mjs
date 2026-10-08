import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createReferenceState, REFERENCE_TOOLS, REFERENCE_VERSION, REFERENCE_RECEIPT_URI,
} from './reference-data.mjs';

export function createReferenceServer() {
  const state = createReferenceState();
  const server = new Server({ name: 'product-fit-reference', version: REFERENCE_VERSION }, {
    capabilities: { tools: {}, resources: {} },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(REFERENCE_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => state.call(params.name, params.arguments));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{
    uri: REFERENCE_RECEIPT_URI, name: 'Synthetic reference call receipt', mimeType: 'application/json',
    description: 'Read-only process identity, counters and latest 64 call digests; no model or human claim.',
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== REFERENCE_RECEIPT_URI) throw new McpError(ErrorCode.InvalidParams, 'Unknown reference resource.');
    return { contents: [{ uri: REFERENCE_RECEIPT_URI, mimeType: 'application/json', text: JSON.stringify(state.receipt()) }] };
  });
  return { server, state };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/product-fit-pilot/reference-server.mjs\nRead-only synthetic MCP server over stdio; requires this checkout\'s installed lockfile dependencies.\n');
    return;
  }
  if (args.length !== 0) throw new Error('Invalid arguments.');
  const { server, state } = createReferenceServer();
  await server.connect(new StdioServerTransport());
  const { runId, definitionSha256 } = state.receipt();
  process.stderr.write(`${JSON.stringify({ fixture: 'product-fit-reference', synthetic: true, runId, definitionSha256 })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close().catch(() => { process.exitCode = 1; }); });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Reference fixture failed to start; check arguments and the local dependency installation.\n');
    process.exitCode = 1;
  });
}

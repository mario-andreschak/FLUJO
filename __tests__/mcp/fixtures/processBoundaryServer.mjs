#!/usr/bin/env node
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const identity = Object.freeze({
  pid: process.pid,
  token: randomUUID(),
  parentPid: process.ppid,
});

const server = new Server(
  { name: 'flujo-process-boundary-fixture', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, logging: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'identity',
    description: 'Returns the fixture process identity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'identity') {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  }
  return {
    structuredContent: identity,
    content: [{ type: 'text', text: JSON.stringify(identity) }],
  };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: 'fixture://identity',
    name: 'fixture-process-identity',
    mimeType: 'application/json',
  }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{
    uriTemplate: 'fixture://identity/{field}',
    name: 'fixture-process-identity-field',
    mimeType: 'application/json',
  }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === 'fixture://identity') {
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: 'application/json',
        text: JSON.stringify(identity),
      }],
    };
  }
  const field = request.params.uri.match(/^fixture:\/\/identity\/(pid|token|parentPid)$/)?.[1];
  if (!field) throw new Error(`Unknown fixture resource: ${request.params.uri}`);
  return {
    contents: [{
      uri: request.params.uri,
      mimeType: 'application/json',
      text: JSON.stringify({ [field]: identity[field] }),
    }],
  };
});

server.oninitialized = () => {
  void server.sendLoggingMessage({
    level: 'info',
    logger: 'process-boundary-fixture',
    data: { event: 'initialized', ...identity },
  });
};

const transport = new StdioServerTransport();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
}

process.stdin.once('end', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());

server.connect(transport).catch((error) => {
  process.stderr.write(`process-boundary fixture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [baseUrl, agentRoot, runId] = process.argv.slice(2);
const token = process.env.PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN;
if (!baseUrl || !token || !agentRoot || !runId) {
  throw new Error('baseUrl, inherited fixture authorization, agentRoot and runId are required.');
}
const resolvedRoot = path.resolve(agentRoot);
await fs.mkdir(resolvedRoot, { recursive: true });

const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const headers = {
  Authorization: 'Bearer ' + token,
  'Content-Type': 'application/json',
};

async function request(relativePath, options = {}) {
  const response = await fetch(baseUrl + relativePath, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  return {
    ok: response.ok,
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body,
  };
}

async function readArtifacts() {
  const artifacts = {};
  for (const name of ['research.md', 'launch.md', 'backlog.md']) {
    try {
      const content = await fs.readFile(path.join(resolvedRoot, name), 'utf8');
      artifacts[name] = { content, sha256: sha256(content) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return artifacts;
}

const tools = [
  {
    name: 'research_page',
    description: 'Read the approved controlled marketing research service. Use its exact source ID, audience and benefit in campaign work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_campaign_artifact',
    description: 'Write a useful sourced research.md, launch.md or backlog.md campaign artifact. Content is independently hashed and checked against the service facts.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['research.md', 'launch.md', 'backlog.md'] },
        content: { type: 'string', minLength: 80 },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_campaign_workspace',
    description: 'Inspect existing campaign artifacts before deciding the next useful action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'publish_campaign',
    description: 'Publish through the approved controlled service using a stable idempotency key. Retryable failures require durable progress and a later retry. A lost acknowledgement must be reconciled by read-back, not a new effect.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'readback_campaign',
    description: 'Read the service-owned publication state and reconcile an uncertain publication attempt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  if (name === 'research_page') {
    const result = await request('/research.json');
    return result.ok ? text(result.body) : { ...text(result), isError: true };
  }
  if (name === 'write_campaign_artifact') {
    if (!['research.md', 'launch.md', 'backlog.md'].includes(args.name)
      || typeof args.content !== 'string' || args.content.length < 80) {
      return { ...text({ error: 'An approved filename and at least 80 characters are required.' }), isError: true };
    }
    const filename = path.join(resolvedRoot, args.name);
    await fs.writeFile(filename, args.content);
    const digest = sha256(args.content);
    const observed = await request('/artifact-observation', {
      method: 'POST',
      body: JSON.stringify({ name: args.name, content: args.content, sha256: digest }),
    });
    if (!observed.ok) return { ...text(observed), isError: true };
    return text({ written: args.name, sha256: digest, independentlyVerified: true });
  }
  if (name === 'read_campaign_workspace') {
    return text({ artifacts: await readArtifacts() });
  }
  if (name === 'publish_campaign') {
    const result = await request('/publish', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'goal-endurance-publication:' + runId },
      body: '{}',
    });
    return result.ok ? text(result.body) : { ...text({ ...result.body, status: result.status, retryAfter: result.retryAfter }), isError: true };
  }
  if (name === 'readback_campaign') {
    const result = await request('/publication');
    return result.ok ? text(result.body) : { ...text(result), isError: true };
  }
  throw new Error('Unknown endurance fixture tool: ' + name);
}

const server = new Server(
  { name: 'persona-goal-endurance-controlled-service', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, request => callTool(
  request.params.name,
  request.params.arguments ?? {},
));
await server.connect(new StdioServerTransport());

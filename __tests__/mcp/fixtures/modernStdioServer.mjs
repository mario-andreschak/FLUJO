// Real stdio MCP server built on the official split server SDK (`serveStdio`).
// It serves both protocol generations on one process (2026-07-28 `server/discover` and the
// classic `initialize`) and the official Tasks extension: `slow_echo` returns a
// durable task to clients that declare Tasks, which completes after two polls.
// It records its pid so tests can count the processes FLUJO started.
import { appendFileSync } from 'node:fs';
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  CallToolResultV2Schema, CreateTaskResultV2Schema, GetTaskRequestV2Schema, GetTaskResultV2Schema,
  CancelTaskRequestV2Schema, CancelTaskResultV2Schema, hasTaskClientCapabilityV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
const TASKS = 'io.modelcontextprotocol/tasks';
const tasks = new Map();
const now = () => new Date().toISOString();
const echoTool = { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
const slowTool = { name: 'slow_echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };

serveStdio(() => {
  const server = new Server({ name: 'modern-stdio-fixture', version: '1.0.0' }, {
    capabilities: { tools: {}, extensions: { [TASKS]: {} } },
  });
  server.setRequestHandler('tools/list', () => ({ tools: [echoTool, slowTool] }));
  server.fallbackRequestHandler = async (request, ctx) => {
    if (request.method !== 'tools/call') throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
    const { name, arguments: args = {} } = request.params;
    const text = typeof args.text === 'string' ? args.text : '';
    const result = { content: [{ type: 'text', text: `echo:${text}` }] };
    if (name === 'slow_echo' && hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope })) {
      const taskId = `task-${tasks.size + 1}`;
      tasks.set(taskId, { polls: 0, result, cancelled: false });
      return CreateTaskResultV2Schema.parse({
        resultType: 'task', taskId, status: 'working', createdAt: now(), lastUpdatedAt: now(), ttlMs: 60_000, pollIntervalMs: 10,
      });
    }
    if (name !== 'echo' && name !== 'slow_echo') throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool ${name}`);
    return CallToolResultV2Schema.parse({ ...result, resultType: 'complete' });
  };
  server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params }, async params => {
    const task = tasks.get(params.taskId);
    if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task is unavailable.');
    task.polls += 1;
    const base = { resultType: 'complete', taskId: params.taskId, createdAt: now(), lastUpdatedAt: now(), ttlMs: 60_000, pollIntervalMs: 10 };
    if (task.cancelled) return GetTaskResultV2Schema.parse({ ...base, status: 'cancelled' });
    if (task.polls < 2) return GetTaskResultV2Schema.parse({ ...base, status: 'working' });
    return GetTaskResultV2Schema.parse({ ...base, status: 'completed', result: { ...task.result, resultType: 'complete' } });
  });
  server.setRequestHandler('tasks/cancel', { params: CancelTaskRequestV2Schema.shape.params }, async params => {
    const task = tasks.get(params.taskId);
    if (task) task.cancelled = true;
    return CancelTaskResultV2Schema.parse({ resultType: 'complete' });
  });
  return server;
});
process.stdin.on('end', () => process.exit(0));

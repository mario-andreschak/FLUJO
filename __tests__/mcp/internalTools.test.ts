/**
 * Tests for the built-in internal MCP server's tool dispatcher (internalTools.ts).
 * Backend services are mocked; what's pinned here is the dispatch contract:
 * secret redaction, recursion guards, and the pass-through/error shapes.
 */

// Self-contained factories (no closing over outer consts — see jest-test-harness notes).
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: jest.fn(),
    deleteFlow: jest.fn(),
    listFlowVersions: jest.fn(),
    getFlowVersion: jest.fn(),
    revertFlow: jest.fn(),
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: jest.fn(),
  },
}));
jest.mock('@/backend/services/scheduler', () => {
  const list = jest.fn();
  const runNow = jest.fn();
  return {
    getSchedulerService: () => ({ list, runNow }),
    __mocks: { list, runNow },
  };
});
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));
// The authoring tools pull in registryInstall -> mcpService; stub the whole module.
jest.mock('@/backend/services/mcp/flowAuthoringTools', () => ({
  isAuthoringTool: (name: string) => name === 'create_flow',
  authoringToolDefinitions: () => [
    { name: 'create_flow', description: 'authoring', inputSchema: { type: 'object', properties: {} } },
  ],
  authoringCallTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'authored' }] })),
}));
// update_flow goes through compileSpec, which pulls gatherGenerationContext -> mcpService.
jest.mock('@/backend/services/flow/compileFlow', () => ({
  compileSpec: jest.fn(),
}));
// The conversation tools reach into the executor's state loader + log projection;
// stub them so the test never loads the FlowExecutor module graph.
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  flushConversationLog: jest.fn(async () => undefined),
  readConversationLog: jest.fn(async () => undefined),
  projectMessages: jest.fn(() => []),
}));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { currentSeq: jest.fn(() => 0) },
}));
// list_conversations reads db/conversations under the data dir; point it at a
// per-test temp dir when set (terminal tests keep the real data dir).
jest.mock('@/utils/paths', () => {
  const actual = jest.requireActual('@/utils/paths');
  return {
    ...actual,
    getDataDir: () =>
      (global as { __flujo_test_data_dir?: string }).__flujo_test_data_dir ?? actual.getDataDir(),
  };
});

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import {
  internalToolDefinitions,
  internalCallTool,
  InternalDispatchService,
} from '@/backend/services/mcp/internalTools';
import { INTERNAL_SERVER_NAME } from '@/backend/services/mcp/internalServerConfig';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { authoringCallTool } from '@/backend/services/mcp/flowAuthoringTools';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { readConversationLog, projectMessages } from '@/backend/execution/flow/conversationLog';

const flows = flowService as unknown as {
  loadFlows: jest.Mock;
  deleteFlow: jest.Mock;
  listFlowVersions: jest.Mock;
  getFlowVersion: jest.Mock;
  revertFlow: jest.Mock;
};
const models = modelService as unknown as { loadModels: jest.Mock };
const scheduler = (jest.requireMock('@/backend/services/scheduler') as { __mocks: { list: jest.Mock; runNow: jest.Mock } }).__mocks;
const runFlowMock = runFlow as jest.Mock;
const compileSpecMock = compileSpec as jest.Mock;
const loadConversationStateMock = loadConversationState as jest.Mock;
const readConversationLogMock = readConversationLog as jest.Mock;
const projectMessagesMock = projectMessages as jest.Mock;

type MockService = { [K in keyof InternalDispatchService]: jest.Mock };

function makeService(): MockService {
  return {
    loadServerConfigs: jest.fn(),
    getServerStatus: jest.fn(),
    listServerTools: jest.fn(),
    callTool: jest.fn(),
    forceReconnect: jest.fn(),
    updateServerConfig: jest.fn(),
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  (global as { __flujo_internal_flow_depth?: number }).__flujo_internal_flow_depth = undefined;
});

describe('internalToolDefinitions', () => {
  it('exposes the authoring tools plus the management tool set', () => {
    const names = internalToolDefinitions().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_flow', // from the (stubbed) authoring set
        'execute_flow',
        'read_flow',
        'update_flow',
        'list_flow_versions',
        'read_flow_version',
        'revert_flow',
        'delete_flow',
        'list_mcp_servers',
        'list_mcp_server_tools',
        'call_mcp_tool',
        'restart_mcp_server',
        'set_mcp_server_enabled',
        'list_models',
        'list_planned_executions',
        'run_planned_execution',
        'list_conversations',
        'read_conversation',
        'terminal',
      ])
    );
  });
});

describe('terminal', () => {
  it('runs a shell command and returns its output and exit code', async () => {
    const r = await internalCallTool(makeService(), 'terminal', {
      command: process.platform === 'win32' ? 'echo hello-terminal' : 'echo hello-terminal',
    });
    expect(r.isError).toBeUndefined();
    const out = text(r);
    expect(out).toContain('hello-terminal');
    expect(out).toContain('"exitCode": 0');
  });

  it('reports a non-zero exit as an error result', async () => {
    const r = await internalCallTool(makeService(), 'terminal', { command: 'exit 3' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"exitCode": 3');
  });

  it('requires a command', async () => {
    const r = await internalCallTool(makeService(), 'terminal', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('command');
  });

  it('kills a command that exceeds the timeout', async () => {
    const r = await internalCallTool(makeService(), 'terminal', {
      command: process.platform === 'win32' ? 'ping -n 6 127.0.0.1 > NUL' : 'sleep 5',
      timeout: 1,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('timedOut');
  });
});

describe('authoring tool routing', () => {
  it('routes authoring tool names to authoringCallTool', async () => {
    const r = await internalCallTool(makeService(), 'create_flow', { spec: {} });
    expect(authoringCallTool).toHaveBeenCalledWith('create_flow', { spec: {} });
    expect(text(r)).toBe('authored');
  });
});

describe('execute_flow', () => {
  it('resolves a flow by name and returns its output', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'done' });

    const r = await internalCallTool(makeService(), 'execute_flow', { flow: 'My Flow', input: 'hi' });

    expect(runFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'f1', prompt: 'hi', mode: 'ephemeral' })
    );
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe('done');
  });

  it('errors for an unknown flow without running anything', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    const r = await internalCallTool(makeService(), 'execute_flow', { flow: 'nope', input: 'hi' });
    expect(r.isError).toBe(true);
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('refuses to nest beyond the depth limit', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    (global as { __flujo_internal_flow_depth?: number }).__flujo_internal_flow_depth = 4;

    const r = await internalCallTool(makeService(), 'execute_flow', { flow: 'My Flow', input: 'hi' });

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nesting limit');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('restores the depth counter after a run (success or failure)', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'ok' });
    await internalCallTool(makeService(), 'execute_flow', { flow: 'f1', input: '' });
    expect((global as { __flujo_internal_flow_depth?: number }).__flujo_internal_flow_depth).toBe(0);
  });
});

describe('read_flow', () => {
  const storedFlow = {
    id: 'f1',
    name: 'My Flow',
    description: 'does things',
    nodes: [
      {
        id: 'n-start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: { label: 'Start', type: 'start', properties: { promptTemplate: 'sys prompt' } },
      },
      {
        id: 'n-proc',
        type: 'process',
        position: { x: 0, y: 170 },
        data: {
          label: 'Work',
          type: 'process',
          description: 'the worker',
          properties: {
            promptTemplate: 'do work',
            boundModel: 'model-1',
            inputMode: 'latest-message',
            mcpNodes: [{ derived: 'blob that must not round-trip' }],
          },
        },
      },
      {
        id: 'n-mcp',
        type: 'mcp',
        position: { x: 320, y: 170 },
        data: { label: 'srv', type: 'mcp', properties: { boundServer: 'srv', enabledTools: ['tool_a'] } },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'n-start',
        target: 'n-proc',
        type: 'custom',
        data: { edgeType: 'standard', bidirectional: true },
      },
      { id: 'e2', source: 'n-proc', target: 'n-mcp', type: 'mcpEdge', data: { edgeType: 'mcp' } },
    ],
  };

  it('returns the semantic definition: properties and edges kept, positions and derived mcpNodes dropped', async () => {
    flows.loadFlows.mockResolvedValue([storedFlow]);
    const r = await internalCallTool(makeService(), 'read_flow', { flow: 'My Flow' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ id: 'f1', name: 'My Flow', description: 'does things' });
    expect(out.nodes).toHaveLength(3);
    expect(out.nodes[1]).toEqual({
      id: 'n-proc',
      type: 'process',
      label: 'Work',
      description: 'the worker',
      properties: { promptTemplate: 'do work', boundModel: 'model-1', inputMode: 'latest-message' },
    });
    expect(text(r)).not.toContain('must not round-trip');
    expect(text(r)).not.toContain('position');
    expect(out.edges).toEqual([
      { from: 'n-start', to: 'n-proc', type: 'control', bidirectional: true },
      { from: 'n-proc', to: 'n-mcp', type: 'mcp' },
    ]);
  });

  it('errors for an unknown flow', async () => {
    flows.loadFlows.mockResolvedValue([]);
    const r = await internalCallTool(makeService(), 'read_flow', { flow: 'nope' });
    expect(r.isError).toBe(true);
  });
});

describe('update_flow', () => {
  it('resolves by name and compiles into the existing flow id', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    compileSpecMock.mockResolvedValue({
      success: true,
      flow: { id: 'f1', name: 'My_Flow', nodes: [{}, {}], edges: [{}] },
      validation: { errorCount: 0, warningCount: 0, issues: [] },
      saved: true,
    });
    const spec = { name: 'My_Flow', nodes: [], edges: [] };
    const r = await internalCallTool(makeService(), 'update_flow', { flow: 'My Flow', spec });
    expect(compileSpecMock).toHaveBeenCalledWith(spec, { save: true, updateFlowId: 'f1' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ flowId: 'f1', saved: true, nodeCount: 2, edgeCount: 1 });
    expect(out.note).toContain('replaced');
  });

  it('is an error outcome (flow unchanged) when validation blocks the save', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    compileSpecMock.mockResolvedValue({
      success: true,
      flow: { id: 'f1', name: 'My_Flow', nodes: [], edges: [] },
      validation: { errorCount: 2, warningCount: 0, issues: [] },
      saved: false,
    });
    const r = await internalCallTool(makeService(), 'update_flow', { flow: 'f1', spec: { nodes: [] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('NOT saved');
  });

  it('errors for an unknown flow without compiling', async () => {
    flows.loadFlows.mockResolvedValue([]);
    const r = await internalCallTool(makeService(), 'update_flow', { flow: 'ghost', spec: { nodes: [] } });
    expect(r.isError).toBe(true);
    expect(compileSpecMock).not.toHaveBeenCalled();
  });

  it('requires a spec', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    const r = await internalCallTool(makeService(), 'update_flow', { flow: 'f1' });
    expect(r.isError).toBe(true);
    expect(compileSpecMock).not.toHaveBeenCalled();
  });
});

describe('flow version tools', () => {
  beforeEach(() => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
  });

  it('list_flow_versions resolves by name and returns the summaries', async () => {
    flows.listFlowVersions.mockResolvedValue([
      { versionId: '2000-ab', savedAt: 2000, name: 'My Flow', nodeCount: 3, edgeCount: 2 },
    ]);
    const r = await internalCallTool(makeService(), 'list_flow_versions', { flow: 'My Flow' });
    expect(flows.listFlowVersions).toHaveBeenCalledWith('f1');
    const out = JSON.parse(text(r));
    expect(out.flowId).toBe('f1');
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0].versionId).toBe('2000-ab');
  });

  it('read_flow_version returns the archived definition in read_flow format', async () => {
    flows.getFlowVersion.mockResolvedValue({
      versionId: '2000-ab',
      flowId: 'f1',
      savedAt: 2000,
      flow: {
        id: 'f1',
        name: 'My Flow',
        nodes: [{ id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: { promptTemplate: 'old prompt' } } }],
        edges: [],
      },
    });
    const r = await internalCallTool(makeService(), 'read_flow_version', { flow: 'f1', version: '2000-ab' });
    expect(flows.getFlowVersion).toHaveBeenCalledWith('f1', '2000-ab');
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ versionId: '2000-ab', savedAt: 2000, id: 'f1' });
    expect(out.nodes[0].properties.promptTemplate).toBe('old prompt');
  });

  it('read_flow_version errors for an unknown version', async () => {
    flows.getFlowVersion.mockResolvedValue(null);
    const r = await internalCallTool(makeService(), 'read_flow_version', { flow: 'f1', version: 'ghost' });
    expect(r.isError).toBe(true);
  });

  it('revert_flow restores a version and reports that the revert is reversible', async () => {
    flows.revertFlow.mockResolvedValue({ success: true });
    const r = await internalCallTool(makeService(), 'revert_flow', { flow: 'My Flow', version: '2000-ab' });
    expect(flows.revertFlow).toHaveBeenCalledWith('f1', '2000-ab');
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(text(r));
    expect(out.reverted).toBe(true);
    expect(out.note).toContain('undone');
  });

  it('revert_flow maps a service failure to an error result', async () => {
    flows.revertFlow.mockResolvedValue({ success: false, error: 'No version "x"' });
    const r = await internalCallTool(makeService(), 'revert_flow', { flow: 'f1', version: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('No version');
  });
});

describe('delete_flow', () => {
  it('resolves by name and deletes by id', async () => {
    flows.loadFlows.mockResolvedValue([{ id: 'f1', name: 'My Flow' }]);
    flows.deleteFlow.mockResolvedValue({ success: true });
    const r = await internalCallTool(makeService(), 'delete_flow', { flow: 'My Flow' });
    expect(flows.deleteFlow).toHaveBeenCalledWith('f1');
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('"deleted": true');
  });
});

describe('list_mcp_servers', () => {
  it('returns name/transport/status only — never env, headers, or OAuth material', async () => {
    const service = makeService();
    service.loadServerConfigs.mockResolvedValue([
      {
        name: 'a',
        transport: 'stdio',
        disabled: false,
        env: { API_KEY: 'super-secret' },
      },
      {
        name: 'b',
        transport: 'streamable',
        disabled: true,
        headers: { Authorization: 'Bearer secret-token' },
        oauthClientSecret: 'oauth-secret',
      },
    ]);
    service.getServerStatus.mockResolvedValue({ status: 'connected' });

    const r = await internalCallTool(service, 'list_mcp_servers', {});
    const out = text(r);

    expect(out).toContain('"a"');
    expect(out).toContain('"connected"');
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain('oauth-secret');
  });
});

describe('call_mcp_tool', () => {
  it('refuses to call the internal server through itself', async () => {
    const service = makeService();
    const r = await internalCallTool(service, 'call_mcp_tool', {
      server: INTERNAL_SERVER_NAME,
      tool: 'anything',
    });
    expect(r.isError).toBe(true);
    expect(service.callTool).not.toHaveBeenCalled();
  });

  it('passes the downstream CallToolResult through on success', async () => {
    const service = makeService();
    service.callTool.mockResolvedValue({
      success: true,
      data: { content: [{ type: 'text', text: 'downstream' }] },
    });
    const r = await internalCallTool(service, 'call_mcp_tool', { server: 's', tool: 't', args: { x: 1 } });
    expect(service.callTool).toHaveBeenCalledWith('s', 't', { x: 1 }, undefined);
    expect(text(r)).toBe('downstream');
  });

  it('maps a tool failure to an isError result', async () => {
    const service = makeService();
    service.callTool.mockResolvedValue({ success: false, error: 'kaboom' });
    const r = await internalCallTool(service, 'call_mcp_tool', { server: 's', tool: 't' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('kaboom');
  });
});

describe('set_mcp_server_enabled', () => {
  it('maps enabled=false to disabled=true', async () => {
    const service = makeService();
    service.updateServerConfig.mockResolvedValue({ name: 'a' });
    const r = await internalCallTool(service, 'set_mcp_server_enabled', { server: 'a', enabled: false });
    expect(service.updateServerConfig).toHaveBeenCalledWith('a', { disabled: true });
    expect(r.isError).toBeUndefined();
  });

  it('refuses to disable the internal server', async () => {
    const service = makeService();
    const r = await internalCallTool(service, 'set_mcp_server_enabled', {
      server: INTERNAL_SERVER_NAME,
      enabled: false,
    });
    expect(r.isError).toBe(true);
    expect(service.updateServerConfig).not.toHaveBeenCalled();
  });
});

describe('list_models', () => {
  it('whitelists metadata and never leaks the ApiKey', async () => {
    models.loadModels.mockResolvedValue([
      { id: 'm1', name: 'gpt', displayName: 'GPT', ApiKey: 'encrypted-secret', baseUrl: 'https://x' },
    ]);
    const r = await internalCallTool(makeService(), 'list_models', {});
    const out = text(r);
    expect(out).toContain('"m1"');
    expect(out).toContain('"GPT"');
    expect(out).not.toContain('encrypted-secret');
    expect(out).not.toContain('ApiKey');
  });
});

describe('planned executions', () => {
  it('reduces triggers to their type (webhook tokens never leak)', async () => {
    scheduler.list.mockResolvedValue([
      {
        execution: {
          id: 'pe1',
          name: 'Nightly',
          enabled: true,
          flowId: 'f1',
          prompt: 'go',
          trigger: { type: 'webhook', token: 'hook-secret' },
        },
        status: { armed: true },
        lastRun: { status: 'completed', firedAt: '2026-07-11T00:00:00Z' },
      },
    ]);
    const r = await internalCallTool(makeService(), 'list_planned_executions', {});
    const out = text(r);
    expect(out).toContain('"webhook"');
    expect(out).toContain('"Nightly"');
    expect(out).not.toContain('hook-secret');
  });

  it('run_planned_execution returns the run record', async () => {
    scheduler.runNow.mockResolvedValue({
      record: { runId: 'r1', status: 'completed', firedAt: 't', outputText: 'out' },
    });
    const r = await internalCallTool(makeService(), 'run_planned_execution', { id: 'pe1' });
    expect(scheduler.runNow).toHaveBeenCalledWith('pe1');
    expect(text(r)).toContain('"out"');
  });
});

describe('list_conversations', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-conv-test-'));
    const convDir = path.join(dataDir, 'db', 'conversations');
    await fsp.mkdir(convDir, { recursive: true });
    await fsp.writeFile(
      path.join(convDir, 'c1.json'),
      JSON.stringify({
        conversationId: 'c1',
        title: 'Older',
        flowId: 'f1',
        status: 'completed',
        createdAt: 1,
        updatedAt: 100,
        messages: [{ id: 'm1', role: 'user', content: 'transcript-body-must-not-leak', timestamp: 1 }],
      })
    );
    await fsp.writeFile(
      path.join(convDir, 'c2.json'),
      JSON.stringify({ conversationId: 'c2', title: 'Newer', flowId: 'f2', status: 'running', createdAt: 2, updatedAt: 200 })
    );
    (global as { __flujo_test_data_dir?: string }).__flujo_test_data_dir = dataDir;
  });

  afterAll(async () => {
    delete (global as { __flujo_test_data_dir?: string }).__flujo_test_data_dir;
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('returns summaries newest-first without message bodies, reporting dead running states as error', async () => {
    const r = await internalCallTool(makeService(), 'list_conversations', {});
    expect(r.isError).toBeUndefined();
    const list = JSON.parse(text(r)) as Array<Record<string, unknown>>;
    expect(list.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(list[1]).toMatchObject({ title: 'Older', flowId: 'f1', status: 'completed' });
    // c2 is stored as 'running' but no live event channel exists (currentSeq 0)
    expect(list[0].status).toBe('error');
    expect(text(r)).not.toContain('transcript-body-must-not-leak');
  });

  it('honors the limit (newest first)', async () => {
    const r = await internalCallTool(makeService(), 'list_conversations', { limit: 1 });
    const list = JSON.parse(text(r)) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('c2');
  });
});

describe('read_conversation', () => {
  beforeEach(() => {
    readConversationLogMock.mockResolvedValue(undefined);
    projectMessagesMock.mockReturnValue([]);
  });

  it('errors for an unknown conversation', async () => {
    loadConversationStateMock.mockResolvedValue(undefined);
    const r = await internalCallTool(makeService(), 'read_conversation', { conversation: 'nope' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nope');
  });

  it('falls back to snapshot messages and excludes system-role messages', async () => {
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'c1',
      title: 'T',
      flowId: 'f1',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 's', role: 'system', content: 'node-system-prompt', timestamp: 1 },
        { id: 'u', role: 'user', content: 'hello', timestamp: 2 },
        { id: 'a', role: 'assistant', content: 'hi there', timestamp: 3 },
      ],
    });
    const r = await internalCallTool(makeService(), 'read_conversation', { conversation: 'c1' });
    expect(r.isError).toBeUndefined();
    const out = text(r);
    expect(out).toContain('hello');
    expect(out).toContain('hi there');
    expect(out).not.toContain('node-system-prompt');
    expect(JSON.parse(out).totalMessages).toBe(2);
  });

  it('prefers the conversation-log projection and summarizes tool calls', async () => {
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'c1',
      title: 'T',
      flowId: 'f1',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: 'legacy', role: 'user', content: 'legacy-snapshot-message', timestamp: 1 }],
    });
    readConversationLogMock.mockResolvedValue([{ type: 'message' }]);
    projectMessagesMock.mockReturnValue([
      {
        id: 'a',
        role: 'assistant',
        content: null,
        timestamp: 3,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'do_thing', arguments: '{"x":1}' } },
        ],
      },
      { id: 't', role: 'tool', tool_call_id: 'tc1', content: 'tool-result', timestamp: 4 },
    ]);
    const r = await internalCallTool(makeService(), 'read_conversation', { conversation: 'c1' });
    const out = JSON.parse(text(r));
    expect(text(r)).not.toContain('legacy-snapshot-message');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].toolCalls).toEqual([{ id: 'tc1', name: 'do_thing', arguments: '{"x":1}' }]);
    expect(out.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'tc1', content: 'tool-result' });
  });

  it('returns only the most recent messages when limit is set, with a note', async () => {
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'c1',
      title: 'T',
      flowId: 'f1',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: '1', role: 'user', content: 'one', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'two', timestamp: 2 },
        { id: '3', role: 'user', content: 'three', timestamp: 3 },
      ],
    });
    const r = await internalCallTool(makeService(), 'read_conversation', { conversation: 'c1', limit: 2 });
    const out = JSON.parse(text(r));
    expect(out.totalMessages).toBe(3);
    expect(out.messages.map((m: { content: string }) => m.content)).toEqual(['two', 'three']);
    expect(out.note).toContain('most recent');
  });
});

describe('unknown tools and thrown errors', () => {
  it('returns an isError result for an unknown tool', async () => {
    const r = await internalCallTool(makeService(), 'not_a_tool', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not_a_tool');
  });

  it('maps a thrown service error to an isError result instead of rejecting', async () => {
    models.loadModels.mockRejectedValue(new Error('storage exploded'));
    const r = await internalCallTool(makeService(), 'list_models', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('storage exploded');
  });
});

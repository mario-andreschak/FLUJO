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

const flows = flowService as unknown as { loadFlows: jest.Mock; deleteFlow: jest.Mock };
const models = modelService as unknown as { loadModels: jest.Mock };
const scheduler = (jest.requireMock('@/backend/services/scheduler') as { __mocks: { list: jest.Mock; runNow: jest.Mock } }).__mocks;
const runFlowMock = runFlow as jest.Mock;

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
        'delete_flow',
        'list_mcp_servers',
        'list_mcp_server_tools',
        'call_mcp_tool',
        'restart_mcp_server',
        'set_mcp_server_enabled',
        'list_models',
        'list_planned_executions',
        'run_planned_execution',
      ])
    );
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

import type { ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun } from './fixtureAdapter';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn(),
}) }));
jest.mock('@/backend/services/mcp/betaClient', () => ({ isBetaClient: () => false }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn(async () => [{
  name: 'protected-fixture', transport: 'streamable', serverUrl: 'https://adapter-bundle.example.test/mcp', disabled: false,
}]) }));

type ExtensionModule = typeof import('@/backend/execution/extensions');
const processState = globalThis as typeof globalThis & { __flujoExecutionExtensions?: unknown };

function bundle(adapter: ExecutionExtensionAdapter): ExtensionModule {
  let extensionModule!: ExtensionModule;
  jest.isolateModules(() => {
    jest.doMock('@/backend/execution/extensions/configuredAdapter', () => ({ configuredExecutionAdapter: adapter }));
    extensionModule = require('@/backend/execution/extensions') as ExtensionModule;
  });
  return extensionModule;
}

describe('trusted configured adapter across server module graphs', () => {
  let previous: unknown;
  beforeEach(() => { previous = processState.__flujoExecutionExtensions; delete processState.__flujoExecutionExtensions; });
  afterEach(() => {
    processState.__flujoExecutionExtensions = previous;
    jest.dontMock('@/backend/execution/extensions/configuredAdapter');
  });

  test('route and shared MCP module graphs use one configured adapter for opaque contexts', async () => {
    const first = fixtureAdapter();
    const route = bundle(first);
    expect(route.executionExtensionAdapter()).toBe(first);
    const context = route.createExecutionExtensionContext(first, fixtureRun());
    const second = fixtureAdapter();
    const mcp = bundle(second);
    await expect(mcp.assertExecutionExtensionCurrent(context)).resolves.toBeUndefined();
    expect(mcp.executionExtensionAdapter()).toBe(first);
    const legacyContext = mcp.createExecutionExtensionContext(second, fixtureRun());
    await expect(route.assertExecutionExtensionCurrent(legacyContext)).resolves.toBeUndefined();
  });

  test('configured bundle copies cannot mint authority through an unrelated adapter replacement', async () => {
    const first = fixtureAdapter();
    const route = bundle(first);
    const context = route.createExecutionExtensionContext(first, fixtureRun());
    const second = fixtureAdapter();
    const mcp = bundle(second);
    const replacement = fixtureAdapter();
    const restore = mcp.registerExecutionExtension(replacement);
    try {
      await expect(route.assertExecutionExtensionCurrent(context)).rejects.toMatchObject({ code: 'trusted_execution_context_required' });
      const stale = mcp.createExecutionExtensionContext(second, fixtureRun());
      await expect(mcp.assertExecutionExtensionCurrent(stale)).rejects.toMatchObject({ code: 'trusted_execution_context_required' });
      const current = mcp.createExecutionExtensionContext(replacement, fixtureRun());
      await expect(route.assertExecutionExtensionCurrent(current)).resolves.toBeUndefined();
    } finally { restore(); }
    await expect(mcp.assertExecutionExtensionCurrent(context)).resolves.toBeUndefined();
  });

  test('trusted errors keep their identity across server module graphs without trusting serialized lookalikes', () => {
    const route = bundle(fixtureAdapter());
    const mcp = bundle(fixtureAdapter());
    const error = new route.ExecutionExtensionError('fixture_result_rejected', 502);
    expect(error).toBeInstanceOf(mcp.ExecutionExtensionError);
    expect({ name: error.name, code: error.code, status: error.status }).not.toBeInstanceOf(mcp.ExecutionExtensionError);
    expect(Object.assign(new Error(error.code), { code: error.code, status: error.status }))
      .not.toBeInstanceOf(mcp.ExecutionExtensionError);
    expect(Object.create(mcp.ExecutionExtensionError.prototype)).not.toBeInstanceOf(mcp.ExecutionExtensionError);
  });

  test('MCP dispatch preserves a trusted adapter rejection from another graph and sanitizes ordinary SDK errors', async () => {
    const first = fixtureAdapter({ validateResult: () => { throw rejection; } });
    const route = bundle(first);
    const context = route.createExecutionExtensionContext(first, fixtureRun());
    const rejection = new route.ExecutionExtensionError('fixture_result_rejected', 502);
    let dispatch!: typeof import('@/backend/services/mcp/tools').callTool;
    jest.isolateModules(() => {
      jest.doMock('@/backend/execution/extensions/configuredAdapter', () => ({ configuredExecutionAdapter: fixtureAdapter() }));
      dispatch = require('@/backend/services/mcp/tools').callTool;
    });
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    const client = { callTool } as unknown as Client;
    const invoke = () => dispatch(client, 'protected-fixture', 'read', {}, undefined, undefined, undefined,
      'host', undefined, undefined, context);
    await expect(invoke()).resolves.toMatchObject({ success: false, error: 'fixture_result_rejected', statusCode: 502 });
    callTool.mockRejectedValue(new Error('SDK failure contains private request metadata'));
    await expect(invoke()).resolves.toMatchObject({ success: false, error: 'execution_tool_unavailable', statusCode: 503 });
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

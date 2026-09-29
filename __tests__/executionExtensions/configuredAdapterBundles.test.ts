import type { ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun } from './fixtureAdapter';

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
});

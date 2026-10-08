const events: string[] = [];
let releaseLayout!: () => void;
let layoutGate = new Promise<void>(resolve => { releaseLayout = resolve; });
const mockStartSandboxServer = jest.fn(() => { events.push('sandbox'); });
const mockEnsureAllWorkspacesInitialized = jest.fn(async () => { events.push('backend'); });
const mockEnsureWorkspaceLayoutReady = jest.fn(async () => {
  events.push('layout:start');
  await layoutGate;
  events.push('layout:ready');
});

jest.mock('@/backend/services/workspace/migration', () => ({
  ensureWorkspaceLayoutReady: () => mockEnsureWorkspaceLayoutReady(),
}));
jest.mock('@/backend/mcpApps/sandboxServer', () => ({
  startSandboxServer: () => mockStartSandboxServer(),
}));
jest.mock('@/backend/init', () => ({
  ensureAllWorkspacesInitialized: () => mockEnsureAllWorkspacesInitialized(),
}));

import { initializeNodeRuntime } from '@/instrumentation-node';

describe('Node instrumentation workspace barrier', () => {
  beforeEach(() => {
    events.length = 0;
    jest.clearAllMocks();
    layoutGate = new Promise<void>(resolve => { releaseLayout = resolve; });
  });

  it('does not evaluate/start sandbox or backend services before layout readiness', async () => {
    await initializeNodeRuntime();
    await Promise.resolve();

    expect(events).toEqual(['layout:start']);
    expect(mockStartSandboxServer).not.toHaveBeenCalled();
    expect(mockEnsureAllWorkspacesInitialized).not.toHaveBeenCalled();

    releaseLayout();
    for (let attempt = 0; attempt < 10 && !mockEnsureAllWorkspacesInitialized.mock.calls.length; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }

    expect(events).toEqual(['layout:start', 'layout:ready', 'sandbox', 'backend']);
  });
});

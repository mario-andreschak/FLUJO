/**
 * Tests for Stage 3 (#78) of the #16 custom-encryption fix: backend startup
 * gating + the onUnlocked() transition.
 *
 * While USER encryption is locked, boot must verify storage but DEFER the
 * secret-dependent services (the MCP sweep + arming the scheduler). Those run
 * only at unlock, via onUnlocked(), which is idempotent and a no-op in DEFAULT
 * mode (where boot already started everything). MCP must always start before
 * the scheduler arms.
 *
 * Every collaborator is mocked at its module boundary so this exercises the
 * init orchestration in isolation; the encryption helpers are flippable.
 */

// Plain jest.fn()s (untyped, so the `(...a)` delegators below type-check).
// Async return values are configured in beforeEach; a bare undefined return is
// harmless for the void-returning collaborators (they are awaited).
const verifyStorageMock = jest.fn();
const migrateWorkspaceLayoutMock = jest.fn();
const migrateEnduringAgentDirectoryShardsMock = jest.fn();
const migrateInternalMcpServersMock = jest.fn();
const startEnabledServersMock = jest.fn();
const refreshSpotlightMock = jest.fn();
const schedulerStartMock = jest.fn();
const isEncryptionLockedMock = jest.fn();
const isUserEncryptionEnabledMock = jest.fn();
const ensureDefaultFlujoAgentMock = jest.fn();
const listPersonasMock = jest.fn();
const reconcilePersonaRoleBehaviorsMock = jest.fn();
const inspectPersonaRuntimeMock = jest.fn();
const startPersonaFlowDispatcherMock = jest.fn();
const startPersonaGoalRuntimeMock = jest.fn();
const reconcilePersonaSchedulerProjectionsMock = jest.fn();
const restoreWorkerSnapshotMock = jest.fn();
const unlockWorkerSnapshotMock = jest.fn();
const verifyWorkerCodexAuthMock = jest.fn();
const reinstallWorkspaceMcpServersMock = jest.fn();
const loadServerConfigsMock = jest.fn();
const getServerStatusMock = jest.fn();
const reconcileOrphanedTasksMock = jest.fn();
const resumeRemoteMcpTasksMock = jest.fn();

jest.mock('@/backend/services/workspace/snapshotRestore', () => ({
  restoreConfiguredWorkerSnapshot: (...a: unknown[]) => restoreWorkerSnapshotMock(...a),
  unlockWorkerSnapshot: (...a: unknown[]) => unlockWorkerSnapshotMock(...a),
  verifyWorkerCodexAuth: (...a: unknown[]) => verifyWorkerCodexAuthMock(...a),
}));
jest.mock('@/backend/services/packages/workspaceMcpTransfer', () => ({
  reinstallWorkspaceMcpServers: (...a: unknown[]) => reinstallWorkspaceMcpServersMock(...a),
}));
jest.mock('@/backend/services/subflowTasks', () => ({
  reconcileOrphanedTasks: (...a: unknown[]) => reconcileOrphanedTasksMock(...a),
}));
jest.mock('@/backend/services/mcp/remoteTaskResume', () => ({
  resumeRemoteMcpTasks: (...a: unknown[]) => resumeRemoteMcpTasksMock(...a),
}));

jest.mock('@/utils/storage/backend', () => ({
  verifyStorage: (...a: unknown[]) => verifyStorageMock(...a),
}));
jest.mock('@/backend/services/workspace/migration', () => ({
  migrateWorkspaceLayout: (...a: unknown[]) => migrateWorkspaceLayoutMock(...a),
}));
jest.mock('@/backend/services/enduringAgents/directoryShardingMigration', () => ({
  migrateEnduringAgentDirectoryShards: (...a: unknown[]) =>
    migrateEnduringAgentDirectoryShardsMock(...a),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    startEnabledServers: (...a: unknown[]) => startEnabledServersMock(...a),
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
  },
}));
jest.mock('@/backend/services/mcp/shippedServerMigration', () => ({
  migrateShippedMcpServers: (...a: unknown[]) => migrateInternalMcpServersMock(...a),
}));
jest.mock('@/backend/services/spotlight', () => ({
  refreshSpotlightServers: (...a: unknown[]) => refreshSpotlightMock(...a),
}));
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    start: (...a: unknown[]) => schedulerStartMock(...a),
    reconcilePersonaSchedulerProjections: (...a: unknown[]) =>
      reconcilePersonaSchedulerProjectionsMock(...a),
  }),
}));
jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: (...a: unknown[]) => isEncryptionLockedMock(...a),
  isUserEncryptionEnabled: (...a: unknown[]) => isUserEncryptionEnabledMock(...a),
}));
jest.mock('@/backend/services/flow/defaultAgent', () => ({
  ensureDefaultFlujoAgent: (...a: unknown[]) => ensureDefaultFlujoAgentMock(...a),
}));
jest.mock('@/backend/services/enduringAgents', () => ({
  listPersonas: (...a: unknown[]) => listPersonasMock(...a),
  reconcilePersonaRoleBehaviors: (...a: unknown[]) => reconcilePersonaRoleBehaviorsMock(...a),
  inspectAndReconcilePersonaRuntime: (...a: unknown[]) => inspectPersonaRuntimeMock(...a),
  startPersonaFlowDispatcher: (...a: unknown[]) => startPersonaFlowDispatcherMock(...a),
  startPersonaGoalRuntime: (...a: unknown[]) => startPersonaGoalRuntimeMock(...a),
  stopPersonaGoalRuntime: jest.fn(),
}));

import {
  ensureAllWorkspacesInitialized,
  ensureBackendInitialized,
  onUnlocked,
} from '@/backend/init';
import { ensureWorkspaceDirs } from '@/utils/workspace';
import { getWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

function clearGlobals(): void {
  (global as any).__flujo_init_promise = undefined;
  (global as any).__flujo_secret_services_promise = undefined;
  (global as any).__flujo_workspace_init_promises = undefined;
  (global as any).__flujo_workspace_secret_promises = undefined;
}

describe('backend init startup gating (#78)', () => {
  const originalWorkerMode = process.env.FLUJO_WORKER_MODE;
  beforeEach(() => {
    jest.clearAllMocks();
    clearGlobals();
    verifyStorageMock.mockResolvedValue(undefined);
    migrateWorkspaceLayoutMock.mockResolvedValue(undefined);
    migrateEnduringAgentDirectoryShardsMock.mockResolvedValue(undefined);
    ensureDefaultFlujoAgentMock.mockResolvedValue(undefined);
    listPersonasMock.mockResolvedValue([{ id: 'persona_startup' }]);
    reconcilePersonaRoleBehaviorsMock.mockResolvedValue(undefined);
    inspectPersonaRuntimeMock.mockResolvedValue(undefined);
    startPersonaFlowDispatcherMock.mockResolvedValue(undefined);
    startPersonaGoalRuntimeMock.mockResolvedValue(undefined);
    reconcilePersonaSchedulerProjectionsMock.mockResolvedValue(undefined);
    migrateInternalMcpServersMock.mockResolvedValue(undefined);
    startEnabledServersMock.mockResolvedValue(undefined);
    refreshSpotlightMock.mockResolvedValue(undefined);
    schedulerStartMock.mockResolvedValue(undefined);
    isEncryptionLockedMock.mockResolvedValue(false);
    isUserEncryptionEnabledMock.mockResolvedValue(false);
    delete process.env.FLUJO_WORKER_MODE;
    global.__flujo_worker_bootstrap_status = undefined;
    restoreWorkerSnapshotMock.mockResolvedValue({ workspace: 'default-workspace', codexAuth: 'none', encryption: 'default',
      mcpTransfer: { formatVersion: 1, sourceWorkspaceRoot: '/source', servers: [] } });
    unlockWorkerSnapshotMock.mockResolvedValue(undefined);
    verifyWorkerCodexAuthMock.mockResolvedValue(undefined);
    reinstallWorkspaceMcpServersMock.mockResolvedValue({ ok: true, servers: [{ name: 'server-one', status: 'ready' }] });
    loadServerConfigsMock.mockResolvedValue([{ name: 'server-one' }]);
    getServerStatusMock.mockResolvedValue({ status: 'connected' });
    reconcileOrphanedTasksMock.mockResolvedValue(undefined);
    resumeRemoteMcpTasksMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalWorkerMode === undefined) delete process.env.FLUJO_WORKER_MODE;
    else process.env.FLUJO_WORKER_MODE = originalWorkerMode;
    global.__flujo_worker_bootstrap_status = undefined;
  });

  it('DEFAULT mode: verifies storage, then starts MCP servers, then arms the scheduler at boot', async () => {
    await ensureBackendInitialized();

    expect(migrateWorkspaceLayoutMock).toHaveBeenCalledTimes(1);
    expect(verifyStorageMock).toHaveBeenCalledTimes(1);
    expect(migrateWorkspaceLayoutMock.mock.invocationCallOrder[0]).toBeLessThan(
      verifyStorageMock.mock.invocationCallOrder[0]
    );
    expect(ensureDefaultFlujoAgentMock).toHaveBeenCalledTimes(1);
    expect(migrateInternalMcpServersMock).toHaveBeenCalledTimes(1);
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
    expect(startPersonaGoalRuntimeMock).toHaveBeenCalledTimes(1);
    // Ordering: migration completes before the MCP sweep, which completes before
    // the scheduler arms.
    expect(migrateInternalMcpServersMock.mock.invocationCallOrder[0]).toBeLessThan(
      startEnabledServersMock.mock.invocationCallOrder[0]
    );
    expect(startEnabledServersMock.mock.invocationCallOrder[0]).toBeLessThan(
      schedulerStartMock.mock.invocationCallOrder[0]
    );
  });

  it('does not run downstream startup when workspace migration fails, then retries cleanly', async () => {
    migrateWorkspaceLayoutMock
      .mockRejectedValueOnce(new Error('workspace migration failed'))
      .mockResolvedValueOnce(undefined);

    await expect(ensureBackendInitialized()).rejects.toThrow('workspace migration failed');

    expect(verifyStorageMock).not.toHaveBeenCalled();
    expect(ensureDefaultFlujoAgentMock).not.toHaveBeenCalled();
    expect(migrateInternalMcpServersMock).not.toHaveBeenCalled();
    expect(startEnabledServersMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();

    await ensureBackendInitialized();

    expect(migrateWorkspaceLayoutMock).toHaveBeenCalledTimes(2);
    expect(verifyStorageMock).toHaveBeenCalledTimes(1);
  });

  it('does not start the sweep until a failed migration succeeds on retry', async () => {
    migrateInternalMcpServersMock
      .mockRejectedValueOnce(new Error('migration failed'))
      .mockResolvedValueOnce(undefined);

    await expect(ensureBackendInitialized()).rejects.toThrow('migration failed');
    expect(startEnabledServersMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();

    await ensureBackendInitialized();
    expect(migrateInternalMcpServersMock).toHaveBeenCalledTimes(2);
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
  });

  it('locked USER mode: verifies storage but defers MCP/scheduler startup', async () => {
    isEncryptionLockedMock.mockResolvedValue(true);

    await ensureBackendInitialized();

    expect(verifyStorageMock).toHaveBeenCalledTimes(1);
    expect(migrateInternalMcpServersMock).not.toHaveBeenCalled();
    expect(startEnabledServersMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();
    expect(startPersonaGoalRuntimeMock).not.toHaveBeenCalled();
  });

  it('onUnlocked starts services once and re-kicks durable Persona work on later unlocks', async () => {
    isEncryptionLockedMock.mockResolvedValue(true);
    isUserEncryptionEnabledMock.mockResolvedValue(true);

    await ensureBackendInitialized();
    expect(startEnabledServersMock).not.toHaveBeenCalled();

    await onUnlocked();
    expect(migrateInternalMcpServersMock).toHaveBeenCalledTimes(1);
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
    // MCP before scheduler here too.
    expect(startEnabledServersMock.mock.invocationCallOrder[0]).toBeLessThan(
      inspectPersonaRuntimeMock.mock.invocationCallOrder[0]
    );
    expect(inspectPersonaRuntimeMock.mock.invocationCallOrder[0]).toBeLessThan(
      startPersonaFlowDispatcherMock.mock.invocationCallOrder[0]
    );
    expect(startPersonaFlowDispatcherMock.mock.invocationCallOrder[0]).toBeLessThan(
      startPersonaGoalRuntimeMock.mock.invocationCallOrder[0]
    );
    expect(startPersonaGoalRuntimeMock.mock.invocationCallOrder[0]).toBeLessThan(
      schedulerStartMock.mock.invocationCallOrder[0]
    );

    // MCP/scheduler startup stays once-only, while the idempotent dispatcher +
    // scheduler projection kick runs again to resume work admitted while locked.
    await onUnlocked();
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
    expect(startPersonaFlowDispatcherMock).toHaveBeenCalledTimes(2);
    expect(startPersonaGoalRuntimeMock).toHaveBeenCalledTimes(2);
    expect(reconcilePersonaSchedulerProjectionsMock).toHaveBeenCalledWith(false);
  });

  it('onUnlocked in DEFAULT mode is a no-op (boot already started everything)', async () => {
    // isUserEncryptionEnabled=false → DEFAULT mode.
    await onUnlocked();

    expect(startEnabledServersMock).not.toHaveBeenCalled();
    expect(startPersonaFlowDispatcherMock).not.toHaveBeenCalled();
    expect(startPersonaGoalRuntimeMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();
  });

  it('a later ensureBackendInitialized after unlock does not re-start the services', async () => {
    isEncryptionLockedMock.mockResolvedValue(true);
    isUserEncryptionEnabledMock.mockResolvedValue(true);

    await ensureBackendInitialized(); // deferred (locked)
    await onUnlocked(); // starts once
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);

    // e.g. the /api/init route calling in later — must not double-start.
    await ensureBackendInitialized();
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(startPersonaFlowDispatcherMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
  });

  it('initializes every discovered workspace so inactive automations are armed', async () => {
    await ensureWorkspaceDirs('research');

    await ensureAllWorkspacesInitialized();

    expect(verifyStorageMock).toHaveBeenCalledTimes(2);
    expect(startEnabledServersMock).toHaveBeenCalledTimes(2);
    expect(startPersonaFlowDispatcherMock).toHaveBeenCalledTimes(2);
    expect(schedulerStartMock).toHaveBeenCalledTimes(2);
  });

  it('worker boot unlocks and prepares MCP dependencies without replaying copied background work', async () => {
    process.env.FLUJO_WORKER_MODE = '1';
    await ensureBackendInitialized();
    expect(unlockWorkerSnapshotMock).toHaveBeenCalledTimes(1);
    expect(reinstallWorkspaceMcpServersMock).toHaveBeenCalledTimes(1);
    expect(reinstallWorkspaceMcpServersMock.mock.invocationCallOrder[0]).toBeLessThan(startEnabledServersMock.mock.invocationCallOrder[0]);
    expect(reconcileOrphanedTasksMock).not.toHaveBeenCalled();
    expect(resumeRemoteMcpTasksMock).not.toHaveBeenCalled();
    expect(reconcilePersonaRoleBehaviorsMock).not.toHaveBeenCalled();
    expect(startPersonaFlowDispatcherMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();
    expect(migrateEnduringAgentDirectoryShardsMock).not.toHaveBeenCalled();
    expect(migrateInternalMcpServersMock).not.toHaveBeenCalled();
    expect(getWorkerBootstrapStatus().state).toBe('ready');
    isUserEncryptionEnabledMock.mockResolvedValue(true);
    await onUnlocked();
    expect(startPersonaFlowDispatcherMock).not.toHaveBeenCalled();
    expect(reconcilePersonaSchedulerProjectionsMock).not.toHaveBeenCalled();
  });

  it('worker startup failure stays unready and can be retried', async () => {
    process.env.FLUJO_WORKER_MODE = '1';
    reinstallWorkspaceMcpServersMock.mockResolvedValueOnce({ ok: false, servers: [{ name: 'broken', status: 'failed' }] });
    await expect(ensureBackendInitialized()).rejects.toThrow('MCP dependency');
    expect(getWorkerBootstrapStatus().state).toBe('error');
    expect(startEnabledServersMock).not.toHaveBeenCalled();
    await ensureBackendInitialized();
    expect(getWorkerBootstrapStatus().state).toBe('ready');
    expect(schedulerStartMock).not.toHaveBeenCalled();
  });

  it('worker readiness rejects a server whose startup silently failed', async () => {
    process.env.FLUJO_WORKER_MODE = '1';
    getServerStatusMock.mockResolvedValue({ status: 'error', message: 'credential-bearing diagnostic' });
    await expect(ensureBackendInitialized()).rejects.toThrow('MCP startup failed');
    expect(getWorkerBootstrapStatus().state).toBe('error');
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain('credential-bearing diagnostic');
  });
});

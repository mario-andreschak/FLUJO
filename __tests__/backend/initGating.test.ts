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
const startEnabledServersMock = jest.fn();
const refreshSpotlightMock = jest.fn();
const schedulerStartMock = jest.fn();
const isEncryptionLockedMock = jest.fn();
const isUserEncryptionEnabledMock = jest.fn();

jest.mock('@/utils/storage/backend', () => ({
  verifyStorage: (...a: unknown[]) => verifyStorageMock(...a),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { startEnabledServers: (...a: unknown[]) => startEnabledServersMock(...a) },
}));
jest.mock('@/backend/services/spotlight', () => ({
  refreshSpotlightServers: (...a: unknown[]) => refreshSpotlightMock(...a),
}));
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({ start: (...a: unknown[]) => schedulerStartMock(...a) }),
}));
jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: (...a: unknown[]) => isEncryptionLockedMock(...a),
  isUserEncryptionEnabled: (...a: unknown[]) => isUserEncryptionEnabledMock(...a),
}));

import { ensureBackendInitialized, onUnlocked } from '@/backend/init';

function clearGlobals(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_init_promise = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_secret_services_promise = undefined;
}

describe('backend init startup gating (#78)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearGlobals();
    verifyStorageMock.mockResolvedValue(undefined);
    startEnabledServersMock.mockResolvedValue(undefined);
    refreshSpotlightMock.mockResolvedValue(undefined);
    schedulerStartMock.mockResolvedValue(undefined);
    isEncryptionLockedMock.mockResolvedValue(false);
    isUserEncryptionEnabledMock.mockResolvedValue(false);
  });

  it('DEFAULT mode: verifies storage, then starts MCP servers, then arms the scheduler at boot', async () => {
    await ensureBackendInitialized();

    expect(verifyStorageMock).toHaveBeenCalledTimes(1);
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
    // Ordering: the MCP sweep must complete before the scheduler arms.
    expect(startEnabledServersMock.mock.invocationCallOrder[0]).toBeLessThan(
      schedulerStartMock.mock.invocationCallOrder[0]
    );
  });

  it('locked USER mode: verifies storage but defers MCP/scheduler startup', async () => {
    isEncryptionLockedMock.mockResolvedValue(true);

    await ensureBackendInitialized();

    expect(verifyStorageMock).toHaveBeenCalledTimes(1);
    expect(startEnabledServersMock).not.toHaveBeenCalled();
    expect(schedulerStartMock).not.toHaveBeenCalled();
  });

  it('onUnlocked (USER mode) starts both exactly once; a second call is a no-op', async () => {
    isEncryptionLockedMock.mockResolvedValue(true);
    isUserEncryptionEnabledMock.mockResolvedValue(true);

    await ensureBackendInitialized();
    expect(startEnabledServersMock).not.toHaveBeenCalled();

    await onUnlocked();
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
    // MCP before scheduler here too.
    expect(startEnabledServersMock.mock.invocationCallOrder[0]).toBeLessThan(
      schedulerStartMock.mock.invocationCallOrder[0]
    );

    // Idempotent: repeated unlocks must not double-start.
    await onUnlocked();
    expect(startEnabledServersMock).toHaveBeenCalledTimes(1);
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
  });

  it('onUnlocked in DEFAULT mode is a no-op (boot already started everything)', async () => {
    // isUserEncryptionEnabled=false → DEFAULT mode.
    await onUnlocked();

    expect(startEnabledServersMock).not.toHaveBeenCalled();
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
    expect(schedulerStartMock).toHaveBeenCalledTimes(1);
  });
});

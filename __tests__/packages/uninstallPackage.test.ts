/**
 * Orchestrator tests for the package UNINSTALL pipeline (issue #211).
 *
 * All IO boundaries are mocked at the module edge (delete primitives + storage)
 * so the reversal logic — created-only deletion, adopted-entity preservation,
 * fail-soft on missing entities, idempotent double-uninstall, dependency
 * ordering, and the conservative legacy-ledger fallback — runs for real without
 * touching disk.
 */

const deleteFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { deleteFlow: (...a: unknown[]) => deleteFlowMock(...a) },
}));

const deleteModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: { deleteModel: (...a: unknown[]) => deleteModelMock(...a) },
}));

const deleteServerConfigMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { deleteServerConfig: (...a: unknown[]) => deleteServerConfigMock(...a) },
}));

const schedulerDeleteMock = jest.fn();
const schedulerGetMock = jest.fn();
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    delete: (...a: unknown[]) => schedulerDeleteMock(...a),
    get: (...a: unknown[]) => schedulerGetMock(...a),
  }),
}));

// In-memory storage for the install ledger.
const store = new Map<string, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback)),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));

import {
  inspectPackageUninstall,
  uninstallPackage,
} from '@/backend/services/packages/installPackage';

const LEDGER_KEY = 'package_installs';

/** A ledger record with full created-provenance (post-#211 install). */
const recordWithProvenance = () => ({
  'my-pkg': {
    packageName: 'my-pkg',
    version: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    summary: {},
    entities: {
      flows: { 'local-root': 'pkg-my-pkg-local-root', 'local-child': 'pkg-my-pkg-local-child' },
      models: { 'My GPT': 'model-created', 'Their GPT': 'model-adopted' },
      servers: ['web-search'],
      plannedExecutions: ['pkg-my-pkg-nightly'],
    },
    created: {
      flows: ['pkg-my-pkg-local-root', 'pkg-my-pkg-local-child'],
      models: ['model-created'], // 'model-adopted' was updated in place, NOT created
      servers: ['web-search'],
      plannedExecutions: ['pkg-my-pkg-nightly'],
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  deleteFlowMock.mockResolvedValue({ success: true });
  deleteModelMock.mockResolvedValue({ success: true });
  deleteServerConfigMock.mockResolvedValue({ success: true });
  schedulerDeleteMock.mockResolvedValue({ success: true });
  schedulerGetMock.mockResolvedValue(null);
});

describe('uninstallPackage — happy path', () => {
  it('removes every created entity and deletes the ledger entry', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());

    const summary = await uninstallPackage('my-pkg');

    expect(summary.ok).toBe(true);
    expect(summary.hasErrors).toBe(false);
    expect(summary.errors).toHaveLength(0);

    expect(schedulerDeleteMock).toHaveBeenCalledWith('pkg-my-pkg-nightly');
    expect(deleteFlowMock).toHaveBeenCalledWith('pkg-my-pkg-local-root');
    expect(deleteFlowMock).toHaveBeenCalledWith('pkg-my-pkg-local-child');
    expect(deleteServerConfigMock).toHaveBeenCalledWith('web-search');
    expect(deleteModelMock).toHaveBeenCalledWith('model-created');

    // 2 flows + 1 server + 1 planned + 1 created model = 5 removed.
    expect(summary.removed).toHaveLength(5);

    // Ledger entry is gone.
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeUndefined();
  });
});

describe('uninstallPackage — Persona control-plane boundary', () => {
  it('preflights Persona plans and denies direct service deletion all-or-none', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    schedulerGetMock.mockResolvedValue({
      id: 'pkg-my-pkg-nightly',
      personaId: 'persona_support',
      behaviorSlotKey: 'primary',
    });

    await expect(inspectPackageUninstall('my-pkg')).resolves.toEqual({
      exists: true,
      requiresPersonaControl: true,
    });
    const summary = await uninstallPackage('my-pkg');

    expect(summary).toMatchObject({ ok: false, hasErrors: true });
    expect(summary.errors).toEqual([
      expect.objectContaining({ kind: 'plannedExecution', id: 'protected' }),
    ]);
    expect(schedulerDeleteMock).not.toHaveBeenCalled();
    expect(deleteFlowMock).not.toHaveBeenCalled();
    expect(deleteServerConfigMock).not.toHaveBeenCalled();
    expect(deleteModelMock).not.toHaveBeenCalled();
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeDefined();
  });

  it('allows the same uninstall only after strict-loopback authorization', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    schedulerGetMock.mockResolvedValue({
      id: 'pkg-my-pkg-nightly',
      personaId: 'persona_support',
    });

    const summary = await uninstallPackage('my-pkg', {
      allowPersonaPlannedExecutions: true,
    });

    expect(summary.ok).toBe(true);
    expect(schedulerDeleteMock).toHaveBeenCalledWith('pkg-my-pkg-nightly');
    expect(deleteFlowMock).toHaveBeenCalled();
  });
});

describe('uninstallPackage — adopted entity preserved (CRITICAL)', () => {
  it('never deletes a pre-existing model the package only updated', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());

    const summary = await uninstallPackage('my-pkg');

    expect(deleteModelMock).toHaveBeenCalledWith('model-created');
    expect(deleteModelMock).not.toHaveBeenCalledWith('model-adopted');
    const skippedAdopted = summary.skipped.find((s) => s.id === 'model-adopted');
    expect(skippedAdopted).toMatchObject({ kind: 'model', reason: 'adopted-not-created' });
  });
});

describe('uninstallPackage — fail-soft', () => {
  it('classifies a not-found delete as skipped and keeps going', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    schedulerDeleteMock.mockResolvedValue({ success: false, error: 'No planned execution with id "x"' });
    deleteServerConfigMock.mockResolvedValue({ success: false, error: 'Server web-search not found' });

    const summary = await uninstallPackage('my-pkg');

    expect(summary.hasErrors).toBe(false);
    expect(summary.skipped.some((s) => s.kind === 'plannedExecution' && s.reason === 'not found')).toBe(true);
    expect(summary.skipped.some((s) => s.kind === 'server' && s.reason === 'not found')).toBe(true);
    // Ledger still removed since nothing hard-errored.
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeUndefined();
  });

  it('does not throw when a delete primitive throws', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    deleteFlowMock.mockRejectedValue(new Error('disk exploded'));

    const summary = await uninstallPackage('my-pkg');

    expect(summary.hasErrors).toBe(true);
    expect(summary.errors.some((e) => e.kind === 'flow')).toBe(true);
  });
});

describe('uninstallPackage — hard error retains the ledger', () => {
  it('keeps the record when a delete returns a real error', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    deleteModelMock.mockResolvedValue({ success: false, error: 'storage write failed' });

    const summary = await uninstallPackage('my-pkg');

    expect(summary.ok).toBe(false);
    expect(summary.hasErrors).toBe(true);
    expect(summary.errors.some((e) => e.id === 'model-created')).toBe(true);
    // Ledger retained for retry.
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeDefined();
  });
});

describe('uninstallPackage — idempotency', () => {
  it('a second uninstall is a clean no-op', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    await uninstallPackage('my-pkg');
    jest.clearAllMocks();

    const summary = await uninstallPackage('my-pkg');
    expect(summary.removed).toHaveLength(0);
    expect(summary.skipped).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);
    expect(deleteFlowMock).not.toHaveBeenCalled();
    expect(deleteModelMock).not.toHaveBeenCalled();
  });

  it('an unknown package is a no-op summary, never throws', async () => {
    const summary = await uninstallPackage('nope');
    expect(summary).toMatchObject({ packageName: 'nope', ok: true, removed: [], skipped: [], errors: [] });
  });
});

describe('uninstallPackage — dependency ordering', () => {
  it('deletes planned executions and flows before models', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    const order: string[] = [];
    schedulerDeleteMock.mockImplementation(async () => { order.push('planned'); return { success: true }; });
    deleteFlowMock.mockImplementation(async () => { order.push('flow'); return { success: true }; });
    deleteServerConfigMock.mockImplementation(async () => { order.push('server'); return { success: true }; });
    deleteModelMock.mockImplementation(async () => { order.push('model'); return { success: true }; });

    await uninstallPackage('my-pkg');

    expect(order.indexOf('planned')).toBeLessThan(order.indexOf('flow'));
    expect(order.indexOf('flow')).toBeLessThan(order.indexOf('model'));
    expect(order.lastIndexOf('model')).toBe(order.length - 1);
  });
});

describe('uninstallPackage — legacy ledger without provenance', () => {
  it('removes package-owned flows/planned/servers but conservatively skips models', async () => {
    store.set(LEDGER_KEY, {
      'legacy-pkg': {
        packageName: 'legacy-pkg',
        version: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        summary: {},
        entities: {
          flows: { 'local-root': 'pkg-legacy-pkg-local-root' },
          models: { 'My GPT': 'legacy-model' },
          servers: ['web-search'],
          plannedExecutions: ['pkg-legacy-pkg-nightly'],
        },
        // no `created` field — pre-#211 ledger
      },
    });

    const summary = await uninstallPackage('legacy-pkg');

    expect(deleteFlowMock).toHaveBeenCalledWith('pkg-legacy-pkg-local-root');
    expect(schedulerDeleteMock).toHaveBeenCalledWith('pkg-legacy-pkg-nightly');
    expect(deleteServerConfigMock).toHaveBeenCalledWith('web-search');
    expect(deleteModelMock).not.toHaveBeenCalled();
    expect(summary.skipped.some((s) => s.kind === 'model' && s.reason === 'legacy-ledger-no-provenance')).toBe(true);
  });
});

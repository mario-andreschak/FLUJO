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

// Flows and servers go through the checked deletes (#1389). Each place that
// uses them is set per test; the delete primitives above stay the IO edge.
const flowUses = new Map<string, FlowUse[]>();
const serverUses = new Map<string, McpServerUse[]>();
const flowPlans = new Map<string, unknown>();
const serverPlans = new Map<string, unknown>();
const checkedOutcome = (result: { success: boolean; error?: string }) => (result.success
  ? { status: 'deleted' as const, summary: {} }
  : /not found/i.test(result.error ?? '') ? { status: 'not-found' as const } : { status: 'refused' as const, error: result.error ?? 'failed' });
const inUseNext = { flow: false };
jest.mock('@/backend/services/flow/flowDeletion', () => ({
  findFlowUsage: async (flowId: string) => ({ flowId, flowName: flowId, uses: flowUses.get(flowId) ?? [], copySources: [] }),
  deleteFlowAndMoveUses: async (flowId: string, plan: unknown) => {
    if (inUseNext.flow) {
      inUseNext.flow = false;
      return { status: 'in-use', usage: { flowId, flowName: flowId, uses: flowUses.get(flowId) ?? [], copySources: [] }, changed: true };
    }
    flowPlans.set(flowId, plan);
    return checkedOutcome(await deleteFlowMock(flowId));
  },
}));
jest.mock('@/backend/services/mcp/serverDeletion', () => ({
  findMcpServerUsage: async (serverName: string) => ({ serverName, uses: serverUses.get(serverName) ?? [] }),
  deleteMcpServerAndMoveUses: async (serverName: string, plan: unknown) => {
    serverPlans.set(serverName, plan);
    return checkedOutcome(await deleteServerConfigMock(serverName));
  },
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
import type { FlowUse } from '@/shared/types/flow/flowUsage';
import type { McpServerUse } from '@/shared/types/mcp/serverUsage';

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
  flowUses.clear();
  serverUses.clear();
  flowPlans.clear();
  serverPlans.clear();
  inUseNext.flow = false;
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
      answersTouchPersonaAutomations: false,
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

  it('protects anonymized Persona schedule evidence from untrusted uninstall', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    schedulerGetMock.mockResolvedValue({
      id: 'pkg-my-pkg-nightly',
      personaArchived: true,
      personaRetired: true,
    });

    await expect(inspectPackageUninstall('my-pkg')).resolves.toEqual({
      exists: true,
      requiresPersonaControl: true,
      answersTouchPersonaAutomations: false,
    });
    const summary = await uninstallPackage('my-pkg');

    expect(summary).toMatchObject({ ok: false, hasErrors: true });
    expect(schedulerDeleteMock).not.toHaveBeenCalled();
    expect(deleteFlowMock).not.toHaveBeenCalled();
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

describe('uninstallPackage — ambiguous flow ownership', () => {
  it.each(['another-package', 'another-local-flow'])('retains every entity and ledger when an ID is claimed by %s', async (conflict) => {
    const record = recordWithProvenance();
    const ledger = conflict === 'another-package'
      ? { ...record, other: { entities: { flows: { foreign: 'pkg-my-pkg-local-root' } } } }
      : record;
    if (conflict === 'another-local-flow') {
      record['my-pkg'].entities.flows['local-child'] = record['my-pkg'].entities.flows['local-root'];
    }
    store.set(LEDGER_KEY, ledger);
    const summary = await uninstallPackage('my-pkg');
    expect(summary.ok).toBe(false);
    expect(summary.hasErrors).toBe(true);
    expect(deleteFlowMock).not.toHaveBeenCalled();
    expect(deleteModelMock).not.toHaveBeenCalled();
    expect(deleteServerConfigMock).not.toHaveBeenCalled();
    expect(schedulerDeleteMock).not.toHaveBeenCalled();
    expect(store.get(LEDGER_KEY)).toBe(ledger);
  });
});

describe('uninstallPackage — places outside the package (#1389)', () => {
  const ROOT = 'pkg-my-pkg-local-root';
  const CHILD = 'pkg-my-pkg-local-child';
  const personaCore: FlowUse = {
    key: 'persona:jim:core',
    place: { kind: 'persona-core', personaId: 'jim', personaName: 'Jim' },
    canRemove: true,
    removePauses: true,
  };
  const personaApp: McpServerUse = {
    key: 'persona:jim:app',
    place: { kind: 'persona-app', personaId: 'jim', personaName: 'Jim' },
    canRemove: true,
  };

  it('removes nothing and lists the place while a Persona outside the package uses one of its flows', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    flowUses.set(ROOT, [personaCore]);

    const summary = await uninstallPackage('my-pkg');

    expect(summary).toMatchObject({ ok: false, changed: false, removed: [] });
    expect(summary.usage?.flows).toEqual([expect.objectContaining({ flowId: ROOT, uses: [personaCore] })]);
    expect(summary.usage?.leaving.flowIds).toEqual([ROOT, CHILD]);
    expect(schedulerDeleteMock).not.toHaveBeenCalled();
    expect(deleteFlowMock).not.toHaveBeenCalled();
    expect(deleteServerConfigMock).not.toHaveBeenCalled();
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeDefined();
  });

  it("carries out the person's answers and removes everything once each outside place is answered", async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    flowUses.set(ROOT, [personaCore]);
    serverUses.set('web-search', [personaApp]);

    const summary = await uninstallPackage('my-pkg', {
      plan: {
        flows: { [ROOT]: { choices: { [personaCore.key]: { replaceWith: 'my-own-flow' } } } },
        servers: { 'web-search': { choices: { [personaApp.key]: { remove: true } } } },
      },
    });

    expect(summary).toMatchObject({ ok: true, hasErrors: false });
    expect(flowPlans.get(ROOT)).toEqual({ choices: { [personaCore.key]: { replaceWith: 'my-own-flow' } } });
    expect(serverPlans.get('web-search')).toEqual({ choices: { [personaApp.key]: { remove: true } } });
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeUndefined();
  });

  it('lets places inside the package go without asking', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    const rootCallsChild: FlowUse = {
      key: `flow:${ROOT}`,
      place: { kind: 'subflow', flowId: ROOT, flowName: 'Root' },
      canRemove: true,
      removePauses: false,
    };
    const rootUsesApp: McpServerUse = {
      key: `flow:${ROOT}`,
      place: { kind: 'flow', flowId: ROOT, flowName: 'Root', steps: 1 },
      canRemove: true,
    };
    flowUses.set(CHILD, [rootCallsChild]);
    serverUses.set('web-search', [rootUsesApp]);

    const summary = await uninstallPackage('my-pkg');

    expect(summary).toMatchObject({ ok: true });
    expect(summary.usage).toBeUndefined();
    expect(flowPlans.get(CHILD)).toEqual({ choices: { [rootCallsChild.key]: { remove: true } } });
    expect(serverPlans.get('web-search')).toEqual({ choices: { [rootUsesApp.key]: { remove: true } } });
  });

  it('refuses a replacement that leaves with the package, before removing anything', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    flowUses.set(ROOT, [personaCore]);

    const summary = await uninstallPackage('my-pkg', {
      plan: { flows: { [ROOT]: { choices: { [personaCore.key]: { replaceWith: CHILD } } } }, servers: {} },
    });

    expect(summary.ok).toBe(false);
    expect(summary.refusal).toMatch(/removed with the package too/);
    expect(schedulerDeleteMock).not.toHaveBeenCalled();
    expect(deleteFlowMock).not.toHaveBeenCalled();
  });

  it('asks again when a place appears part-way, keeping the ledger so the next uninstall finishes', async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    inUseNext.flow = true;

    const first = await uninstallPackage('my-pkg');

    expect(first).toMatchObject({ ok: false, changed: true });
    expect(first.usage).toBeDefined();
    expect(first.removed).toEqual([expect.objectContaining({ kind: 'plannedExecution' })]);
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeDefined();

    schedulerDeleteMock.mockResolvedValue({ success: false, error: 'No planned execution with id "pkg-my-pkg-nightly"' });
    const second = await uninstallPackage('my-pkg');

    expect(second).toMatchObject({ ok: true });
    expect(deleteFlowMock).toHaveBeenCalledWith(ROOT);
    expect((store.get(LEDGER_KEY) as Record<string, unknown>)['my-pkg']).toBeUndefined();
  });

  it("tells the route when answers change an automation that runs a Persona, for its local-only check", async () => {
    store.set(LEDGER_KEY, recordWithProvenance());
    serverUses.set('web-search', [{
      key: 'automation:persona-poll:polls',
      place: { kind: 'automation', executionId: 'persona-poll', automationName: 'Inbox check', role: 'polls', personaControlled: true },
      canRemove: true,
    }]);

    expect(await inspectPackageUninstall('my-pkg')).toMatchObject({ exists: true, answersTouchPersonaAutomations: true });
  });
});

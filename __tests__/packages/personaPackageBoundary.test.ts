const schedulerListMock = jest.fn();

jest.mock('@/backend/services/flow', () => ({
  flowService: { loadFlows: jest.fn(async () => []) },
}));

jest.mock('@/backend/services/model', () => ({
  modelService: { loadModels: jest.fn(async () => []) },
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => []),
}));

jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({ list: (...args: unknown[]) => schedulerListMock(...args) }),
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (_key: string, fallback: unknown) => fallback),
}));

import {
  resolvePackageSelection,
  scanTargetsForSelection,
} from '@/backend/services/packages/buildPackage';

describe('Persona package selection boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    schedulerListMock.mockResolvedValue([]);
  });

  it('rejects a Persona plan before package resolution or prompt scanning', async () => {
    schedulerListMock.mockResolvedValue([{
      execution: {
        id: 'persona-plan',
        name: 'Persona plan',
        enabled: true,
        flowId: 'legacy-flow',
        personaId: 'persona_support',
        behaviorSlotKey: 'primary',
        prompt: 'private Persona prompt',
        trigger: { type: 'schedule', cron: '0 0 * * *' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }]);

    await expect(resolvePackageSelection({
      plannedExecutionIds: ['persona-plan'],
    })).rejects.toThrow(/Persona-targeted planned executions cannot be packaged/);
    await expect(scanTargetsForSelection({
      plannedExecutionIds: ['persona-plan'],
    })).rejects.toThrow(/Persona-targeted planned executions cannot be packaged/);
  });

  it.each([
    ['anonymized', { personaArchived: true, personaRetired: true }],
    ['retained tombstone', { personaId: 'persona_deleted', personaRetired: true }],
  ])('rejects a %s Persona plan instead of exporting its legacy Flow fallback', async (_label, markers) => {
    schedulerListMock.mockResolvedValue([{
      execution: {
        id: 'retired-persona-plan',
        name: 'Retired Persona plan',
        enabled: false,
        flowId: 'legacy-flow-must-not-run',
        behaviorSlotKey: 'primary',
        prompt: 'private Persona prompt',
        trigger: { type: 'schedule', cron: '0 0 * * *' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...markers,
      },
    }]);

    await expect(resolvePackageSelection({
      plannedExecutionIds: ['retired-persona-plan'],
    })).rejects.toThrow(/Persona-targeted planned executions cannot be packaged/);
    await expect(scanTargetsForSelection({
      plannedExecutionIds: ['retired-persona-plan'],
    })).rejects.toThrow(/Persona-targeted planned executions cannot be packaged/);
  });

  it('keeps legacy planned-execution selection compatible', async () => {
    schedulerListMock.mockResolvedValue([{
      execution: {
        id: 'legacy-plan',
        name: 'Legacy plan',
        enabled: true,
        flowId: 'legacy-flow',
        prompt: 'legacy prompt',
        trigger: { type: 'schedule', cron: '0 0 * * *' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }]);

    const { resolved } = await resolvePackageSelection({
      plannedExecutionIds: ['legacy-plan'],
    });
    expect(resolved.plannedExecutionIds).toEqual(['legacy-plan']);
  });
});

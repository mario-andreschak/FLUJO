/**
 * GET /api/diagnostics/report with the real section readers over stubbed services:
 * the report is built locally, returned only to the caller, and nothing is sent.
 */
const assertUnlocked = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => assertUnlocked() }));
jest.mock('@/utils/encryption/secure', () => ({
  getEncryptionStatus: async () => ({ initialized: true, locked: false, protection: 'passphrase' }),
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    listModels: async () => ({
      success: true,
      models: [{ id: 'm1', name: 'Private model', provider: 'openrouter', ApiKey: 'sk-or-SECRET' }],
    }),
  },
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: async () => [
      { name: 'private-files', transport: 'stdio', disabled: false, command: 'node', env: { KEY: 'SECRET-ENV' } },
      { name: 'slow-server', transport: 'streamable', disabled: false, url: 'https://intranet.example/mcp' },
      { name: 'parked', transport: 'stdio', disabled: true },
    ],
    getServerStatus: async (name: string) => name === 'slow-server'
      ? { status: 'error', message: 'connect ECONNREFUSED intranet.example', stderrOutput: 'SECRET-ENV' }
      : { status: 'connected', stderrOutput: 'SECRET-ENV' },
  },
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: { loadFlows: async () => [{ name: 'Private agent', nodes: [{ type: 'start' }, { type: 'mcp' }] }] },
}));
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    list: async () => [{
      execution: { name: 'Private schedule', enabled: true, trigger: { type: 'schedule', cron: '0 9 * * *' } },
      status: {},
      lastRun: { status: 'error', error: 'SECRET provider error' },
    }],
  }),
}));
const aggregateStatistics = jest.fn();
jest.mock('@/backend/services/statistics/aggregation', () => ({
  aggregateStatistics: (...args: unknown[]) => aggregateStatistics(...args),
}));

import { GET } from '@/app/api/diagnostics/report/route';

describe('GET /api/diagnostics/report', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    assertUnlocked.mockResolvedValue(null);
    aggregateStatistics.mockResolvedValue({
      summary: { runs: 2, successes: 1, errors: 1, toolCalls: 1, providerAttempts: 2, errorClasses: { timeout: 1 } },
      daily: [{ summary: { runs: 2 } }],
    });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('returns the counted report without contacting anything', async () => {
    const response = await GET(new Request('http://localhost:4200/api/diagnostics/report'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const report = await response.json();
    expect(report.aiConnections).toEqual({ total: 1, byProvider: { openrouter: 1 } });
    expect(report.apps).toEqual({
      total: 3, enabled: 2, byTransport: { stdio: 2, streamable: 1 }, byState: { connected: 1, disabled: 1, error: 1 },
    });
    expect(report.agents).toEqual({ total: 1, usingApps: 1, steps: 2 });
    expect(report.automations).toEqual({ total: 1, enabled: 1, byTrigger: { schedule: 1 }, lastRunFailed: 1 });
    expect(report.activity).toMatchObject({ runs: 2, finished: 1, failed: 1, daysWithRuns: 1, errorTypes: { timeout: 1 } });
    expect(report.security).toMatchObject({ credentialProtection: 'passphrase' });
    expect(report.unavailable).toEqual([]);
    expect(aggregateStatistics).toHaveBeenCalledWith({ range: expect.objectContaining({ from: expect.any(String), to: expect.any(String) }) });
    expect(JSON.stringify(report)).not.toMatch(/SECRET|Private|private-files|intranet|ECONNREFUSED|0 9 \* \* \*/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('asks for the encryption password first when FLUJO is locked', async () => {
    const locked = Response.json({ error: 'locked' }, { status: 423 });
    assertUnlocked.mockResolvedValue(locked);

    const response = await GET(new Request('http://localhost:4200/api/diagnostics/report'));

    expect(response).toBe(locked);
    expect(aggregateStatistics).not.toHaveBeenCalled();
  });
});

/**
 * The diagnostic report for the user pilot (#577): it counts the setup and the last
 * seven days, and nothing private can reach it.
 */
import {
  buildDiagnosticReport,
  collectDiagnosticReport,
  readWithin,
  type DiagnosticReaders,
  type DiagnosticSources,
} from '@/backend/services/diagnostics/report';
import { formatDiagnosticReport, normalizeDiagnosticReport } from '@/shared/types/diagnosticReport';

const SECRETS = [
  'sk-live-SECRET-KEY-123',
  'ghp_SECRETTOKEN',
  'hunter2',
  'Secret Model Name',
  'my-private-server',
  'Alice',
  'internal.corp',
  'private.example.com',
  'payroll',
  'medical record',
  'pocket-garden-042',
  'Webhook secret',
];

function sources(): DiagnosticSources {
  const models = [
    { provider: 'openai', name: 'Secret Model Name', ApiKey: 'sk-live-SECRET-KEY-123', baseUrl: 'https://u:hunter2@private.example.com/v1' },
    { provider: 'anthropic', name: 'Claude', ApiKey: 'sk-live-SECRET-KEY-123' },
    { provider: 'sk-live-SECRET-KEY-123' },
    {},
  ];
  const apps = [
    { name: 'my-private-server', transport: 'stdio', command: 'C:\\Users\\Alice\\server.exe', env: { TOKEN: 'ghp_SECRETTOKEN' }, state: 'connected' },
    { name: 'corp', transport: 'streamable', url: 'https://internal.corp/mcp?token=hunter2', state: 'Connection refused: password=hunter2' },
    { name: 'off', transport: 'stdio', disabled: true, state: 'connected' },
  ];
  const flows = [
    {
      name: 'Alice payroll agent',
      nodes: [
        { type: 'start', data: { label: 'Start', properties: { prompt: 'Read my medical record' } } },
        { type: 'process', data: { label: 'Ask', properties: { messages: ['pocket-garden-042'] } } },
        { type: 'mcp', data: { label: 'my-private-server' } },
        { type: 'finish', data: { label: 'Done' } },
      ],
    },
    { name: 'Plain chat', nodes: [{ type: 'start' }, { type: 'process' }] },
  ];
  const automations = [
    { name: 'Webhook secret', enabled: true, triggerType: 'webhook', lastRunStatus: 'error', error: 'sk-live-SECRET-KEY-123' },
    { name: 'Nightly', enabled: false, triggerType: 'schedule', lastRunStatus: 'completed' },
    { name: 'Odd', enabled: true, triggerType: 'ghp_SECRETTOKEN' },
  ];
  return {
    now: new Date('2026-11-25T10:00:00.000Z'),
    app: { version: '3.48.10', installMode: 'npm' },
    system: { platform: 'win32', arch: 'x64', nodeVersion: '22.23.4', cpuCores: 8, totalMemoryBytes: 32 * 2 ** 30 },
    security: { exposureMode: 'localhost', ownerLogin: false, protection: 'legacy-default' },
    models,
    apps,
    flows,
    automations,
    activity: {
      from: '2026-11-19',
      to: '2026-11-25',
      summary: {
        runs: 15, successes: 9, errors: 2, cancelled: 1, paused: 2, capped: 1, runsIncomplete: 0,
        toolCalls: 20, toolFailures: 3, providerAttempts: 15, providerErrors: 2,
        errorClasses: { rate_limit: 2, 'Read my medical record sk-live-SECRET-KEY-123': 4 },
      },
      daily: [0, 3, 0, 5, 4, 0, 0].map(runs => ({ summary: { runs } })),
    },
  };
}

describe('diagnostic report', () => {
  it('counts the setup and the last seven days', () => {
    const report = buildDiagnosticReport(sources());

    expect(report.app).toEqual({ version: '3.48.10', installMode: 'npm' });
    expect(report.system).toEqual({ os: 'windows', arch: 'x64', nodeVersion: '22.23.4', cpuCores: 8, memoryGb: 32 });
    expect(report.security).toEqual({ networkAccess: 'localhost', ownerLogin: false, credentialProtection: 'default-password' });
    expect(report.aiConnections).toEqual({ total: 4, byProvider: { anthropic: 1, openai: 1, other: 1, unknown: 1 } });
    expect(report.apps).toEqual({
      total: 3, enabled: 2,
      byTransport: { stdio: 2, streamable: 1 },
      byState: { connected: 1, disabled: 1, other: 1 },
    });
    expect(report.agents).toEqual({ total: 2, usingApps: 1, steps: 6 });
    expect(report.automations).toEqual({
      total: 3, enabled: 2, byTrigger: { other: 1, schedule: 1, webhook: 1 }, lastRunFailed: 1,
    });
    expect(report.activity).toEqual({
      from: '2026-11-19', to: '2026-11-25', daysWithRuns: 3,
      runs: 15, finished: 9, failed: 2, stopped: 1, paused: 2, limited: 1, unfinished: 0,
      toolCalls: 20, toolFailures: 3, aiRequests: 15, aiFailures: 2,
      errorTypes: { other: 4, rate_limit: 2 },
    });
    expect(report.unavailable).toEqual([]);
  });

  it('never carries keys, names, addresses, paths, prompts or conversation text', () => {
    const report = buildDiagnosticReport(sources());
    const shared = `${JSON.stringify(report)}\n${formatDiagnosticReport(report)}`;
    for (const secret of SECRETS) expect(shared).not.toContain(secret);
    expect(shared).not.toMatch(/[A-Za-z]:\\|https?:\/\//);
  });

  it('rebuilds a report from fixed fields, so a changed server cannot add text', () => {
    const hostile = {
      ...buildDiagnosticReport(sources()),
      notes: 'sk-live-SECRET-KEY-123',
      createdAt: 'Alice at 2026-11-25',
      app: { version: '3.48.10-sk.live.SECRET', installMode: 'my-private-server' },
      system: { os: 'windows', arch: 'x64', nodeVersion: 'hunter2', cpuCores: -1, memoryGb: 1.5 },
      apps: { total: 1, enabled: 1, byTransport: { 'my-private-server': 1 }, byState: { connected: 'many' } },
    };

    const report = normalizeDiagnosticReport(hostile);
    const shared = `${JSON.stringify(report)}\n${formatDiagnosticReport(hostile)}`;

    for (const secret of SECRETS) expect(shared).not.toContain(secret);
    expect(shared).not.toContain('SECRET');
    expect(report).not.toHaveProperty('notes');
    expect(report.createdAt).toBe('unknown');
    expect(report.app).toEqual({ version: 'unknown', installMode: 'other' });
    expect(report.system).toMatchObject({ nodeVersion: 'unknown', cpuCores: 0, memoryGb: 0 });
    expect(report.apps).toEqual({ total: 1, enabled: 1, byTransport: { other: 1 }, byState: {} });
  });

  it('formats plain text a person can read before sharing', () => {
    const text = formatDiagnosticReport(buildDiagnosticReport(sources()));

    expect(text).toContain('FLUJO: 3.48.10 (npm)');
    expect(text).toContain('System: windows x64, Node.js 22.23.4, 8 CPU cores, 32 GB memory');
    expect(text).toContain('credential protection: default-password');
    expect(text).toContain('AI connections: 4 (anthropic 1, openai 1, other 1, unknown 1)');
    expect(text).toContain('App states: connected 1, disabled 1, other 1');
    expect(text).toContain('Agents: 2, 1 use connected apps, 6 steps in total');
    expect(text).toContain('Runs: 15 (finished 9, failed 2, stopped 1, paused 2, ended at a limit 1, unfinished 0)');
    expect(text).toContain('Error types: other 4, rate_limit 2');
    expect(text).not.toContain('Could not read');
  });

  it('names the sections it could not read and keeps the rest', async () => {
    const readers: DiagnosticReaders = {
      now: () => new Date('2026-11-25T10:00:00.000Z'),
      app: () => sources().app,
      system: () => sources().system,
      security: async () => sources().security!,
      models: async () => { throw new Error('store is busy: sk-live-SECRET-KEY-123'); },
      apps: async () => sources().apps!,
      flows: async () => sources().flows!,
      automations: async () => { throw new Error('scheduler unavailable'); },
      activity: jest.fn(async range => ({ ...sources().activity!, ...range })),
    };

    const report = await collectDiagnosticReport(readers);

    expect(report.aiConnections).toBeNull();
    expect(report.automations).toBeNull();
    expect(report.apps?.total).toBe(3);
    expect(report.unavailable).toEqual(['aiConnections', 'automations']);
    expect(readers.activity).toHaveBeenCalledWith({ from: '2026-11-19', to: '2026-11-25' });
    const text = formatDiagnosticReport(report);
    expect(text).toContain('Could not read: AI connections, automations');
    expect(text).not.toContain('SECRET');
  });

  it('stops waiting for a slow section and tries again next time', async () => {
    let calls = 0;
    const slowThenFast = () => {
      calls += 1;
      return calls === 1 ? new Promise<string>(() => undefined) : Promise.resolve('ready');
    };

    await expect(readWithin(slowThenFast, 10)).resolves.toBeUndefined();
    await expect(readWithin(slowThenFast, 10)).resolves.toBe('ready');
  });
});

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runSelftest, safeOrigin, type SelftestSources } from '@/backend/services/operations/selftest';

let dataDirectory: string;

beforeEach(async () => { dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-selftest-')); });
afterEach(async () => { await fs.rm(dataDirectory, { recursive: true, force: true }); });

function sources(overrides: Partial<SelftestSources> = {}): SelftestSources {
  return {
    workspace: 'default-workspace',
    dataDirectory,
    writeFileAtomic: (file, data) => fs.writeFile(file, data),
    loadFlows: async () => [{}, {}],
    loadModels: async () => [],
    loadServers: async () => [],
    runtimeStates: () => new Map(),
    scheduler: async () => ({ enabled: 1, armed: 1, paused: false, started: true }),
    network: true,
    reach: async () => true,
    ...overrides,
  };
}

const check = (report: Awaited<ReturnType<typeof runSelftest>>, id: string) => report.checks.find(entry => entry.id === id)!;

it('reports usable when storage and flows work, and leaves no probe file behind', async () => {
  const report = await runSelftest(sources());
  expect(report.usable).toBe(true);
  expect(check(report, 'storage').status).toBe('ok');
  expect(check(report, 'flows')).toMatchObject({ status: 'ok', count: 2 });
  expect(await fs.readdir(path.join(dataDirectory, 'db'))).toEqual([]);
});

it.each([
  ['ENOSPC', 'disk-full'], ['EACCES', 'not-allowed'], ['EPERM', 'not-allowed'], ['EIO', 'not-writable'],
])('storage failure %s is not usable, with a plain reason', async (code, reason) => {
  const report = await runSelftest(sources({
    writeFileAtomic: async () => { throw Object.assign(new Error(`secret path ${dataDirectory}`), { code }); },
  }));
  expect(report.usable).toBe(false);
  expect(check(report, 'storage')).toEqual({ id: 'storage', status: 'fail', reason });
  expect(JSON.stringify(report)).not.toContain(dataDirectory);
});

it('notices a write that does not read back the same', async () => {
  const report = await runSelftest(sources({ writeFileAtomic: (file) => fs.writeFile(file, 'something else') }));
  expect(check(report, 'storage')).toMatchObject({ status: 'fail', reason: 'read-back-differs' });
});

it('flows that do not load make it not usable', async () => {
  const report = await runSelftest(sources({ loadFlows: async () => { throw new Error('broken flow file with secret'); } }));
  expect(report.usable).toBe(false);
  expect(check(report, 'flows')).toEqual({ id: 'flows', status: 'fail', reason: 'flows-did-not-load' });
  expect(JSON.stringify(report)).not.toContain('secret');
});

it('an unreachable model or MCP host is reported, not a failure', async () => {
  const report = await runSelftest(sources({
    loadModels: async () => [{ name: 'a', baseUrl: 'https://down.example/v1' }, { name: 'b', baseUrl: 'https://up.example/v1' }],
    loadServers: async () => [{ name: 'remote', transport: 'streamable', serverUrl: 'https://down.example/mcp' }],
    reach: async origin => origin === 'https://up.example',
  }));
  expect(report.usable).toBe(true);
  expect(check(report, 'models').status).toBe('warn');
  expect(check(report, 'models').items).toEqual([
    { name: 'a', status: 'warn', reason: 'not-reachable', host: 'down.example' },
    { name: 'b', status: 'ok', host: 'up.example' },
  ]);
  expect(check(report, 'mcp').status).toBe('warn');
});

it('never reveals a key that sits in a stored address, and asks each host once', async () => {
  const asked: string[] = [];
  const report = await runSelftest(sources({
    loadModels: async () => [
      { name: 'a', baseUrl: 'https://user:hunter2@api.example/v1?key=sk-secret' },
      { name: 'b', baseUrl: 'https://api.example/other' },
    ],
    reach: async origin => { asked.push(origin); return true; },
  }));
  expect(asked).toEqual(['https://api.example']);
  const text = JSON.stringify(report);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('sk-secret');
});

it('makes no network call when asked not to, or for local sign-in models', async () => {
  const reach = jest.fn(async () => true);
  const off = await runSelftest(sources({
    network: false, reach,
    loadModels: async () => [{ name: 'a', baseUrl: 'https://api.example/v1' }],
    loadServers: async () => [{ name: 'remote', transport: 'sse', serverUrl: 'https://mcp.example/sse' }],
  }));
  expect(reach).not.toHaveBeenCalled();
  expect(check(off, 'models').items?.[0]).toMatchObject({ status: 'skipped', reason: 'network-check-off' });
  const local = await runSelftest(sources({ reach, loadModels: async () => [{ name: 'c', adapter: 'claude-cli' }] }));
  expect(reach).not.toHaveBeenCalled();
  expect(check(local, 'models').items?.[0]).toMatchObject({ status: 'skipped', reason: 'local-sign-in' });
});

it('does not start MCP servers: it reports what they are doing', async () => {
  const report = await runSelftest(sources({
    loadServers: async () => [
      { name: 'off', disabled: true, transport: 'stdio' },
      { name: 'cold', transport: 'stdio' },
      { name: 'warm', transport: 'stdio' },
      { name: 'broken', transport: 'stdio' },
    ],
    runtimeStates: () => new Map([['warm', 'warm'], ['broken', 'error']]),
  }));
  expect(check(report, 'mcp').items).toEqual([
    { name: 'off', status: 'skipped', reason: 'switched-off' },
    { name: 'cold', status: 'skipped', reason: 'state-cold' },
    { name: 'warm', status: 'ok', reason: undefined },
    { name: 'broken', status: 'warn', reason: 'last-start-failed' },
  ]);
});

it('paused or unstarted schedules are a warning', async () => {
  const paused = await runSelftest(sources({ scheduler: async () => ({ enabled: 2, armed: 0, paused: true, started: true }) }));
  expect(check(paused, 'schedules')).toMatchObject({ status: 'warn', reason: 'paused' });
  const unstarted = await runSelftest(sources({ scheduler: async () => ({ enabled: 2, armed: 0, paused: false, started: false }) }));
  expect(check(unstarted, 'schedules')).toMatchObject({ status: 'warn', reason: 'not-started' });
  const none = await runSelftest(sources({ scheduler: async () => ({ enabled: 0, armed: 0, paused: false, started: false }) }));
  expect(check(none, 'schedules').status).toBe('ok');
});

it('a model list that cannot be read is a failure, because then credentials are unusable', async () => {
  const report = await runSelftest(sources({ loadModels: async () => { throw new Error('x'); } }));
  expect(report.usable).toBe(false);
  expect(check(report, 'models')).toEqual({ id: 'models', status: 'fail', reason: 'models-did-not-load' });
});

it('safeOrigin refuses anything but web addresses', () => {
  expect(safeOrigin('https://a.example/x?y=1')).toEqual({ origin: 'https://a.example', host: 'a.example' });
  for (const bad of [undefined, '', '   ', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) expect(safeOrigin(bad)).toBeNull();
});

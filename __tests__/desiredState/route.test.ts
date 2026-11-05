/** The operations route, with real storage. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/operations/desired-state/route';
import { applyDesiredState } from '@/backend/services/desiredState';
import { authenticate, initializeEncryption } from '@/utils/encryption/secure';
import { lockServer } from '@/utils/encryption/session';

jest.setTimeout(60_000);

const SECRET = 'route-secret-that-must-never-appear-4411aa';

function aFile(version: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version,
    settings: { telemetry: { enabled: false } },
    models: [{ id: 'a-model', name: 'provider-model', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${env:DS_ROUTE_KEY}' }],
    flows: [{
      id: 'a-flow',
      spec: {
        name: 'private_flow_name',
        nodes: [
          { key: 'start', type: 'start', label: 'Start' },
          { key: 'answer', type: 'static', label: 'Answer', outputTemplate: `private content ${version}` },
          { key: 'end', type: 'finish', label: 'Finish' },
        ],
        edges: [{ from: 'start', to: 'answer' }, { from: 'answer', to: 'end' }],
      },
    }],
    ...overrides,
  };
}

const URL_BASE = 'http://localhost/api/operations/desired-state?workspace=default-workspace';
const post = (body: unknown, host = 'localhost') => POST(new NextRequest(URL_BASE, {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', host },
}));
const get = () => GET(new NextRequest(URL_BASE, { headers: { host: 'localhost' } }));

describe('desired state over the operations route', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-desired-route-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    process.env.DS_ROUTE_KEY = SECRET;
    delete process.env.FLUJO_OWNER_AUTH_FILE;
    delete process.env.FLUJO_EXPOSURE_MODE;
    delete process.env.FLUJO_DESIRED_STATE_FILE;
    global.__flujo_flowsCache = null;
    global.__flujo_server_dek = undefined;
  });

  afterEach(async () => {
    delete process.env.DS_ROUTE_KEY;
    delete process.env.FLUJO_OWNER_AUTH_FILE;
    delete process.env.FLUJO_DESIRED_STATE_FILE;
    delete process.env.FLUJO_WORKER_MODE;
    delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    global.__flujo_flowsCache = null;
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  describe('the route', () => {
    it('dry-runs, applies, reports and rolls back', async () => {
      const preview = await post({ action: 'dry-run', state: aFile('1') });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ outcome: 'would-change', dryRun: true, version: '1' });
      expect(preview.headers.get('cache-control')).toBe('no-store');

      const applied = await post({ action: 'apply', state: aFile('1') });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({ outcome: 'applied', version: '1' });
      expect(await (await post({ action: 'apply', state: aFile('1') })).json()).toMatchObject({ outcome: 'unchanged' });
      await post({ action: 'apply', state: aFile('2') });

      const overview = await (await get()).json();
      expect(overview.status).toMatchObject({ appliedVersion: '2', lastApplyFailed: false, fileConfigured: false });
      expect(overview.versions.map((entry: { version: string }) => entry.version)).toEqual(['1', '2']);
      expect(overview.managed).toEqual(expect.arrayContaining([{ kind: 'flow', id: 'a-flow' }]));

      expect(await (await post({ action: 'rollback', dryRun: true })).json()).toMatchObject({ outcome: 'would-roll-back', version: '1' });
      const rolled = await post({ action: 'rollback' });
      expect(rolled.status).toBe(200);
      expect(await rolled.json()).toMatchObject({ outcome: 'rolled-back', version: '1', previousVersion: '2' });
    });

    it('explains an invalid file in plain words and changes nothing', async () => {
      const response = await post({ action: 'apply', state: aFile('1', { settings: { telemetri: {} } }) });

      expect(response.status).toBe(422);
      const report = await response.json();
      expect(report.outcome).toBe('invalid');
      expect(report.message).toContain('nothing was changed');
      expect(report.problems[0]).toMatchObject({ where: 'settings.telemetri' });
    });

    it('uses the configured file when the request names none, and says when there is none', async () => {
      const none = await post({ action: 'dry-run' });
      expect(none.status).toBe(422);
      expect((await none.json()).message).toContain('FLUJO_DESIRED_STATE_FILE');

      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, JSON.stringify(aFile('1')));
      process.env.FLUJO_DESIRED_STATE_FILE = file;
      expect(await (await post({ action: 'apply' })).json()).toMatchObject({ outcome: 'applied', version: '1' });
    });

    it('refuses bad requests', async () => {
      expect((await post({ action: 'something-else' })).status).toBe(400);
      expect((await post('{ not json')).status).toBe(400);
      expect((await post([1, 2, 3])).status).toBe(400);
    });

    it('never returns a secret', async () => {
      const bodies = [
        await (await post({ action: 'dry-run', state: aFile('1') })).text(),
        await (await post({ action: 'apply', state: aFile('1') })).text(),
        await (await post({ action: 'apply', state: aFile('2', { models: [{ id: 'x', name: 'n', provider: 'openai', apiKey: SECRET }] }) })).text(),
        await (await get()).text(),
      ];
      expect(bodies.join('\n')).not.toContain(SECRET);
    });

    it('reports locked storage and never works around it', async () => {
      await initializeEncryption('a passphrase for this test');
      lockServer();
      for (const response of [await post({ action: 'apply', state: aFile('1') }), await get()]) {
        expect(response.status).toBe(423);
        expect(await response.json()).toMatchObject({ error: 'encryption_locked' });
      }
      await authenticate('a passphrase for this test');
      expect((await (await get()).json()).status.appliedVersion).toBeNull();
    });

    it('refuses a caller from elsewhere before touching storage', async () => {
      const response = await post({ action: 'apply', state: aFile('1') }, '192.0.2.10');

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      await expect(fs.access(path.join(dataDir, 'workspaces', 'default-workspace', 'db', 'desired-state'))).rejects.toThrow();
    });

    it('refuses a missing owner credential once an owner policy is configured', async () => {
      process.env.FLUJO_OWNER_AUTH_FILE = path.join(dataDir, 'owner-policy.json');

      const response = await post({ action: 'apply', state: aFile('1') });

      expect(response.status).toBeGreaterThanOrEqual(401);
      await expect(fs.access(path.join(dataDir, 'workspaces', 'default-workspace', 'db', 'desired-state'))).rejects.toThrow();
    });

    it('does not apply to a worker, which runs from a restored copy', async () => {
      process.env.FLUJO_WORKER_MODE = '1';
      process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'fixture-control';

      const report = await applyDesiredState(aFile('1'), { reconcileRuntime: false });

      expect(report.outcome).toBe('not-available');
    });
  });
});

/**
 * The operations route and the optional heartbeat, with real storage and a real loopback
 * address to report to.
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/operations/desired-state/route';
import { applyDesiredState } from '@/backend/services/desiredState';
import { sendDesiredStateHeartbeats } from '@/backend/services/desiredState/heartbeat';
import { loadStatus } from '@/backend/services/desiredState/store';
import { StorageKey } from '@/shared/types/storage';
import * as secure from '@/utils/encryption/secure';
import { saveItem } from '@/utils/storage/backend';

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
const post = (body: unknown, url = URL_BASE) => POST(new NextRequest(url, {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
}));

describe('desired state over the operations route and heartbeat', () => {
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
    delete process.env.FLUJO_HEARTBEAT_URL;
    delete process.env.FLUJO_HEARTBEAT_TOKEN;
    delete process.env.FLUJO_DESIRED_STATE_FILE;
    global.__flujo_flowsCache = null;
    global.__flujo_heartbeat_next_due = undefined;
  });

  afterEach(async () => {
    delete process.env.DS_ROUTE_KEY;
    delete process.env.FLUJO_HEARTBEAT_URL;
    delete process.env.FLUJO_HEARTBEAT_TOKEN;
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

      const overview = await (await GET(new NextRequest(URL_BASE))).json();
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
        await (await GET(new NextRequest(URL_BASE))).text(),
      ];
      expect(bodies.join('\n')).not.toContain(SECRET);
    });

    it('reports locked storage and never works around it', async () => {
      const spy = jest.spyOn(secure, 'isEncryptionLocked').mockResolvedValue(true);
      try {
        for (const response of [await post({ action: 'apply', state: aFile('1') }), await GET(new NextRequest(URL_BASE))]) {
          expect(response.status).toBe(423);
          expect(await response.json()).toMatchObject({ error: 'encryption_locked' });
        }
      } finally {
        spy.mockRestore();
      }
      expect((await (await GET(new NextRequest(URL_BASE))).json()).status.appliedVersion).toBeNull();
    });

    it('refuses a caller from elsewhere before touching storage', async () => {
      const response = await post({ action: 'apply', state: aFile('1') }, 'http://192.0.2.10/api/operations/desired-state');

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

  describe('the heartbeat', () => {
    let server: http.Server;
    let received: Array<{ path: string; authorization?: string; body: Record<string, unknown> }>;
    let respond: (response: http.ServerResponse) => void;
    let address: string;

    beforeEach(async () => {
      received = [];
      respond = (response) => response.writeHead(204).end();
      server = http.createServer((request, response) => {
        let text = '';
        request.on('data', (chunk) => { text += chunk; });
        request.on('end', () => {
          received.push({ path: request.url ?? '', authorization: request.headers.authorization, body: text ? JSON.parse(text) : {} });
          respond(response);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/report/site`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('stays off without a URL and sends nothing', async () => {
      await applyDesiredState(aFile('1'), { reconcileRuntime: false });
      const before = await loadStatus();

      await sendDesiredStateHeartbeats();

      expect(received).toEqual([]);
      expect((await loadStatus()).heartbeat).toEqual(before.heartbeat);
    });

    it('sends version and status only, no content', async () => {
      await applyDesiredState(aFile('1', { settings: { heartbeat: { url: address, intervalMinutes: 5 } } }), { reconcileRuntime: false });

      await sendDesiredStateHeartbeats();

      expect(received).toHaveLength(1);
      expect(received[0].path).toBe('/report/site');
      expect(received[0].body).toEqual({
        schemaVersion: 1,
        flujoVersion: expect.any(String),
        desiredStateVersion: '1',
        appliedAt: expect.any(String),
        lastApplyFailed: false,
        status: 'ok',
      });
      const sent = JSON.stringify(received[0]);
      for (const hidden of ['private_flow_name', 'private content', 'a-model', 'default-workspace', SECRET]) {
        expect(sent).not.toContain(hidden);
      }
      expect((await loadStatus()).heartbeat).toEqual({ lastSentAt: expect.any(String), lastOk: true });
    });

    it('waits for its interval, then reports again', async () => {
      await applyDesiredState(aFile('1', { settings: { heartbeat: { url: address, intervalMinutes: 5 } } }), { reconcileRuntime: false });
      const start = Date.now();

      await sendDesiredStateHeartbeats(start);
      await sendDesiredStateHeartbeats(start + 60_000);
      expect(received).toHaveLength(1);

      await sendDesiredStateHeartbeats(start + 6 * 60_000);
      expect(received).toHaveLength(2);
    });

    it('takes its address and token from the environment, and says when something needs attention', async () => {
      process.env.FLUJO_HEARTBEAT_URL = address;
      process.env.FLUJO_HEARTBEAT_TOKEN = 'heartbeat-token';
      await applyDesiredState(aFile('1', { settings: { telemetri: {} } }), { reconcileRuntime: false });

      await sendDesiredStateHeartbeats();

      expect(received[0].authorization).toBe('Bearer heartbeat-token');
      expect(received[0].body).toMatchObject({ status: 'attention', lastApplyFailed: true, desiredStateVersion: null });
    });

    it('reports a locked workspace as locked', async () => {
      process.env.FLUJO_HEARTBEAT_URL = address;
      const spy = jest.spyOn(secure, 'isEncryptionLocked').mockResolvedValue(true);
      try {
        await sendDesiredStateHeartbeats();
      } finally {
        spy.mockRestore();
      }
      expect(received[0].body.status).toBe('locked');
    });

    it('notes a failure and carries on when nobody answers', async () => {
      process.env.FLUJO_HEARTBEAT_URL = 'http://127.0.0.1:9/nobody-here';

      await expect(sendDesiredStateHeartbeats()).resolves.toBeUndefined();

      expect((await loadStatus()).heartbeat.lastOk).toBe(false);
    });

    it('counts an error answer as a failure', async () => {
      respond = (response) => response.writeHead(500).end();
      process.env.FLUJO_HEARTBEAT_URL = address;

      await sendDesiredStateHeartbeats();

      expect((await loadStatus()).heartbeat.lastOk).toBe(false);
    });

    it('does not follow a redirect, which could carry the token elsewhere', async () => {
      respond = (response) => response.writeHead(302, { location: `${address}/elsewhere` }).end();
      process.env.FLUJO_HEARTBEAT_URL = address;
      process.env.FLUJO_HEARTBEAT_TOKEN = 'heartbeat-token';

      await sendDesiredStateHeartbeats();

      expect(received).toHaveLength(1);
      expect((await loadStatus()).heartbeat.lastOk).toBe(false);
    });

    it('will not send over plain http to another computer', async () => {
      const spy = jest.spyOn(globalThis, 'fetch');
      process.env.FLUJO_HEARTBEAT_URL = 'http://192.0.2.10/report';
      try {
        await sendDesiredStateHeartbeats();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect((await loadStatus()).heartbeat.lastOk).toBe(false);
    });

    it('refuses such an address in the file', async () => {
      const report = await applyDesiredState(aFile('1', { settings: { heartbeat: { url: 'http://192.0.2.10/report' } } }), { reconcileRuntime: false });

      expect(report.outcome).toBe('invalid');
      expect(report.problems[0].where).toBe('settings.heartbeat.url');
    });

    it('never shows its address in a report', async () => {
      const report = await applyDesiredState(aFile('1', { settings: { heartbeat: { url: address } } }), { reconcileRuntime: false, dryRun: true });

      expect(JSON.stringify(report)).not.toContain(address);
      expect(report.changes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'heartbeat.url', action: 'update' })]));
    });

    it('leaves other settings in the document alone', async () => {
      await saveItem(StorageKey.SPEECH_SETTINGS, { speech: { enabled: false, language: 'de' } });

      await applyDesiredState(aFile('1', { settings: { heartbeat: { url: address } } }), { reconcileRuntime: false });

      const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'workspaces', 'default-workspace', 'db', 'speech_settings.json'), 'utf8'));
      expect(stored.speech).toEqual({ enabled: false, language: 'de' });
    });
  });
});

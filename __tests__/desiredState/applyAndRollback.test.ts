/**
 * A desired state on real files: real flow, model, server and schedule storage in a private
 * data folder, with nothing replaced except the points where a test pretends the process died.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDesiredState,
  applyDesiredStateAtStartup,
  ensureDesiredStateWorkspaces,
  getDesiredStateOverview,
  rollbackDesiredState,
} from '@/backend/services/desiredState';
import { _setCrashPointForTests, SimulatedCrash } from '@/backend/services/desiredState/execute';
import { flowService } from '@/backend/services/flow';
import { listFlowVersions } from '@/backend/services/flow/flowVersions';
import { mcpService } from '@/backend/services/mcp';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { StorageKey, type Settings } from '@/shared/types/storage';
import * as secure from '@/utils/encryption/secure';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { runWithWorkspace, workspaceExists } from '@/utils/workspace';

jest.setTimeout(60_000);

const SECRET = 'plain-value-that-must-never-appear-9f3c1d7e';
const OTHER_SECRET = 'rotated-value-that-must-never-appear-77aa10';

function simpleSpec(name: string, output: string) {
  return {
    name,
    nodes: [
      { key: 'start', type: 'start', label: 'Start' },
      { key: 'answer', type: 'static', label: 'Answer', outputTemplate: output },
      { key: 'end', type: 'finish', label: 'Finish' },
    ],
    edges: [{ from: 'start', to: 'answer' }, { from: 'answer', to: 'end' }],
  };
}

function baseFile(version: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version,
    settings: {
      telemetry: { enabled: false, notifyDaily: false },
      modelAccess: { quickChat: false, directModelCalls: false },
      onboarding: { completed: true },
    },
    models: [{
      id: 'main-model',
      name: 'provider-model-1',
      displayName: 'Main model',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '${env:DS_TEST_KEY}',
    }],
    mcpServers: [{
      name: 'file-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MODE: 'quiet', TOKEN: '${env:DS_TEST_KEY}' },
      disabled: true,
    }],
    flows: [
      { id: 'first-flow', spec: simpleSpec('first_flow', 'first answer') },
      { id: 'second-flow', spec: simpleSpec('second_flow', 'second answer') },
    ],
    plannedExecutions: [{
      id: 'nightly',
      name: 'Nightly',
      flowId: 'first-flow',
      enabled: false,
      prompt: 'Run it.',
      trigger: { type: 'schedule', cron: '0 3 * * *' },
    }],
    ...overrides,
  };
}

describe('desired state', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let db: string;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-desired-state-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    db = path.join(dataDir, 'workspaces', 'default-workspace', 'db');
    await fs.mkdir(db, { recursive: true });
    process.env.DS_TEST_KEY = SECRET;
    delete process.env.FLUJO_DESIRED_STATE_FILE;
    delete process.env.FLUJO_OWNER_AUTH_FILE;
    global.__flujo_flowsCache = null;
  });

  afterEach(async () => {
    _setCrashPointForTests(undefined);
    delete process.env.DS_TEST_KEY;
    delete process.env.FLUJO_DESIRED_STATE_FILE;
    global.__flujo_flowsCache = null;
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const apply = (file: unknown) => applyDesiredState(file, { reconcileRuntime: false });
  const dryRun = (file: unknown) => applyDesiredState(file, { dryRun: true, reconcileRuntime: false });
  const rollback = (dry = false) => rollbackDesiredState({ dryRun: dry, reconcileRuntime: false });
  const settings = () => loadItem<Settings | null>(StorageKey.SPEECH_SETTINGS, null);
  const servers = () => loadItem<Record<string, Record<string, unknown>>>(StorageKey.MCP_SERVERS, {});
  const answerOf = async (flowId: string) => {
    const flow = await flowService.getFlow(flowId);
    return flow?.nodes.find((node) => node.type === 'static')?.data?.properties?.outputTemplate;
  };

  /** Every file below the data folder, as text. */
  async function everyFile(root = dataDir): Promise<string> {
    let all = '';
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      all += entry.isDirectory() ? await everyFile(full) : `\n${await fs.readFile(full, 'utf8')}`;
    }
    return all;
  }
  /** What the file names, so two moments can be compared. Timestamps are left out on purpose. */
  async function snapshotOfInstance(): Promise<unknown> {
    const flows = await flowService.loadFlowsForBackup();
    return {
      flows: flows
        .map(({ createdAt: _c, updatedAt: _u, ...flow }) => flow)
        .sort((a, b) => a.id.localeCompare(b.id)),
      models: await modelService.loadModels(),
      servers: await servers(),
      executions: (await getSchedulerService().list())
        .map(({ execution }) => {
          const { updatedAt: _u, createdAt: _c, generationId: _g, ...rest } = execution;
          return rest;
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      settings: await settings(),
    };
  }
  const restart = () => { global.__flujo_flowsCache = null; };

  describe('dry run', () => {
    it('reports exactly what an apply then does, and writes nothing', async () => {
      const preview = await dryRun(baseFile('1'));

      expect(preview.outcome).toBe('would-change');
      expect(await settings()).toBeNull();
      expect(await modelService.loadModels()).toEqual([]);
      await expect(fs.access(path.join(db, 'desired-state'))).rejects.toThrow();

      const applied = await apply(baseFile('1'));

      expect(applied.outcome).toBe('applied');
      const key = (change: { kind: string; id: string; action: string }) => `${change.kind}:${change.id}:${change.action}`;
      expect(applied.changes.map(key).sort()).toEqual(preview.changes.map(key).sort());
      expect(preview.changes.map(key)).toEqual(expect.arrayContaining([
        'setting:telemetry.enabled:update',
        'setting:modelAccess.quickChat:update',
        'secret:DS_TEST_KEY:create',
        'model:main-model:create',
        'mcpServer:file-server:create',
        'flow:first-flow:create',
        'plannedExecution:nightly:create',
      ]));
    });
  });

  describe('apply', () => {
    it('sets up a whole empty instance from the file', async () => {
      const report = await apply(baseFile('1'));

      expect(report.outcome).toBe('applied');
      const stored = await settings();
      expect(stored?.telemetry).toEqual({ enabled: false, notifyDaily: false });
      expect(stored?.modelAccess).toEqual({ quickChat: false, directModelCalls: false });
      expect(stored?.onboarding?.completed).toBe(true);
      // A brand-new settings document keeps the defaults a new installation would get.
      expect(stored?.speech).toEqual({ enabled: true });
      expect((await modelService.getModel('main-model'))?.ApiKey).toBe('${global:DS_TEST_KEY}');
      const server = (await servers())['file-server'];
      expect(server.command).toBe('node');
      expect(server.env).toEqual({
        MODE: { value: 'quiet', metadata: { isSecret: false } },
        TOKEN: { value: '${global:DS_TEST_KEY}', metadata: { isSecret: true } },
      });
      expect(await answerOf('first-flow')).toBe('first answer');
      expect((await getSchedulerService().get('nightly'))?.flowId).toBe('first-flow');

      const overview = await getDesiredStateOverview();
      expect(overview.status).toMatchObject({ appliedVersion: '1', lastApplyFailed: false });
      expect(overview.managed).toEqual(expect.arrayContaining([
        { kind: 'flow', id: 'first-flow' },
        { kind: 'model', id: 'main-model' },
        { kind: 'mcpServer', id: 'file-server' },
        { kind: 'plannedExecution', id: 'nightly' },
        { kind: 'setting', id: 'telemetry.enabled' },
        { kind: 'secret', id: 'DS_TEST_KEY' },
      ]));
    });

    it('takes a flow in saved form too', async () => {
      const compiled = compileFlowSpec(simpleSpec('saved_form', 'from a saved flow') as never);

      const report = await apply(baseFile('1', { flows: [{ id: 'saved', flow: compiled.flow }], plannedExecutions: [] }));

      expect(report.outcome).toBe('applied');
      expect((await flowService.getFlow('saved'))?.name).toBe('saved_form');
    });

    it('changes nothing the second time, down to the files on disk', async () => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();
      const flowFile = path.join(db, 'flows', 'first-flow.json');
      const statBefore = await fs.stat(flowFile);
      const updatedBefore = (await flowService.getFlow('first-flow'))?.updatedAt;

      const again = await apply(baseFile('1'));

      expect(again.outcome).toBe('unchanged');
      expect(again.changes).toEqual([]);
      expect(await snapshotOfInstance()).toEqual(before);
      expect((await fs.stat(flowFile)).mtimeMs).toBe(statBefore.mtimeMs);
      expect((await flowService.getFlow('first-flow'))?.updatedAt).toBe(updatedBefore);
      expect(await listFlowVersions('first-flow')).toEqual([]);
      expect((await getDesiredStateOverview()).versions).toHaveLength(1);
      expect((await dryRun(baseFile('1'))).outcome).toBe('would-not-change');
    });

    it('gives a changed flow a new version, keeps its step ids, and keeps the old definition in its history', async () => {
      await apply(baseFile('1'));
      const before = await flowService.getFlow('first-flow');

      const report = await apply(baseFile('2', { flows: [
        { id: 'first-flow', spec: simpleSpec('first_flow', 'changed answer') },
        { id: 'second-flow', spec: simpleSpec('second_flow', 'second answer') },
      ] }));

      expect(report.outcome).toBe('applied');
      expect(report.changes).toEqual([expect.objectContaining({
        kind: 'flow', id: 'first-flow', action: 'update',
        fields: [expect.stringContaining('outputTemplate')],
      })]);
      const after = await flowService.getFlow('first-flow');
      expect(after?.nodes.map((node) => node.id)).toEqual(before?.nodes.map((node) => node.id));
      expect(await listFlowVersions('first-flow')).toHaveLength(1);
      expect(await listFlowVersions('second-flow')).toEqual([]);
    });

    it('records a new version even when no object changed', async () => {
      await apply(baseFile('1'));

      const report = await apply({ ...baseFile('2') });

      expect(report.outcome).toBe('applied');
      expect(report.changes).toEqual([]);
      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('2');
    });

    it('refuses to reuse a version for different content', async () => {
      await apply(baseFile('1'));

      const report = await apply(baseFile('1', { plannedExecutions: [] }));

      expect(report.outcome).toBe('invalid');
      expect(report.problems[0].message).toContain('already applied with different content');
      expect(await getSchedulerService().get('nightly')).not.toBeNull();
    });
  });

  describe('an invalid file leaves everything as it was', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['a secret value in a model', { models: [{ id: 'm', name: 'n', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'typed-in-value' }] }, /may only name a secret/],
      ['a secret value in a server', { mcpServers: [{ name: 's', command: 'node', env: { API_TOKEN: 'typed-in-value' } }] }, /may only name a secret/],
      ['a secret in a header', { mcpServers: [{ name: 's', transport: 'streamable', serverUrl: 'http://127.0.0.1:9', headers: { Authorization: 'Bearer abc' } }] }, /may only name a secret/],
      ['a key that looks real in a prompt', { flows: [{ id: 'f', spec: { ...simpleSpec('f', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789abcd') } }] }, /looks like a secret/],
      ['an environment variable that is not set', { models: [{ id: 'm', name: 'n', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${env:DS_NOT_SET}' }] }, /DS_NOT_SET is not set/],
      ['a secret store entry that does not exist', { models: [{ id: 'm', name: 'n', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${global:NOT_THERE}' }] }, /nothing called NOT_THERE/],
      ['a misspelt setting', { settings: { telemetri: { enabled: false } } }, /setting is not known/],
      ['a misspelt field of a setting', { settings: { telemetry: { enabeld: false } } }, /not known: enabeld/],
      ['a flow that names a model nobody has', { flows: [{ id: 'f', spec: { name: 'f', nodes: [{ key: 's', type: 'start' }, { key: 'p', type: 'process', model: 'nobody', prompt: 'x' }, { key: 'e', type: 'finish' }], edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'e' }] } }] }, /.+/],
      ['a flow whose edge goes nowhere', { flows: [{ id: 'f', spec: { name: 'f', nodes: [{ key: 's', type: 'start' }], edges: [{ from: 's', to: 'missing' }] } }] }, /does not exist/],
      ['a subflow that exists nowhere', { flows: [{ id: 'f', flow: { name: 'f', nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { label: 's', type: 'start', properties: {} } },
        { id: 'c', type: 'subflow', position: { x: 0, y: 0 }, data: { label: 'c', type: 'subflow', properties: { subflowId: 'gone' } } },
        { id: 'e', type: 'finish', position: { x: 0, y: 0 }, data: { label: 'e', type: 'finish', properties: {} } },
      ], edges: [
        { id: '1', source: 's', target: 'c', data: { edgeType: 'standard' } },
        { id: '2', source: 'c', target: 'e', data: { edgeType: 'standard' } },
      ] } }] }, /neither in this file nor on this instance/],
      ['a schedule for a flow nobody has', { plannedExecutions: [{ id: 'p', name: 'P', flowId: 'nobody', enabled: false, prompt: 'x', trigger: { type: 'schedule', cron: '0 3 * * *' } }] }, /neither in this file nor on this instance/],
      ['a broken schedule', { plannedExecutions: [{ id: 'p', name: 'P', flowId: 'first-flow', enabled: false, prompt: 'x', trigger: { type: 'schedule', cron: 'whenever' } }] }, /.+/],
      ['a webhook, which needs a secret token', { plannedExecutions: [{ id: 'p', name: 'P', flowId: 'first-flow', enabled: false, prompt: 'x', trigger: { type: 'webhook', token: 'x' } }] }, /secret token/],
      ['a file for another workspace', { workspace: 'somewhere-else' }, /not for "default-workspace"/],
      ['a later file format', { schemaVersion: 99 }, /reads version 1/],
      ['a wider network without owner access', { settings: { network: { exposure: 'network' } } }, /refuse to start/],
    ];

    it.each(cases)('%s', async (_label, overrides, reason) => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();

      const report = await apply(baseFile('2', overrides));

      expect(report.outcome).toBe('invalid');
      expect(JSON.stringify(report.problems)).toMatch(reason);
      expect(await snapshotOfInstance()).toEqual(before);
      const { status } = await getDesiredStateOverview();
      expect(status).toMatchObject({ appliedVersion: '1', lastApplyFailed: true });
      expect(status.lastFailureCode).toBe('invalid-file');
      // The next good apply clears the failure.
      expect((await apply(baseFile('1'))).outcome).toBe('unchanged');
      expect((await getDesiredStateOverview()).status.lastApplyFailed).toBe(false);
    });

    it('does not mistake a good first half for a good file', async () => {
      const report = await apply(baseFile('1', {
        settings: { telemetry: { enabled: false } },
        flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'fine') }, { id: 'bad', spec: { name: 'bad', nodes: [], edges: [] } }],
        plannedExecutions: [],
      }));

      expect(report.outcome).toBe('invalid');
      expect(await settings()).toBeNull();
      expect(await modelService.loadModels()).toEqual([]);
      expect(await flowService.getFlow('first-flow')).toBeNull();
      expect((await getDesiredStateOverview()).status.appliedVersion).toBeNull();
    });

    it('never echoes the text it refused', async () => {
      const report = await apply(baseFile('1', {
        models: [{ id: 'm', name: 'n', provider: 'openai', apiKey: SECRET }],
      }));

      expect(JSON.stringify(report)).not.toContain(SECRET);
      expect(await everyFile()).not.toContain(SECRET);
    });
  });

  describe('a write that fails', () => {
    it('puts everything back and says so', async () => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();
      const realSave = flowService.saveFlow.bind(flowService);
      const spy = jest.spyOn(flowService, 'saveFlow').mockImplementation(async (flow, options) => (
        flow.id === 'second-flow' && !spy.mock.calls.some(([saved]) => saved.id === 'restored-marker')
          ? { success: false, error: 'the disk said no' }
          : realSave(flow, options)
      ));
      try {
        // Second flow fails after the settings, model, server and first flow were written.
        const report = await apply(baseFile('2', {
          settings: { telemetry: { enabled: true, notifyDaily: true } },
          flows: [
            { id: 'first-flow', spec: simpleSpec('first_flow', 'half way') },
            { id: 'second-flow', spec: simpleSpec('second_flow', 'never written') },
          ],
          models: [{ id: 'main-model', name: 'provider-model-2', displayName: 'Main model', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${env:DS_TEST_KEY}' }],
        }));

        expect(report.outcome).toBe('failed');
        expect(report.message).toContain('Everything was put back');
        expect(report.message).toContain('second-flow');
      } finally {
        spy.mockRestore();
      }
      expect(await snapshotOfInstance()).toEqual(before);
      const overview = await getDesiredStateOverview();
      expect(overview.status).toMatchObject({ appliedVersion: '1', lastApplyFailed: true, lastFailureCode: 'write-failed' });
      expect(overview.interruptedApplyWaiting).toBe(false);
    });
  });

  describe('rollback', () => {
    const version2 = () => baseFile('2', {
      settings: { telemetry: { enabled: true, notifyDaily: false }, update: { checkOnStartup: true } },
      models: [
        { id: 'main-model', name: 'provider-model-2', displayName: 'Main model', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${env:DS_TEST_KEY}' },
        { id: 'extra-model', name: 'provider-model-3', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' },
      ],
      flows: [
        { id: 'first-flow', spec: simpleSpec('first_flow', 'version two') },
        { id: 'third-flow', spec: simpleSpec('third_flow', 'only in two') },
      ],
      plannedExecutions: [],
    });

    it('returns the whole instance to the previous version with one call', async () => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();
      const settingBefore = (await settings())?.update;
      await apply(version2());
      expect(await flowService.getFlow('second-flow')).toBeNull();
      expect(await getSchedulerService().get('nightly')).toBeNull();

      const report = await rollback();

      expect(report.outcome).toBe('rolled-back');
      expect(report).toMatchObject({ version: '1', previousVersion: '2' });
      expect(await answerOf('first-flow')).toBe('first answer');
      expect(await answerOf('second-flow')).toBe('second answer');
      expect(await flowService.getFlow('third-flow')).toBeNull();
      expect(await modelService.getModel('extra-model')).toBeNull();
      expect((await modelService.getModel('main-model'))?.name).toBe('provider-model-1');
      expect((await getSchedulerService().get('nightly'))?.flowId).toBe('first-flow');
      expect((await settings())?.telemetry?.enabled).toBe(false);
      // Only version 2 managed this setting, so it returns to its value from before version 2.
      expect((await settings())?.update).toEqual(settingBefore);
      const after = await snapshotOfInstance() as { flows: unknown; executions: unknown[] };
      expect(after.flows).toEqual((before as { flows: unknown }).flows);
      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '1', heldBackVersion: '2', lastApplyFailed: false });
    });

    it('does not need the per-flow history, which is best effort', async () => {
      await apply(baseFile('1'));
      await apply(version2());
      // The worst case: all per-flow history is gone. Deleting a flow wipes it anyway.
      await fs.rm(path.join(db, 'flow-versions'), { recursive: true, force: true });

      expect((await rollback()).outcome).toBe('rolled-back');

      expect(await answerOf('first-flow')).toBe('first answer');
      expect(await answerOf('second-flow')).toBe('second answer');
    });

    it('survives more edits than the per-flow history keeps', async () => {
      await apply(baseFile('1'));
      for (let edit = 0; edit < 30; edit += 1) {
        await flowService.saveFlow({ ...(await flowService.getFlow('first-flow'))!, description: `edit ${edit}` });
      }
      await apply(version2());

      expect((await rollback()).outcome).toBe('rolled-back');

      expect(await answerOf('first-flow')).toBe('first answer');
      expect((await flowService.getFlow('first-flow'))?.description).not.toContain('edit');
    });

    it('can be previewed without changing anything', async () => {
      await apply(baseFile('1'));
      await apply(version2());
      const before = await snapshotOfInstance();

      const preview = await rollback(true);

      expect(preview.outcome).toBe('would-roll-back');
      expect(preview.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'flow', id: 'third-flow', action: 'delete' }),
        expect.objectContaining({ kind: 'flow', id: 'second-flow', action: 'recreate' }),
      ]));
      expect(await snapshotOfInstance()).toEqual(before);
      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('2');
    });

    it('goes further back on a second call and stops when there is nothing left', async () => {
      await apply(baseFile('1'));
      await apply(baseFile('2'));
      await apply(baseFile('3'));

      expect((await rollback()).version).toBe('2');
      expect((await rollback()).version).toBe('1');
      const last = await rollback();

      expect(last.outcome).toBe('invalid');
      expect(last.message).toContain('no earlier version');
      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('1');
    });

    it('keeps only the number of versions the file asks for', async () => {
      for (let version = 1; version <= 7; version += 1) await apply(baseFile(String(version)));

      const { versions } = await getDesiredStateOverview();
      expect(versions.map((entry) => entry.version)).toEqual(['3', '4', '5', '6', '7']);
      expect(await fs.readdir(path.join(db, 'desired-state-history'))).toHaveLength(5);

      await apply(baseFile('8', { policy: { keepVersions: 2 } }));
      expect((await getDesiredStateOverview()).versions.map((entry) => entry.version)).toEqual(['7', '8']);
      expect(await fs.readdir(path.join(db, 'desired-state-history'))).toHaveLength(2);
    });

    it('does not bring a rolled-back file back at the next start', async () => {
      const file = path.join(dataDir, 'desired.json');
      process.env.FLUJO_DESIRED_STATE_FILE = file;
      await fs.writeFile(file, JSON.stringify(baseFile('1')));
      await applyDesiredStateAtStartup();
      await fs.writeFile(file, JSON.stringify(version2()));
      await applyDesiredStateAtStartup();
      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('2');
      await rollback();

      restart();
      await applyDesiredStateAtStartup();

      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '1', heldBackVersion: '2' });
      expect(await answerOf('first-flow')).toBe('first answer');

      // A changed file is a new decision and is applied again.
      await fs.writeFile(file, JSON.stringify(baseFile('3')));
      await applyDesiredStateAtStartup();
      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '3', heldBackVersion: null });
    });

    it('applies a rolled-back file again when someone asks for it directly', async () => {
      await apply(baseFile('1'));
      await apply(version2());
      await rollback();

      expect((await apply(version2())).outcome).toBe('applied');

      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '2', heldBackVersion: null });
      expect(await answerOf('first-flow')).toBe('version two');
    });
  });

  describe('a crash in the middle', () => {
    const points = [
      'journal', 'secrets', 'models', 'settings', 'servers', 'flow:first-flow', 'planned-executions', 'removals',
      'before-state', 'after-state', 'before-journal-clear',
    ];
    const version2 = () => baseFile('2', {
      settings: { telemetry: { enabled: true, notifyDaily: false } },
      flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'version two') }],
      models: [{ id: 'main-model', name: 'provider-model-2', displayName: 'Main model', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '${env:DS_TEST_KEY}' }],
    });
    const crashAt = (point: string) => _setCrashPointForTests((reached) => {
      if (reached === point) {
        _setCrashPointForTests(undefined);
        throw new SimulatedCrash(point);
      }
    });

    it.each(points)('finishes at the next start when the process dies at "%s"', async (point) => {
      // The same work without a crash, to compare the end result with.
      await apply(baseFile('1'));
      await apply(version2());
      const expected = await snapshotOfInstance();
      await rollback();

      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, JSON.stringify(version2()));
      process.env.FLUJO_DESIRED_STATE_FILE = file;
      crashAt(point);
      await expect(applyDesiredState({ ...version2() }, { reconcileRuntime: false })).rejects.toBeInstanceOf(SimulatedCrash);

      restart();
      await applyDesiredStateAtStartup();

      const after = await getDesiredStateOverview();
      expect(after.interruptedApplyWaiting).toBe(false);
      expect(after.status).toMatchObject({ appliedVersion: '2', lastApplyFailed: false, interruptedApply: 'finished-at-restart' });
      expect(await snapshotOfInstance()).toEqual(expected);
      // Nothing is left half done: applying once more finds nothing to do.
      expect((await apply(version2())).outcome).toBe('unchanged');
    });

    it('finishes a rollback the same way', async () => {
      await apply(baseFile('1'));
      await apply(version2());
      crashAt('flow:first-flow');
      await expect(rollbackDesiredState({ reconcileRuntime: false })).rejects.toBeInstanceOf(SimulatedCrash);
      expect((await getDesiredStateOverview()).interruptedApplyWaiting).toBe(true);

      restart();
      await applyDesiredStateAtStartup();

      expect((await getDesiredStateOverview()).status).toMatchObject({
        appliedVersion: '1', heldBackVersion: '2', interruptedApply: 'finished-at-restart',
      });
      expect(await answerOf('first-flow')).toBe('first answer');
    });

    it('finishes even when no file is configured any more', async () => {
      await apply(baseFile('1'));
      crashAt('settings');
      await expect(apply(version2())).rejects.toBeInstanceOf(SimulatedCrash);
      delete process.env.FLUJO_DESIRED_STATE_FILE;

      restart();
      await applyDesiredStateAtStartup();

      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '2', interruptedApply: 'finished-at-restart' });
    });

    it('puts everything back and reports it when finishing is impossible', async () => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();
      process.env.DS_TEST_KEY = OTHER_SECRET;
      crashAt('journal');
      await expect(apply(version2())).rejects.toBeInstanceOf(SimulatedCrash);
      // The new start has lost the environment variable the update needed.
      delete process.env.DS_TEST_KEY;

      restart();
      await applyDesiredStateAtStartup();

      const after = await getDesiredStateOverview();
      expect(after.interruptedApplyWaiting).toBe(false);
      expect(after.status).toMatchObject({
        appliedVersion: '1', lastApplyFailed: true, interruptedApply: 'restored-at-restart', lastFailureCode: 'write-failed',
      });
      expect(await snapshotOfInstance()).toEqual(before);
    });

    it('a dry run does not finish it, and says so', async () => {
      await apply(baseFile('1'));
      crashAt('settings');
      await expect(apply(version2())).rejects.toBeInstanceOf(SimulatedCrash);

      const report = await dryRun(version2());

      expect(report.outcome).toBe('failed');
      expect(report.message).toContain('interrupted');
      expect((await getDesiredStateOverview()).interruptedApplyWaiting).toBe(true);
    });
  });

  describe('objects edited on the instance', () => {
    const editFlow = async () => {
      const flow = (await flowService.getFlow('first-flow'))!;
      await flowService.saveFlow({ ...flow, description: 'changed by a person' });
    };

    it('by default the file wins, says so, and the edit stays in the flow history', async () => {
      await apply(baseFile('1'));
      await editFlow();

      const preview = await dryRun(baseFile('1'));
      expect(preview.changes).toEqual([expect.objectContaining({ kind: 'flow', id: 'first-flow', action: 'overwrite-local-edit' })]);
      const report = await apply(baseFile('1'));

      expect(report.outcome).toBe('applied');
      expect(report.changes[0].action).toBe('overwrite-local-edit');
      expect((await flowService.getFlow('first-flow'))?.description).not.toBe('changed by a person');
      const versions = await listFlowVersions('first-flow');
      expect(versions.length).toBeGreaterThanOrEqual(1);
      // It was the same file again, so this is still one version.
      expect((await getDesiredStateOverview()).versions).toHaveLength(1);
    });

    it('with "keep" the edit stays, is reported every time, and everything else still updates', async () => {
      const keep = { policy: { localEdits: 'keep' } };
      await apply(baseFile('1', keep));
      await editFlow();

      const same = await apply(baseFile('1', keep));
      expect(same.outcome).toBe('unchanged');
      expect(same.changes).toEqual([expect.objectContaining({ kind: 'flow', id: 'first-flow', action: 'keep-local-edit' })]);
      expect((await getDesiredStateOverview()).status.localEditsKept).toBe(1);

      const report = await apply(baseFile('2', { ...keep, flows: [
        { id: 'first-flow', spec: simpleSpec('first_flow', 'version two') },
        { id: 'second-flow', spec: simpleSpec('second_flow', 'second changed') },
      ] }));

      expect(report.outcome).toBe('applied');
      expect(report.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'first-flow', action: 'keep-local-edit' }),
        expect.objectContaining({ id: 'second-flow', action: 'update' }),
      ]));
      expect(await answerOf('first-flow')).toBe('first answer');
      expect((await flowService.getFlow('first-flow'))?.description).toBe('changed by a person');
      expect(await answerOf('second-flow')).toBe('second changed');
      const { status, managed } = await getDesiredStateOverview();
      expect(status.localEditsKept).toBe(1);
      expect(managed).toContainEqual({ kind: 'flow', id: 'first-flow', localEditKept: true });
    });

    it('notices a setting changed by hand', async () => {
      await apply(baseFile('1'));
      const stored = (await settings())!;
      await saveItem(StorageKey.SPEECH_SETTINGS, { ...stored, telemetry: { enabled: true, notifyDaily: false } });

      const preview = await dryRun(baseFile('1'));
      expect(preview.changes).toEqual([expect.objectContaining({
        kind: 'setting', id: 'telemetry.enabled', action: 'overwrite-local-edit', from: true, to: false,
      })]);
      await apply(baseFile('1'));
      expect((await settings())?.telemetry?.enabled).toBe(false);
    });

    it('brings back an object someone deleted', async () => {
      await apply(baseFile('1'));
      await flowService.deleteFlow('second-flow');

      const report = await apply(baseFile('1'));

      expect(report.changes).toEqual([expect.objectContaining({ id: 'second-flow', action: 'recreate' })]);
      expect(await answerOf('second-flow')).toBe('second answer');
    });

    it('does not read a later save of the servers as an edit', async () => {
      await apply(baseFile('1'));
      // Any ordinary server change rewrites all servers in FLUJO's own normalized form.
      await mcpService.updateServerConfig('another', { name: 'another', transport: 'stdio', command: 'node', disabled: true } as never);

      const report = await apply(baseFile('1'));

      expect(report.outcome).toBe('unchanged');
    });
  });

  describe('objects a person created', () => {
    const personFlow = () => compileFlowSpec(simpleSpec('made_by_a_person', 'mine') as never).flow!;

    it('are left alone by apply, version change and rollback', async () => {
      const flow = { ...personFlow(), id: 'person-flow' };
      await flowService.saveFlow(flow);
      await modelService.addModel({ id: 'person-model', name: 'n', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', ApiKey: '' } as never);
      await mcpService.updateServerConfig('person-server', { name: 'person-server', transport: 'stdio', command: 'node', disabled: true } as never);
      const before = [await flowService.getFlow('person-flow'), await modelService.getModel('person-model'), (await servers())['person-server']];

      await apply(baseFile('1'));
      await apply(baseFile('2', { flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'two') }], plannedExecutions: [] }));
      await rollback();

      const after = [await flowService.getFlow('person-flow'), await modelService.getModel('person-model'), (await servers())['person-server']];
      expect(after).toEqual(before);
      const { managed } = await getDesiredStateOverview();
      expect(managed.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(['person-flow']));
    });

    it('cause a refusal when the file wants the same identity', async () => {
      await flowService.saveFlow({ ...personFlow(), id: 'first-flow' });
      const before = await flowService.getFlow('first-flow');

      const report = await apply(baseFile('1'));

      expect(report.outcome).toBe('invalid');
      expect(report.problems[0].message).toContain('existingLocalObjects');
      expect(await flowService.getFlow('first-flow')).toEqual(before);
      expect(await modelService.loadModels()).toEqual([]);
    });

    it('cause a refusal when the file wants the same flow name', async () => {
      await flowService.saveFlow({ ...personFlow(), id: 'person-flow', name: 'first_flow' });

      const report = await apply(baseFile('1'));

      expect(report.outcome).toBe('invalid');
      expect(report.problems[0].message).toContain('already used by another flow');
    });

    it('can be taken over on request, and go back on a rollback', async () => {
      const original = { ...personFlow(), id: 'first-flow' };
      await flowService.saveFlow(original);
      await apply(baseFile('1', { flows: [{ id: 'second-flow', spec: simpleSpec('second_flow', 'second') }], plannedExecutions: [] }));

      const report = await apply(baseFile('2', {
        policy: { existingLocalObjects: 'adopt' },
        flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'taken over') }, { id: 'second-flow', spec: simpleSpec('second_flow', 'second') }],
        plannedExecutions: [],
      }));

      expect(report.changes).toEqual([expect.objectContaining({ id: 'first-flow', action: 'adopt' })]);
      expect(await answerOf('first-flow')).toBe('taken over');

      expect((await rollback()).outcome).toBe('rolled-back');

      expect(await answerOf('first-flow')).toBe('mine');
      expect((await getDesiredStateOverview()).managed.map((entry) => entry.id)).not.toContain('first-flow');
    });

    it('keep what they use, even when the file stops mentioning it', async () => {
      await apply(baseFile('1'));
      const person = compileFlowSpec({
        name: 'uses_a_model',
        nodes: [{ key: 's', type: 'start' }, { key: 'p', type: 'process', model: 'main-model', prompt: 'x' }, { key: 'e', type: 'finish' }],
        edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'e' }],
      } as never, { models: [{ id: 'main-model', name: 'provider-model-1' }] }).flow!;
      await flowService.saveFlow({ ...person, id: 'person-flow' });

      const report = await apply(baseFile('2', { models: [] }));

      expect(report.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'model', id: 'main-model', action: 'unmanage', reason: expect.stringContaining('uses it') }),
      ]));
      expect(await modelService.getModel('main-model')).not.toBeNull();
      expect((await getDesiredStateOverview()).managed.map((entry) => entry.id)).not.toContain('main-model');
    });
  });

  describe('objects removed from the file', () => {
    it('are deleted by default', async () => {
      await apply(baseFile('1'));

      const report = await apply(baseFile('2', { flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'first answer') }] }));

      expect(report.changes).toEqual([expect.objectContaining({ kind: 'flow', id: 'second-flow', action: 'delete' })]);
      expect(await flowService.getFlow('second-flow')).toBeNull();
    });

    it('stay and stop being managed with "keep"', async () => {
      await apply(baseFile('1'));

      await apply(baseFile('2', {
        policy: { removedObjects: 'keep' },
        flows: [{ id: 'first-flow', spec: simpleSpec('first_flow', 'first answer') }],
      }));

      expect(await flowService.getFlow('second-flow')).not.toBeNull();
      expect((await getDesiredStateOverview()).managed.map((entry) => entry.id)).not.toContain('second-flow');
    });

    it('keep their settings at the current value', async () => {
      await apply(baseFile('1'));

      const report = await apply(baseFile('2', { settings: { telemetry: { enabled: false } } }));

      expect(report.changes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'modelAccess.quickChat', action: 'unmanage' })]));
      expect((await settings())?.modelAccess?.quickChat).toBe(false);
    });
  });

  describe('secrets', () => {
    it('never reach a report, a record or a log, and sit encrypted in the store', async () => {
      const lines: string[] = [];
      const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => (
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); })
      ));
      try {
        const reports = [
          await dryRun(baseFile('1')),
          await apply(baseFile('1')),
          await apply(baseFile('1')),
          await apply(baseFile('2', { flows: [] , plannedExecutions: [] })),
          await rollback(true),
          await rollback(),
          await applyDesiredState(baseFile('3', { models: [{ id: 'x', name: 'n', provider: 'openai', apiKey: OTHER_SECRET }] }), { reconcileRuntime: false }),
        ];

        expect(JSON.stringify(reports)).not.toContain(SECRET);
        expect(JSON.stringify(reports)).not.toContain(OTHER_SECRET);
        expect(lines.join('\n')).not.toContain(SECRET);
        expect(lines.join('\n')).not.toContain(OTHER_SECRET);
        const onDisk = await everyFile();
        expect(onDisk).not.toContain(SECRET);
        expect(onDisk).not.toContain(OTHER_SECRET);
        expect(JSON.stringify(await getDesiredStateOverview())).not.toContain(SECRET);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
      const store = await loadItem<Record<string, { value: string; metadata: { isSecret: boolean } }>>(StorageKey.GLOBAL_ENV_VARS, {});
      expect(store.DS_TEST_KEY.value.startsWith('encrypted:')).toBe(true);
      expect(store.DS_TEST_KEY.metadata.isSecret).toBe(true);
    });

    it('are compared by value, so an unchanged one is not rewritten and a new one is', async () => {
      await apply(baseFile('1'));
      const store = () => loadItem<Record<string, { value: string }>>(StorageKey.GLOBAL_ENV_VARS, {});
      const stored = (await store()).DS_TEST_KEY.value;

      await apply(baseFile('1'));
      expect((await store()).DS_TEST_KEY.value).toBe(stored);

      process.env.DS_TEST_KEY = OTHER_SECRET;
      const report = await apply(baseFile('1'));

      expect(report.changes).toEqual([expect.objectContaining({ kind: 'secret', id: 'DS_TEST_KEY', action: 'update' })]);
      expect((await store()).DS_TEST_KEY.value).not.toBe(stored);
      expect(JSON.stringify(report)).not.toContain(OTHER_SECRET);
    });

    it('are refused as literal text only where it can be told apart, and a warning is possible', async () => {
      const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789abcd';
      const file = (policy: object) => baseFile('1', { policy, flows: [{ id: 'f', spec: simpleSpec('f', `Here: ${key}`) }], plannedExecutions: [] });

      const refused = await dryRun(file({}));
      expect(refused.outcome).toBe('invalid');
      expect(JSON.stringify(refused)).not.toContain(key);

      const warned = await dryRun(file({ secretScan: 'warn' }));
      expect(warned.outcome).toBe('would-change');
      expect(warned.warnings.join(' ')).toContain('looks like a secret');
      expect(JSON.stringify(warned)).not.toContain(key);
    });

    it('stay in the store when the file stops naming them', async () => {
      await apply(baseFile('1'));

      await apply(baseFile('2', {
        models: [{ id: 'main-model', name: 'provider-model-1', displayName: 'Main model', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }],
        mcpServers: [],
      }));

      const store = await loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
      expect(store.DS_TEST_KEY).toBeDefined();
    });
  });

  describe('locked storage', () => {
    it('is reported and never worked around', async () => {
      await apply(baseFile('1'));
      const spy = jest.spyOn(secure, 'isEncryptionLocked').mockResolvedValue(true);
      try {
        const before = await snapshotOfInstance();
        const reports = [await apply(baseFile('2')), await dryRun(baseFile('2')), await rollback()];

        for (const report of reports) {
          expect(report.outcome).toBe('locked');
          expect(report.message).toContain('Nothing was changed');
        }
        expect(await snapshotOfInstance()).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('at startup', () => {
    it('does nothing at all without a file', async () => {
      await applyDesiredStateAtStartup();

      await expect(fs.access(path.join(db, 'desired-state'))).rejects.toThrow();
    });

    it('reads the file named by the environment and applies it', async () => {
      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, JSON.stringify(baseFile('1')));
      process.env.FLUJO_DESIRED_STATE_FILE = file;

      await applyDesiredStateAtStartup();

      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('1');
      expect(await answerOf('first-flow')).toBe('first answer');
    });

    it.each([
      ['not JSON', '{ this is not json', 'unreadable-file'],
      ['a flat list', '[1,2,3]', 'invalid-file'],
      ['missing a version', '{"schemaVersion":1}', 'invalid-file'],
    ])('survives a file that is %s, and reports it', async (_label, content, code) => {
      await apply(baseFile('1'));
      const before = await snapshotOfInstance();
      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, content);
      process.env.FLUJO_DESIRED_STATE_FILE = file;

      await expect(applyDesiredStateAtStartup()).resolves.toBeUndefined();

      expect(await snapshotOfInstance()).toEqual(before);
      expect((await getDesiredStateOverview()).status).toMatchObject({ appliedVersion: '1', lastApplyFailed: true, lastFailureCode: code });
    });

    it('survives a file that is missing, and reports it', async () => {
      process.env.FLUJO_DESIRED_STATE_FILE = path.join(dataDir, 'nowhere.json');

      await expect(applyDesiredStateAtStartup()).resolves.toBeUndefined();

      expect((await getDesiredStateOverview()).status).toMatchObject({ lastApplyFailed: true, lastFailureCode: 'unreadable-file' });
    });

    it('accepts a file saved with a byte order mark', async () => {
      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, `﻿${JSON.stringify(baseFile('1'))}`);
      process.env.FLUJO_DESIRED_STATE_FILE = file;

      await applyDesiredStateAtStartup();

      expect((await getDesiredStateOverview()).status.appliedVersion).toBe('1');
    });

    it('applies only to the workspaces the file names, and can create them', async () => {
      const file = path.join(dataDir, 'desired.json');
      await fs.writeFile(file, JSON.stringify(baseFile('1', { workspaces: ['team-a', 'team-b'] })));
      process.env.FLUJO_DESIRED_STATE_FILE = file;

      await ensureDesiredStateWorkspaces();
      expect(await workspaceExists('team-a')).toBe(true);
      expect(await workspaceExists('team-b')).toBe(true);

      await applyDesiredStateAtStartup();
      await expect(fs.access(path.join(db, 'desired-state'))).rejects.toThrow();

      for (const workspace of ['team-a', 'team-b']) {
        await runWithWorkspace(workspace, async () => {
          await applyDesiredStateAtStartup();
          expect((await getDesiredStateOverview()).status.appliedVersion).toBe('1');
        });
      }
      await runWithWorkspace('team-b', async () => {
        expect(await flowService.getFlow('first-flow')).not.toBeNull();
      });
    });
  });

  describe('the compiler', () => {
    it('gives the same ids for the same spec and seed, and random ones without a seed', () => {
      const spec = simpleSpec('stable', 'x') as never;
      const a = compileFlowSpec(spec, {}, { stableIdSeed: 'one' }).flow!;
      const b = compileFlowSpec(spec, {}, { stableIdSeed: 'one' }).flow!;
      const other = compileFlowSpec(spec, {}, { stableIdSeed: 'two' }).flow!;
      const plain = compileFlowSpec(spec).flow!;
      const plainAgain = compileFlowSpec(spec).flow!;

      expect(a).toEqual(b);
      expect(other.id).not.toBe(a.id);
      expect(plain.id).not.toBe(plainAgain.id);
      expect(plain.nodes[0].id).not.toBe(plainAgain.nodes[0].id);
    });
  });
});

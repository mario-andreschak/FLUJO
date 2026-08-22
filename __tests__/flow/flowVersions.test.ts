/**
 * Flow version history: saveFlow archives the definition it overwrites
 * (skipping creates and no-op saves), capped per flow; revertFlow restores an
 * archived definition through saveFlow so the revert is itself reversible;
 * deleteFlow removes the flow's history directory.
 */
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import type { Flow } from '@/shared/types/flow';
import { getWorkspaceDataDir } from '@/utils/workspace';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { clearFlowCache: jest.fn() },
}));

// In-memory storage (same pattern as cacheInvalidation.test.ts) so neither the
// flow files nor the version records touch disk.
const collections: Record<string, Record<string, unknown>> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveCollectionItem: jest.fn(async (c: string, id: string, val: unknown) => {
    (collections[c] ??= {})[id] = JSON.parse(JSON.stringify(val));
  }),
  loadCollectionItem: jest.fn(async (c: string, id: string, fallback: unknown) =>
    collections[c] && id in collections[c] ? JSON.parse(JSON.stringify(collections[c][id])) : fallback),
  deleteCollectionItem: jest.fn(async (c: string, id: string) => {
    if (collections[c]) delete collections[c][id];
  }),
  listCollectionItems: jest.fn(async (c: string) => Object.values(collections[c] ?? {})),
  listCollectionItemsWithStats: jest.fn(async (c: string) =>
    Object.values(collections[c] ?? {}).map((item) => ({ item, mtimeMs: 1 }))),
  assertSafeCollectionId: jest.fn((id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  }),
  migrateArrayFileToCollection: jest.fn(async () => 0),
}));

import { FlowService } from '@/backend/services/flow';
import { MAX_VERSIONS_PER_FLOW } from '@/backend/services/flow/flowVersions';

let testDataDir: string;
let priorDataDir: string | undefined;

beforeAll(async () => {
  priorDataDir = process.env.FLUJO_DATA_DIR;
  testDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-flowversions-test-'));
  process.env.FLUJO_DATA_DIR = testDataDir;
});

afterAll(async () => {
  if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = priorDataDir;
  await fsp.rm(testDataDir, { recursive: true, force: true });
});

const flowFixture = (id: string, name: string, label = 'Start Node'): Flow =>
  ({
    id,
    name,
    nodes: [{ id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label, type: 'start', properties: {} } }],
    edges: [],
  } as unknown as Flow);

beforeEach(() => {
  for (const k of Object.keys(collections)) delete collections[k];
  (global as unknown as { __flujo_flowsCache: unknown }).__flujo_flowsCache = null;
  (global as unknown as { __flujo_flowsMigration: unknown }).__flujo_flowsMigration = undefined;
});

describe('flow version history', () => {
  it('creating a new flow archives nothing', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('f1', 'one'));
    expect(await svc.listFlowVersions('f1')).toEqual([]);
  });

  it('overwriting a flow archives exactly the replaced definition', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('f1', 'one'));
    await svc.saveFlow(flowFixture('f1', 'one-renamed'));

    const versions = await svc.listFlowVersions('f1');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ name: 'one', nodeCount: 1, edgeCount: 0 });

    const record = await svc.getFlowVersion('f1', versions[0].versionId);
    expect(record?.flow.name).toBe('one');
  });

  it('a no-op save (identical definition) archives nothing', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('f1', 'one'));
    await svc.saveFlow(flowFixture('f1', 'one'));
    expect(await svc.listFlowVersions('f1')).toEqual([]);
  });

  it('canonicalizes a legacy-only save without creating alias-only history', async () => {
    const rules = [{ effect: 'deny', action: 'question', resource: '*' }];
    (collections.flows ??= {}).f1 = {
      ...flowFixture('f1', 'one'),
      permissionRules: rules,
    };
    const incoming = {
      ...flowFixture('f1', 'one'),
      behaviorRules: rules,
    } as Flow;

    const svc = new FlowService();
    expect((await svc.saveFlow(incoming)).success).toBe(true);

    expect(await svc.listFlowVersions('f1')).toEqual([]);
    expect(collections.flows.f1).toMatchObject({ behaviorRules: rules });
    expect(collections.flows.f1).not.toHaveProperty('permissionRules');
  });

  it('normalizes historical legacy version records on read', async () => {
    const rules = [{ effect: 'deny', action: 'question', resource: '*' }];
    (collections['flow-versions/f1'] ??= {}).legacy = {
      versionId: 'legacy',
      flowId: 'f1',
      savedAt: 1,
      flow: {
        ...flowFixture('f1', 'one'),
        permissionRules: rules,
      },
    };

    const record = await new FlowService().getFlowVersion('f1', 'legacy');
    expect(record?.flow.behaviorRules).toEqual(rules);
    expect(record?.flow).not.toHaveProperty('permissionRules');
  });

  it('backs up and idempotently migrates legacy Behavior-rule fields', async () => {
    const rules = [{ effect: 'deny', action: 'question', resource: '*' }];
    (collections.flows ??= {}).legacy = {
      ...flowFixture('legacy', 'legacy'),
      permissionRules: rules,
    };
    collections.flows.canonical = {
      ...flowFixture('canonical', 'canonical'),
      behaviorRules: rules,
    };
    collections.flows.conflict = {
      ...flowFixture('conflict', 'conflict'),
      behaviorRules: rules,
      permissionRules: [{ effect: 'allow', action: 'question', resource: '*' }],
    };

    const svc = new FlowService();
    await expect(svc.migrateBehaviorRulesField()).resolves.toEqual({
      migrated: 1,
      alreadyCanonical: 1,
      failed: 1,
      failedFlowIds: ['conflict'],
    });
    expect(collections.flows.legacy).toMatchObject({ behaviorRules: rules });
    expect(collections.flows.legacy).not.toHaveProperty('permissionRules');
    expect(collections['flow-behavior-rules-backups'].legacy).toMatchObject({
      flowId: 'legacy',
      flow: { permissionRules: rules },
    });

    await expect(svc.migrateBehaviorRulesField()).resolves.toEqual({
      migrated: 0,
      alreadyCanonical: 2,
      failed: 1,
      failedFlowIds: ['conflict'],
    });
  });

  it('lists versions newest first', async () => {
    const svc = new FlowService();
    const t = jest.spyOn(Date, 'now');
    t.mockReturnValue(1000);
    await svc.saveFlow(flowFixture('f1', 'v1'));
    t.mockReturnValue(2000);
    await svc.saveFlow(flowFixture('f1', 'v2'));
    t.mockReturnValue(3000);
    await svc.saveFlow(flowFixture('f1', 'v3'));
    t.mockRestore();

    const versions = await svc.listFlowVersions('f1');
    expect(versions.map((v) => v.name)).toEqual(['v2', 'v1']);
    expect(versions[0].savedAt).toBeGreaterThan(versions[1].savedAt);
  });

  it('revertFlow restores the archived definition AND archives the reverted-away one', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('f1', 'original'));
    await svc.saveFlow(flowFixture('f1', 'edited'));

    const [archived] = await svc.listFlowVersions('f1');
    const result = await svc.revertFlow('f1', archived.versionId);
    expect(result.success).toBe(true);

    const current = await svc.getFlow('f1');
    expect(current?.name).toBe('original');

    // The 'edited' definition must now be in the history (revert is reversible).
    const names = (await svc.listFlowVersions('f1')).map((v) => v.name);
    expect(names).toContain('edited');
  });

  it('revertFlow errors on an unknown version without touching the flow', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('f1', 'original'));
    const result = await svc.revertFlow('f1', 'no-such-version');
    expect(result.success).toBe(false);
    expect((await svc.getFlow('f1'))?.name).toBe('original');
  });

  it(`caps the history at ${MAX_VERSIONS_PER_FLOW} versions per flow`, async () => {
    const svc = new FlowService();
    const t = jest.spyOn(Date, 'now');
    for (let i = 0; i <= MAX_VERSIONS_PER_FLOW + 2; i++) {
      t.mockReturnValue(1000 + i);
      await svc.saveFlow(flowFixture('f1', `v${i}`));
    }
    t.mockRestore();
    const versions = await svc.listFlowVersions('f1');
    expect(versions).toHaveLength(MAX_VERSIONS_PER_FLOW);
    // The newest superseded definitions survive, the oldest were pruned.
    expect(versions[0].name).toBe(`v${MAX_VERSIONS_PER_FLOW + 1}`);
  });

  it('deleteFlow removes the version-history directory', async () => {
    const svc = new FlowService();
    const dir = path.join(getWorkspaceDataDir(), 'db', 'flow-versions', 'f1');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'marker.json'), '{}');

    await svc.saveFlow(flowFixture('f1', 'one'));
    await svc.deleteFlow('f1');

    await expect(fsp.access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
